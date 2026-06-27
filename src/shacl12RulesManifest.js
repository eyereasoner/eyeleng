'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const eyeleng = require('./index.js');
const { tripleKey } = require('./term.js');

const DEFAULT_MANIFEST = 'https://w3c.github.io/data-shapes/shacl12-test-suite/tests/rules/manifest-rules.ttl';
const defaultShacl12RulesManifestUrl = DEFAULT_MANIFEST;
const textCache = new Map();

function fetchTimeoutMs(options = {}) {
  return Number(options.fetchTimeoutMs || process.env.EYELENG_SHACL12_FETCH_TIMEOUT_MS || 30000);
}

function isLikelyNetworkError(err) {
  const msg = String(err && (err.stack || err.message || err));
  return /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|network|timed out|GET .* failed/i.test(msg);
}

function isW3cRequired() {
  return process.env.EYELENG_W3C_REQUIRED !== '0';
}

function stripHash(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href;
}

function resolveHref(baseUrl, href) {
  return new URL(href, baseUrl).href;
}

async function fetchText(url, options = {}) {
  const normalized = stripHash(url);
  if (textCache.has(normalized)) return textCache.get(normalized);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs(options));
  try {
    const response = await fetch(normalized, { signal: controller.signal });
    if (!response.ok) throw new Error(`GET ${normalized} failed: ${response.status} ${response.statusText}`);
    const text = await response.text();
    textCache.set(normalized, text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
    return textCache.get(normalized);
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`GET ${normalized} timed out after ${fetchTimeoutMs(options)} ms`);
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
    const testUrl = resolveHref(manifestUrl, statement.id.replace(/^<([^>]*)>$/, '$1'));

    if (statement.type === 'RulesEvalTest') {
      const ruleset = /srt:ruleset\s+<([^>]+)>/m.exec(statement.body)?.[1];
      const data = /srt:data\s+<([^>]+)>/m.exec(statement.body)?.[1];
      const result = /mf:result\s+<([^>]+)>/m.exec(statement.body)?.[1];
      if (!ruleset || !data || !result) throw new Error(`Incomplete eval test ${statement.id} in ${manifestUrl}`);
      tests.push({
        section,
        id: statement.id,
        testUrl,
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
      testUrl,
      type: statement.type,
      name,
      manifestUrl,
      actionUrl: resolveHref(manifestUrl, action),
    });
  }

  return tests;
}

async function loadShacl12RulesTests(rootManifestUrl = defaultShacl12RulesManifestUrl, options = {}) {
  const rootText = await fetchText(rootManifestUrl, options);
  const manifestUrls = parseIncludedManifests(rootManifestUrl, rootText);
  const suites = await Promise.all(manifestUrls.map(async (manifestUrl) => ({
    manifestUrl,
    text: await fetchText(manifestUrl, options),
  })));
  return suites.flatMap(({ manifestUrl, text }) => parseManifestTests(manifestUrl, text));
}

function shouldPass(type) {
  return /Positive/.test(type) || type === 'RulesEvalTest';
}

async function runSyntaxOrWellformedTest(test, options = {}) {
  const source = await fetchText(test.actionUrl, options);
  const parseOptions = {
    filename: test.actionUrl,
    baseIRI: test.actionUrl,
    shacl12Conformance: true,
  };

  if (test.type.includes('Syntax')) {
    if (shouldPass(test.type)) eyeleng.parse(source, parseOptions);
    else assert.throws(() => eyeleng.parse(source, parseOptions), Error);
    return;
  }

  if (shouldPass(test.type)) eyeleng.compile(source, parseOptions);
  else assert.throws(() => eyeleng.compile(source, parseOptions), Error);
}

async function parseTurtleTriples(url, options = {}) {
  const source = await fetchText(url, options);
  return eyeleng.parseRdfDocument(source, { filename: url, baseIRI: url }).triples;
}

function sortedTripleKeys(triples) {
  return triples.map(tripleKey).sort();
}

function setDiff(actual, expected) {
  const actualSet = new Set(actual);
  return expected.filter((item) => !actualSet.has(item));
}

async function runEvalTest(test, options = {}) {
  const [rulesSource, dataTriples, expectedTriples] = await Promise.all([
    fetchText(test.rulesetUrl, options),
    parseTurtleTriples(test.dataUrl, options),
    parseTurtleTriples(test.resultUrl, options),
  ]);

  const compileOptions = {
    filename: test.rulesetUrl,
    baseIRI: test.rulesetUrl,
    shacl12Conformance: true,
  };
  const compiled = eyeleng.compile(rulesSource, compileOptions);
  const program = { ...compiled.program, data: [...compiled.program.data, ...dataTriples] };
  const result = eyeleng.evaluate(program, { analysis: compiled.analysis, shacl12Conformance: true });

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

async function runOneShacl12RulesTest(test, options = {}) {
  if (test.type === 'RulesEvalTest') return runEvalTest(test, options);
  return runSyntaxOrWellformedTest(test, options);
}

async function runShacl12RulesManifest(rootManifestUrl = defaultShacl12RulesManifestUrl, options = {}) {
  const suiteStart = Date.now();
  const tests = await loadShacl12RulesTests(rootManifestUrl, options);
  const results = [];
  const bySection = new Map();

  for (let index = 0; index < tests.length; index += 1) {
    const test = tests[index];
    const start = Date.now();
    let status = 'pass';
    let message = 'passed';
    try {
      await runOneShacl12RulesTest(test, options);
    } catch (err) {
      status = 'fail';
      message = err.stack || err.message || String(err);
    }
    const item = { ...test, status, message, durationMs: Date.now() - start };
    results.push(item);
    const section = bySection.get(test.section) || { passed: 0, failed: 0, total: 0 };
    section.total += 1;
    if (status === 'pass') section.passed += 1;
    else section.failed += 1;
    bySection.set(test.section, section);
    if (typeof options.onProgress === 'function') options.onProgress(item, index, tests.length);
  }

  const counts = {
    total: results.length,
    pass: results.filter((r) => r.status === 'pass').length,
    fail: results.filter((r) => r.status === 'fail').length,
    skip: results.filter((r) => r.status === 'skip').length,
  };
  return {
    ok: counts.fail === 0 && counts.total > 0,
    source: rootManifestUrl,
    counts,
    durationMs: Date.now() - suiteStart,
    bySection: Array.from(bySection, ([section, counts]) => ({ section, ...counts })),
    results,
  };
}

function nullColors() {
  return { g: '', r: '', y: '', dim: '', n: '' };
}

function colorizeStatus(status, colors = nullColors()) {
  if (status === 'pass') return `${colors.g}OK${colors.n}`;
  if (status === 'skip') return `${colors.y}SKIP${colors.n}`;
  return `${colors.r}FAIL${colors.n}`;
}

function colorizeTextForStatus(status, text, colors = nullColors()) {
  if (status === 'pass') return `${colors.g}${text}${colors.n}`;
  if (status === 'skip') return `${colors.y}${text}${colors.n}`;
  return `${colors.r}${text}${colors.n}`;
}

function formatMs(ms, colors = nullColors()) {
  return `${colors.dim}(${ms} ms)${colors.n}`;
}

function formatShacl12RulesProgressLine(item, index, options = {}) {
  const C = options.colors || nullColors();
  const tag = colorizeStatus(item.status, C);
  const idx = `${C.dim}${String(index + 1).padStart(3, '0')}${C.n}`;
  const description = colorizeTextForStatus(item.status, `${item.section}/${item.name}`, C);
  let line = `${idx} ${tag} ${description} ${formatMs(item.durationMs, C)}`;
  if (item.status !== 'pass') line += `\n    ${colorizeTextForStatus(item.status, item.message, C)}`;
  return line;
}

function formatShacl12RulesManifestResult(result, options = {}) {
  const C = options.colors || nullColors();
  const lines = [];
  lines.push(`${C.y}==${C.n} W3C SHACL 1.2 Rules`);
  lines.push(`manifest: ${result.source}`);
  (result.results || []).forEach((item, index) => lines.push(formatShacl12RulesProgressLine(item, index, options)));
  for (const section of result.bySection || []) {
    const status = colorizeStatus(section.failed === 0 ? 'pass' : 'fail', C);
    lines.push(`${status} ${section.passed}/${section.total} tests passed — ${section.section}`);
  }
  const status = colorizeStatus(result.counts.fail === 0 ? 'pass' : 'fail', C);
  lines.push(`${status} ${result.counts.pass}/${result.counts.total} tests passed ${formatMs(result.durationMs, C)}`);
  return lines.join('\n');
}

function turtleString(value, lang = null) {
  const escaped = JSON.stringify(String(value));
  return lang ? `${escaped}@${lang}` : escaped;
}

function safeIri(value) {
  return String(value || '').replace(/[<>]/g, '');
}

function typeIri(type) {
  return `srt:${type}`;
}

function shacl12RulesManifestToEarl(result, options = {}) {
  const assertedBy = options.assertedBy || '<https://github.com/eyereasoner/eyeleng>';
  const now = options.date || new Date().toISOString();
  const passed = result.counts?.pass || 0;
  const total = result.counts?.total || 0;
  const lines = [
    '# EARL 1.0 test result report for Eyeleng running the W3C SHACL 1.2 Rules test suite.',
    `# Generated from the manifest at ${result.source || defaultShacl12RulesManifestUrl} .`,
    '',
    '@prefix dct:  <http://purl.org/dc/terms/> .',
    '@prefix doap: <http://usefulinc.com/ns/doap#> .',
    '@prefix earl: <http://www.w3.org/ns/earl#> .',
    '@prefix foaf: <http://xmlns.com/foaf/0.1/> .',
    '@prefix srt:  <http://www.w3.org/ns/shacl-rules-test#> .',
    '@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .',
    '',
    '<#report>',
    '    a earl:TestResult ;',
    '    dct:title "Eyeleng W3C SHACL 1.2 Rules EARL report"@en ;',
    `    dct:description ${turtleString(`Generated Eyeleng EARL 1.0 report for the W3C SHACL 1.2 Rules test manifest. ${passed}/${total} tests passed.`, 'en')} ;`,
    `    dct:date ${turtleString(now)}^^xsd:dateTime ;`,
    `    earl:outcome ${result.counts?.fail === 0 ? 'earl:passed' : 'earl:failed'} .`,
    '',
    `${assertedBy}`,
    '    a earl:Software, doap:Project, foaf:Agent ;',
    '    dct:title "Eyeleng"@en ;',
    '    doap:name "eyeleng" ;',
    '    foaf:homepage <https://github.com/eyereasoner/eyeleng> .',
    '',
  ];

  for (const item of result.results || []) {
    const testUri = safeIri(item.testUrl || item.actionUrl || item.rulesetUrl || item.id || `urn:eyeleng:shacl12-rules:${item.name}`);
    const outcome = item.status === 'pass' ? 'earl:passed' : item.status === 'skip' ? 'earl:untested' : 'earl:failed';
    const title = `${item.section}/${item.name}`;
    lines.push(`<${testUri}>`);
    lines.push(`    a earl:TestCase, ${typeIri(item.type)} ;`);
    lines.push(`    dct:title ${turtleString(title, 'en')} ;`);
    lines.push(`    dct:isPartOf <${safeIri(result.source || defaultShacl12RulesManifestUrl)}> .`);
    lines.push('');
    lines.push('[] a earl:Assertion ;');
    lines.push(`    earl:assertedBy ${assertedBy} ;`);
    lines.push(`    earl:subject ${assertedBy} ;`);
    lines.push(`    earl:test <${testUri}> ;`);
    lines.push('    earl:mode earl:automatic ;');
    lines.push('    earl:result [');
    lines.push('        a earl:TestResult ;');
    lines.push(`        earl:outcome ${outcome} ;`);
    lines.push(`        earl:info ${turtleString(item.status === 'pass' ? 'passed' : item.message || item.status)} ;`);
    lines.push(`        dct:date ${turtleString(now)}^^xsd:dateTime`);
    lines.push('    ] .');
    lines.push('');
  }

  return lines.join('\n');
}

function defaultReportPath() {
  return path.join(__dirname, '..', 'reports', 'w3c-shacl12-rules-earl.ttl');
}

function writeShacl12RulesEarlReport(result, file = defaultReportPath(), options = {}) {
  const earl = shacl12RulesManifestToEarl(result, options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${earl}\n`, 'utf8');
  return file;
}

module.exports = {
  defaultShacl12RulesManifestUrl,
  isLikelyNetworkError,
  isW3cRequired,
  fetchText,
  parseIncludedManifests,
  parseManifestTests,
  loadShacl12RulesTests,
  runOneShacl12RulesTest,
  runShacl12RulesManifest,
  formatShacl12RulesProgressLine,
  formatShacl12RulesManifestResult,
  shacl12RulesManifestToEarl,
  writeShacl12RulesEarlReport,
  defaultReportPath,
};
