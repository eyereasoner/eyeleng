'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const eyeleng = require('./index.js');
const { tripleKey, termEquals } = require('./term.js');

const DEFAULT_MANIFEST = 'https://w3c.github.io/data-shapes/shacl12-test-suite/tests/sparql-rl/manifest-sparql-rl.ttl';
const defaultSparqlRlManifestUrl = DEFAULT_MANIFEST;
const textCache = new Map();
const SPARQL_RL_TEST_NS = 'http://www.w3.org/ns/sparql-rl-tests#';

function fetchTimeoutMs(options = {}) {
  return Number(options.fetchTimeoutMs || process.env.EYELENG_SPARQL_RL_FETCH_TIMEOUT_MS || 30000);
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
  text = stripTurtleComments(text);
  const includeMatch = /mf:include\s*\(([\s\S]*?)\)\s*\./m.exec(text);
  if (!includeMatch) throw new Error(`No mf:include list found in ${rootUrl}`);
  return [...includeMatch[1].matchAll(/<([^>]+)>/g)].map((match) => resolveHref(rootUrl, match[1]));
}

function sectionName(manifestUrl) {
  const pieces = new URL(manifestUrl).pathname.split('/').filter(Boolean);
  if (pieces.length < 2) return manifestUrl;
  return pieces[pieces.length - 2];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


function manifestPrefixes(text, manifestUrl) {
  text = stripTurtleComments(text);
  const prefixes = new Map();
  const re = /(?:@prefix|PREFIX)\s+([A-Za-z][A-Za-z0-9_-]*|):\s*<([^>]+)>\s*\.?/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    prefixes.set(match[1], resolveHref(manifestUrl, match[2]));
  }
  return prefixes;
}

function expandManifestTerm(term, manifestUrl, prefixes) {
  const iri = /^<([^>]*)>$/.exec(term);
  if (iri) return resolveHref(manifestUrl, iri[1]);
  const qname = /^([A-Za-z][A-Za-z0-9_-]*|):(.+)$/.exec(term);
  if (qname && prefixes.has(qname[1])) return `${prefixes.get(qname[1])}${qname[2]}`;
  return resolveHref(manifestUrl, term);
}

function sparqlRlTestPrefix(text) {
  text = stripTurtleComments(text);
  const ns = escapeRegExp(SPARQL_RL_TEST_NS);
  const match = new RegExp(`(?:@prefix|PREFIX)\\s+([A-Za-z][A-Za-z0-9_-]*):\\s*<${ns}>\\s*\\.?`, 'i').exec(text);
  if (!match) throw new Error(`No prefix declaration for ${SPARQL_RL_TEST_NS} found in SPARQL-RL manifest`);
  return match[1];
}

function stripTurtleComments(text) {
  let out = '';
  let quote = null;
  let longQuote = false;
  let inIri = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inIri) {
      out += ch;
      if (ch === '>') inIri = false;
      continue;
    }
    if (quote) {
      out += ch;
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (longQuote) {
        if (ch === quote && text[i + 1] === quote && text[i + 2] === quote) {
          out += quote + quote;
          i += 2;
          quote = null;
          longQuote = false;
        }
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '<') { inIri = true; out += ch; continue; }
    if (ch === '"' || ch === "'") {
      quote = ch;
      longQuote = text[i + 1] === ch && text[i + 2] === ch;
      out += ch;
      if (longQuote) { out += ch + ch; i += 2; }
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      if (i < text.length) out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

function splitTurtleStatements(text) {
  const statements = [];
  let start = 0;
  let quote = null;
  let longQuote = false;
  let inIri = false;
  let escaped = false;
  let square = 0;
  let paren = 0;
  let brace = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inIri) { if (ch === '>') inIri = false; continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (longQuote) {
        if (ch === quote && text[i + 1] === quote && text[i + 2] === quote) {
          i += 2; quote = null; longQuote = false;
        }
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '<') { inIri = true; continue; }
    if (ch === '"' || ch === "'") {
      quote = ch;
      longQuote = text[i + 1] === ch && text[i + 2] === ch;
      if (longQuote) i += 2;
      continue;
    }
    if (ch === '[') square += 1;
    else if (ch === ']') square = Math.max(0, square - 1);
    else if (ch === '(') paren += 1;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '{') brace += 1;
    else if (ch === '}') brace = Math.max(0, brace - 1);
    else if (ch === '.' && square === 0 && paren === 0 && brace === 0) {
      const next = text[i + 1];
      if (next && !/\s/.test(next)) continue;
      const statement = text.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

function manifestEntryTerms(text) {
  const cleaned = stripTurtleComments(text);
  const match = /mf:entries\s*\(/m.exec(cleaned);
  if (!match) return [];
  const open = cleaned.indexOf('(', match.index);
  let depth = 0;
  let quote = null;
  let inIri = false;
  let escaped = false;
  let close = -1;
  for (let i = open; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inIri) { if (ch === '>') inIri = false; continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '<') { inIri = true; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close < 0) throw new Error('Unterminated mf:entries list in SPARQL-RL manifest');
  const body = cleaned.slice(open + 1, close);
  return [...body.matchAll(/<[^>]*>|(?:(?:[A-Za-z][A-Za-z0-9_-]*):|:)[A-Za-z0-9_.-]+/g)].map((item) => item[0]);
}

function manifestStatements(text, prefix = sparqlRlTestPrefix(text)) {
  const cleaned = stripTurtleComments(text);
  const p = escapeRegExp(prefix);
  const re = new RegExp(`(?:^|\\n)\\s*([^\\s;]+)\\s+rdf:type\\s+${p}:([A-Za-z0-9]+)\\s*;([\\s\\S]*)$`);
  const byId = new Map();
  for (const raw of splitTurtleStatements(cleaned)) {
    const match = re.exec(raw);
    if (!match) continue;
    byId.set(match[1], { id: match[1], type: match[2], body: match[3] });
  }

  const entries = manifestEntryTerms(cleaned);
  if (entries.length === 0) return Array.from(byId.values());
  const missing = entries.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`Could not parse ${missing.length} mf:entries test statement(s): ${missing.slice(0, 5).join(', ')}`);
  return entries.map((id) => byId.get(id));
}
function parseManifestTests(manifestUrl, text) {
  const section = sectionName(manifestUrl);
  const tests = [];
  const prefixes = manifestPrefixes(text, manifestUrl);
  const prefix = sparqlRlTestPrefix(text);
  const p = escapeRegExp(prefix);

  for (const statement of manifestStatements(text, prefix)) {
    const name = /mf:name\s+"((?:[^"\\]|\\.)*)"/m.exec(statement.body)?.[1] || statement.id;
    const testUrl = expandManifestTerm(statement.id, manifestUrl, prefixes);

    if (statement.type === 'RulesEvalTest') {
      const ruleset = new RegExp(`${p}:ruleset\\s+<([^>]+)>`, 'm').exec(statement.body)?.[1];
      const data = new RegExp(`${p}:data\\s+<([^>]+)>`, 'm').exec(statement.body)?.[1];
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

async function loadSparqlRlTests(rootManifestUrl = defaultSparqlRlManifestUrl, options = {}) {
  const rootText = await fetchText(rootManifestUrl, options);
  const manifestUrls = parseIncludedManifests(rootManifestUrl, rootText);
  const suites = await Promise.all(manifestUrls.map(async (manifestUrl) => ({
    manifestUrl,
    text: await fetchText(manifestUrl, options),
  })));
  const tests = suites.flatMap(({ manifestUrl, text }) => parseManifestTests(manifestUrl, text));
  if (tests.length === 0) {
    throw new Error(`No SPARQL-RL tests discovered from ${rootManifestUrl}`);
  }
  return tests;
}

function shouldPass(type) {
  return /Positive/.test(type) || type === 'RulesEvalTest';
}

async function runSyntaxOrWellformedTest(test, options = {}) {
  const source = await fetchText(test.actionUrl, options);
  const parseOptions = {
    filename: test.actionUrl,
    baseIRI: test.actionUrl,
    strictGrammar: true,
    strict: true,
    hybrid: false,
  };

  if (test.type.includes('Syntax')) {
    if (shouldPass(test.type)) eyeleng.parse(source, parseOptions);
    else assert.throws(() => eyeleng.parse(source, parseOptions), Error);
    return;
  }

  const compileOptions = test.type.includes('WellFormedness')
    ? { ...parseOptions, checkStratification: false }
    : parseOptions;
  if (shouldPass(test.type)) eyeleng.compile(source, compileOptions);
  else assert.throws(() => eyeleng.compile(source, compileOptions), Error);
}

async function parseTurtleTriples(url, options = {}) {
  const source = await fetchText(url, options);
  return (await eyeleng.parseRdfDocument(source, { filename: url, baseIRI: url })).triples;
}

function sortedTripleKeys(triples) {
  return triples.map(tripleKey).sort();
}

function setDiff(actual, expected) {
  const actualSet = new Set(actual);
  return expected.filter((item) => !actualSet.has(item));
}


function unifyGraphTerm(expected, actual, mapping, reverse) {
  if (!expected || !actual) return null;
  if (expected.type === 'blank') {
    if (actual.type !== 'blank') return null;
    const mapped = mapping.get(expected.value);
    if (mapped !== undefined) return mapped === actual.value ? { mapping, reverse } : null;
    if (reverse.has(actual.value)) return null;
    const nextMapping = new Map(mapping);
    const nextReverse = new Map(reverse);
    nextMapping.set(expected.value, actual.value);
    nextReverse.set(actual.value, expected.value);
    return { mapping: nextMapping, reverse: nextReverse };
  }
  if (expected.type === 'triple') {
    if (actual.type !== 'triple') return null;
    let state = unifyGraphTerm(expected.s, actual.s, mapping, reverse);
    if (!state) return null;
    state = unifyGraphTerm(expected.p, actual.p, state.mapping, state.reverse);
    if (!state) return null;
    return unifyGraphTerm(expected.o, actual.o, state.mapping, state.reverse);
  }
  return termEquals(expected, actual) ? { mapping, reverse } : null;
}

function unifyGraphTriple(expected, actual, mapping, reverse) {
  let state = unifyGraphTerm(expected.s, actual.s, mapping, reverse);
  if (!state) return null;
  state = unifyGraphTerm(expected.p, actual.p, state.mapping, state.reverse);
  if (!state) return null;
  return unifyGraphTerm(expected.o, actual.o, state.mapping, state.reverse);
}

function blankOccurrences(term) {
  if (!term) return 0;
  if (term.type === 'blank') return 1;
  if (term.type === 'triple') return blankOccurrences(term.s) + blankOccurrences(term.p) + blankOccurrences(term.o);
  return 0;
}

function rdfGraphsIsomorphic(actual, expected) {
  if (actual.length !== expected.length) return false;
  const orderedExpected = expected.slice().sort((left, right) => {
    const leftBlanks = blankOccurrences(left.s) + blankOccurrences(left.p) + blankOccurrences(left.o);
    const rightBlanks = blankOccurrences(right.s) + blankOccurrences(right.p) + blankOccurrences(right.o);
    return leftBlanks - rightBlanks;
  });
  const used = new Array(actual.length).fill(false);

  function matchAt(index, mapping, reverse) {
    if (index === orderedExpected.length) return true;
    const expectedTriple = orderedExpected[index];
    for (let i = 0; i < actual.length; i += 1) {
      if (used[i]) continue;
      const state = unifyGraphTriple(expectedTriple, actual[i], mapping, reverse);
      if (!state) continue;
      used[i] = true;
      if (matchAt(index + 1, state.mapping, state.reverse)) return true;
      used[i] = false;
    }
    return false;
  }

  return matchAt(0, new Map(), new Map());
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
    strictGrammar: true,
    strict: true,
    hybrid: false,
  };
  const compiled = await eyeleng.compileAsync(rulesSource, { ...compileOptions, baseGraph: dataTriples });
  const result = await eyeleng.evaluateAsync(compiled.program, { analysis: compiled.analysis, hybrid: false });

  const actual = sortedTripleKeys(result.inferred);
  const expected = sortedTripleKeys(expectedTriples);

  try {
    assert.equal(rdfGraphsIsomorphic(result.inferred, expectedTriples), true);
  } catch (err) {
    err.message += `\nExpected graph (blank-node labels ignored):\n${expected.join('\n')}\nActual graph:\n${actual.join('\n')}\nMissing exact terms:\n${setDiff(actual, expected).join('\n')}\nUnexpected exact terms:\n${setDiff(expected, actual).join('\n')}`;
    throw err;
  }
}

async function runOneSparqlRlTest(test, options = {}) {
  if (test.type === 'RulesEvalTest') return runEvalTest(test, options);
  return runSyntaxOrWellformedTest(test, options);
}

async function runSparqlRlManifest(rootManifestUrl = defaultSparqlRlManifestUrl, options = {}) {
  const suiteStart = Date.now();
  const tests = await loadSparqlRlTests(rootManifestUrl, options);
  const results = [];
  const bySection = new Map();

  for (let index = 0; index < tests.length; index += 1) {
    const test = tests[index];
    const start = Date.now();
    let status = 'pass';
    let message = 'passed';
    try {
      await runOneSparqlRlTest(test, options);
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

function formatSparqlRlProgressLine(item, index, options = {}) {
  const C = options.colors || nullColors();
  const tag = colorizeStatus(item.status, C);
  const idx = `${C.dim}${String(index + 1).padStart(3, '0')}${C.n}`;
  const description = `${item.section}/${item.name}`;
  let line = `${idx} ${tag} ${description} ${formatMs(item.durationMs, C)}`;
  if (item.status !== 'pass') line += `\n    ${colorizeTextForStatus(item.status, item.message, C)}`;
  return line;
}

function formatSparqlRlManifestResult(result, options = {}) {
  const C = options.colors || nullColors();
  const lines = [];
  lines.push(`${C.y}==${C.n} W3C SPARQL 1.2 RL`);
  lines.push(`manifest: ${result.source}`);
  (result.results || []).forEach((item, index) => lines.push(formatSparqlRlProgressLine(item, index, options)));
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

function sparqlRlManifestToEarl(result, options = {}) {
  const assertedBy = options.assertedBy || '<https://github.com/eyereasoner/eyeleng>';
  const now = options.date || new Date().toISOString();
  const passed = result.counts?.pass || 0;
  const total = result.counts?.total || 0;
  const lines = [
    '# EARL 1.0 test result report for Eyeleng running the W3C SPARQL 1.2 RL test suite.',
    `# Generated from the manifest at ${result.source || defaultSparqlRlManifestUrl} .`,
    '',
    '@prefix dct:  <http://purl.org/dc/terms/> .',
    '@prefix doap: <http://usefulinc.com/ns/doap#> .',
    '@prefix earl: <http://www.w3.org/ns/earl#> .',
    '@prefix foaf: <http://xmlns.com/foaf/0.1/> .',
    '@prefix srt:  <http://www.w3.org/ns/sparql-rl-tests#> .',
    '@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .',
    '',
    '<#report>',
    '    a earl:TestResult ;',
    '    dct:title "Eyeleng W3C SPARQL 1.2 RL EARL report"@en ;',
    `    dct:description ${turtleString(`Generated Eyeleng EARL 1.0 report for the W3C SPARQL 1.2 RL test manifest. ${passed}/${total} tests passed.`, 'en')} ;`,
    `    dct:date ${turtleString(now)}^^xsd:dateTime ;`,
    `    earl:outcome ${total === 0 ? 'earl:untested' : result.counts?.fail === 0 ? 'earl:passed' : 'earl:failed'} .`,
    '',
    `${assertedBy}`,
    '    a earl:Software, doap:Project, foaf:Agent ;',
    '    dct:title "Eyeleng"@en ;',
    '    doap:name "eyeleng" ;',
    '    foaf:homepage <https://github.com/eyereasoner/eyeleng> .',
    '',
  ];

  for (const item of result.results || []) {
    const testUri = safeIri(item.testUrl || item.actionUrl || item.rulesetUrl || item.id || `urn:eyeleng:sparql-rl:${item.name}`);
    const outcome = item.status === 'pass' ? 'earl:passed' : item.status === 'skip' ? 'earl:untested' : 'earl:failed';
    const title = `${item.section}/${item.name}`;
    lines.push(`<${testUri}>`);
    lines.push(`    a earl:TestCase, ${typeIri(item.type)} ;`);
    lines.push(`    dct:title ${turtleString(title, 'en')} ;`);
    lines.push(`    dct:isPartOf <${safeIri(result.source || defaultSparqlRlManifestUrl)}> .`);
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
  return path.join(__dirname, '..', 'reports', 'w3c-sparql-rl-earl.ttl');
}

function writeSparqlRlEarlReport(result, file = defaultReportPath(), options = {}) {
  const earl = sparqlRlManifestToEarl(result, options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${earl}\n`, 'utf8');
  return file;
}

module.exports = {
  defaultSparqlRlManifestUrl,
  isLikelyNetworkError,
  isW3cRequired,
  fetchText,
  parseIncludedManifests,
  manifestPrefixes,
  expandManifestTerm,
  sparqlRlTestPrefix,
  stripTurtleComments,
  splitTurtleStatements,
  manifestEntryTerms,
  manifestStatements,
  parseManifestTests,
  rdfGraphsIsomorphic,
  loadSparqlRlTests,
  runOneSparqlRlTest,
  runSparqlRlManifest,
  formatSparqlRlProgressLine,
  formatSparqlRlManifestResult,
  sparqlRlManifestToEarl,
  writeSparqlRlEarlReport,
  defaultReportPath,
};
