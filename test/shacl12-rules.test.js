#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { colors: C, info, msTag } = require('./harness.js');

const eyesharl = require('../src/index.js');
const { tripleKey } = require('../src/term.js');

const DEFAULT_MANIFEST = 'https://w3c.github.io/data-shapes/shacl12-test-suite/tests/rules/manifest-rules.ttl';
const rootManifestUrl = process.env.EYESHARL_SHACL12_RULES_MANIFEST || DEFAULT_MANIFEST;
const fetchTimeoutMs = Number(process.env.EYESHARL_SHACL12_FETCH_TIMEOUT_MS || 30000);
const textCache = new Map();

function appendSummary(summary) {
  const file = process.env.EYESHARL_TEST_SUMMARY_FILE;
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(summary)}\n`, 'utf8');
}

function stripHash(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href;
}

function resolveHref(baseUrl, href) {
  return new URL(href, baseUrl).href;
}

async function fetchText(url) {
  const normalized = stripHash(url);
  if (textCache.has(normalized)) return textCache.get(normalized);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const response = await fetch(normalized, { signal: controller.signal });
    if (!response.ok) throw new Error(`GET ${normalized} failed: ${response.status} ${response.statusText}`);
    const text = await response.text();
    textCache.set(normalized, text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
    return textCache.get(normalized);
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`GET ${normalized} timed out after ${fetchTimeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function parseIncludedManifests(rootUrl, text) {
  const includeMatch = /mf:include\s*\(([\s\S]*?)\)\s*\./m.exec(text);
  if (!includeMatch) throw new Error(`No mf:include list found in ${rootUrl}`);
  return [...includeMatch[1].matchAll(/<([^>]+)>/g)].map((match) => resolveHref(rootUrl, match[1]));
}

function sectionName(manifestUrl) {
  const pieces = new URL(manifestUrl).pathname.split('/').filter(Boolean);
  if (pieces.length < 2) return manifestUrl;
  return pieces[pieces.length - 2];
}

function manifestStatements(text) {
  const statements = [];
  const re = /([^\s;]+)\s+rdf:type\s+srt:([A-Za-z0-9]+)\s*;([\s\S]*?)\n\s*\./g;
  let match;
  while ((match = re.exec(text)) !== null) {
    statements.push({ id: match[1], type: match[2], body: match[3] });
  }
  return statements;
}

function parseManifestTests(manifestUrl, text) {
  const section = sectionName(manifestUrl);
  const tests = [];

  for (const statement of manifestStatements(text)) {
    const name = /mf:name\s+"((?:[^"\\]|\\.)*)"/m.exec(statement.body)?.[1] || statement.id;

    if (statement.type === 'RulesEvalTest') {
      const ruleset = /srt:ruleset\s+<([^>]+)>/m.exec(statement.body)?.[1];
      const data = /srt:data\s+<([^>]+)>/m.exec(statement.body)?.[1];
      const result = /mf:result\s+<([^>]+)>/m.exec(statement.body)?.[1];
      if (!ruleset || !data || !result) throw new Error(`Incomplete eval test ${statement.id} in ${manifestUrl}`);
      tests.push({
        section,
        id: statement.id,
        type: statement.type,
        name,
        manifestUrl,
        rulesetUrl: resolveHref(manifestUrl, ruleset),
        dataUrl: resolveHref(manifestUrl, data),
        resultUrl: resolveHref(manifestUrl, result),
      });
      continue;
    }

    const action = /mf:action\s+<([^>]+)>/m.exec(statement.body)?.[1];
    if (!action) throw new Error(`No mf:action found for ${statement.id} in ${manifestUrl}`);
    tests.push({
      section,
      id: statement.id,
      type: statement.type,
      name,
      manifestUrl,
      actionUrl: resolveHref(manifestUrl, action),
    });
  }

  return tests;
}

async function loadTests() {
  const rootText = await fetchText(rootManifestUrl);
  const manifestUrls = parseIncludedManifests(rootManifestUrl, rootText);
  const suites = await Promise.all(manifestUrls.map(async (manifestUrl) => ({
    manifestUrl,
    text: await fetchText(manifestUrl),
  })));
  return suites.flatMap(({ manifestUrl, text }) => parseManifestTests(manifestUrl, text));
}

function shouldPass(type) {
  return /Positive/.test(type) || type === 'RulesEvalTest';
}

async function runSyntaxOrWellformedTest(test) {
  const source = await fetchText(test.actionUrl);
  const options = { filename: test.actionUrl, baseIRI: test.actionUrl, shacl12Conformance: true };

  if (test.type.includes('Syntax')) {
    if (shouldPass(test.type)) eyesharl.parse(source, options);
    else assert.throws(() => eyesharl.parse(source, options), Error);
    return;
  }

  if (shouldPass(test.type)) eyesharl.compile(source, options);
  else assert.throws(() => eyesharl.compile(source, options), Error);
}

async function parseTurtleTriples(url) {
  const source = await fetchText(url);
  return eyesharl.parseRdfDocument(source, { filename: url, baseIRI: url }).triples;
}

function sortedTripleKeys(triples) {
  return triples.map(tripleKey).sort();
}

function setDiff(actual, expected) {
  const actualSet = new Set(actual);
  return expected.filter((item) => !actualSet.has(item));
}

async function runEvalTest(test) {
  const [rulesSource, dataTriples, expectedTriples] = await Promise.all([
    fetchText(test.rulesetUrl),
    parseTurtleTriples(test.dataUrl),
    parseTurtleTriples(test.resultUrl),
  ]);

  const compiled = eyesharl.compile(rulesSource, { filename: test.rulesetUrl, baseIRI: test.rulesetUrl, shacl12Conformance: true });
  const program = { ...compiled.program, data: [...compiled.program.data, ...dataTriples] };
  const result = eyesharl.evaluate(program, { analysis: compiled.analysis, shacl12Conformance: true });

  const externalInput = new Set(dataTriples.map(tripleKey));
  const actualTriples = result.closure.filter((triple) => !externalInput.has(tripleKey(triple)));
  const actual = sortedTripleKeys(actualTriples);
  const expected = sortedTripleKeys(expectedTriples);

  try {
    assert.deepEqual(actual, expected);
  } catch (err) {
    err.message += `\nMissing expected:\n${setDiff(actual, expected).join('\n')}\nUnexpected actual:\n${setDiff(expected, actual).join('\n')}`;
    throw err;
  }
}

async function runOne(test) {
  if (test.type === 'RulesEvalTest') return runEvalTest(test);
  return runSyntaxOrWellformedTest(test);
}

function okLine(idx, msg, ms) {
  console.log(`${C.dim}${idx}${C.n} ${C.g}OK${C.n} ${C.g}${msg}${C.n} ${msTag(ms)}`);
}

function failLine(idx, msg, ms) {
  console.error(`${C.dim}${idx}${C.n} ${C.r}FAIL${C.n} ${C.r}${msg}${C.n} ${msTag(ms)}`);
}

async function main() {
  const suiteStart = Date.now();
  info('W3C SHACL 1.2 Rules');
  console.log(`${C.dim}manifest: ${rootManifestUrl}${C.n}`);

  let tests;
  try {
    tests = await loadTests();
  } catch (err) {
    failLine('---', 'load W3C SHACL 1.2 Rules manifests', Date.now() - suiteStart);
    console.error(err.stack || err.message || String(err));
    appendSummary({ section: 'W3C SHACL 1.2 Rules', passed: 0, failed: 1, total: 1, ms: Date.now() - suiteStart });
    process.exitCode = 1;
    return;
  }

  const idxWidth = Math.max(3, String(Math.max(1, tests.length)).length);
  let passed = 0;
  let failed = 0;
  const bySection = new Map();

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    const idx = String(i + 1).padStart(idxWidth, '0');
    const start = Date.now();
    try {
      await runOne(test);
      okLine(idx, `${test.section}/${test.name}`, Date.now() - start);
      passed++;
      const section = bySection.get(test.section) || { passed: 0, failed: 0 };
      section.passed++;
      bySection.set(test.section, section);
    } catch (err) {
      failLine(idx, `${test.section}/${test.name}`, Date.now() - start);
      console.error(err.stack || err.message || String(err));
      failed++;
      const section = bySection.get(test.section) || { passed: 0, failed: 0 };
      section.failed++;
      bySection.set(test.section, section);
    }
  }

  const suiteMs = Date.now() - suiteStart;
  for (const [section, counts] of bySection) {
    const total = counts.passed + counts.failed;
    const status = counts.failed === 0 ? `${C.g}OK${C.n}` : `${C.r}FAIL${C.n}`;
    console.log(`${status} ${section}: ${counts.passed}/${total} tests passed`);
  }
  if (failed === 0) console.log(`${C.g}OK${C.n} ${passed}/${tests.length} tests passed ${msTag(suiteMs)}`);
  else console.error(`${C.r}FAIL${C.n} ${passed}/${tests.length} tests passed ${msTag(suiteMs)}`);
  console.log('');

  appendSummary({ section: 'W3C SHACL 1.2 Rules', passed, failed, total: tests.length, ms: suiteMs });
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
