'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseNQuads, parseN3, termToNQuads, tripleToNQuads, triplesToNQuads } = require('./rdfSyntax.js');
const { evaluateEntailmentTest } = require('./rdfEntailment.js');

// ---- W3C RDF manifest runner ----

const defaultW3cRdfManifestUrls = Object.freeze([
  'https://w3c.github.io/rdf-tests/rdf/rdf11/rdf-n-triples/manifest.ttl',
  'https://w3c.github.io/rdf-tests/rdf/rdf12/rdf-n-triples/syntax/manifest.ttl',
  'https://w3c.github.io/rdf-tests/rdf/rdf11/rdf-n-quads/manifest.ttl',
  'https://w3c.github.io/rdf-tests/rdf/rdf12/rdf-n-quads/syntax/manifest.ttl',
  'https://w3c.github.io/rdf-tests/rdf/rdf11/rdf-mt/manifest.ttl',
  'https://w3c.github.io/rdf-tests/rdf/rdf12/rdf-semantics/manifest.ttl',
  'https://w3c.github.io/rdf-tests/rdf/rdf11/rdf-turtle/manifest.ttl',
  'https://w3c.github.io/rdf-tests/rdf/rdf12/rdf-turtle/eval/manifest.ttl',
  'https://w3c.github.io/rdf-tests/rdf/rdf12/rdf-turtle/syntax/manifest.ttl',
  'https://w3c.github.io/rdf-tests/rdf/rdf11/rdf-trig/manifest.ttl',
  'https://w3c.github.io/rdf-tests/rdf/rdf12/rdf-trig/eval/manifest.ttl',
  'https://w3c.github.io/rdf-tests/rdf/rdf12/rdf-trig/syntax/manifest.ttl',
]);

const SUPPORTED_SYNTAX_TYPES = new Set([
  'rdft:TestNTriplesPositiveSyntax',
  'rdft:TestNTriplesNegativeSyntax',
  'rdft:TestNQuadsPositiveSyntax',
  'rdft:TestNQuadsNegativeSyntax',
  'rdft:TestTurtlePositiveSyntax',
  'rdft:TestTurtleNegativeSyntax',
  'rdft:TestTrigPositiveSyntax',
  'rdft:TestTrigNegativeSyntax',
]);

const SUPPORTED_EVAL_TYPES = new Set([
  'rdft:TestNTriplesEval',
  'rdft:TestNQuadsEval',
  'rdft:TestTurtleEval',
  'rdft:TestTrigEval',
]);

const NEGATIVE_TYPES = new Set([
  'rdft:TestNTriplesNegativeSyntax',
  'rdft:TestNQuadsNegativeSyntax',
  'rdft:TestTurtleNegativeSyntax',
  'rdft:TestTrigNegativeSyntax',
  'rdft:TestTurtleNegativeEval',
  'rdft:TestTrigNegativeEval',
]);

const SEMANTICS_TYPES = new Set([
  'mf:PositiveEntailmentTest',
  'mf:NegativeEntailmentTest',
  'rdft:PositiveEntailmentTest',
  'rdft:NegativeEntailmentTest',
]);

function isUrl(value) {
  return /^https?:\/\//i.test(value || '');
}

function isDirectory(value) {
  try { return fs.statSync(value).isDirectory(); } catch { return false; }
}

function normalizeResource(resource) {
  if (isUrl(resource)) return resource;
  const resolved = path.resolve(resource);
  if (isDirectory(resolved)) return path.join(resolved, 'manifest.ttl');
  return resolved;
}

function resourceDirectory(resource) {
  if (isUrl(resource)) return new URL('.', resource).href;
  return path.dirname(path.resolve(resource));
}

function resolveResource(ref, baseResource) {
  if (!ref) return null;
  if (isUrl(ref)) return ref;
  if (ref.startsWith('file:')) return new URL(ref).pathname;
  if (isUrl(baseResource)) return new URL(ref, baseResource).href;
  return path.resolve(resourceDirectory(baseResource), ref);
}

async function readResource(resource) {
  if (isUrl(resource)) {
    if (typeof fetch !== 'function') throw new Error('Remote manifests require global fetch support (Node 18+)');
    const response = await fetch(resource);
    if (!response.ok) throw new Error(`Failed to fetch ${resource}: ${response.status} ${response.statusText}`);
    return await response.text();
  }
  return fs.readFileSync(resource, 'utf8');
}

function stripTurtleComments(text) {
  const out = [];
  let inString = false;
  let quote = null;
  let inIri = false;
  let escaped = false;
  for (let i = 0; i < String(text || '').length; i += 1) {
    const ch = text[i];
    if (escaped) { out.push(ch); escaped = false; continue; }
    if (ch === '\\') { out.push(ch); escaped = true; continue; }
    if (!inIri && (ch === '"' || ch === "'")) {
      if (!inString) { inString = true; quote = ch; }
      else if (quote === ch) { inString = false; quote = null; }
      out.push(ch);
      continue;
    }
    if (!inString && ch === '<') { inIri = true; out.push(ch); continue; }
    if (!inString && ch === '>') { inIri = false; out.push(ch); continue; }
    if (ch === '#' && !inString && !inIri) {
      while (i < text.length && text[i] !== '\n') i += 1;
      out.push('\n');
      continue;
    }
    out.push(ch);
  }
  return out.join('');
}

function splitStatements(text) {
  const clean = stripTurtleComments(text);
  const statements = [];
  let start = 0;
  let inString = false;
  let quote = null;
  let inIri = false;
  let escaped = false;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (!inIri && (ch === '"' || ch === "'")) {
      if (!inString) { inString = true; quote = ch; }
      else if (quote === ch) { inString = false; quote = null; }
      continue;
    }
    if (!inString && ch === '<') { inIri = true; continue; }
    if (!inString && ch === '>') { inIri = false; continue; }
    if (inString || inIri) continue;
    if (ch === '[') bracketDepth += 1;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === '(') parenDepth += 1;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === '.' && bracketDepth === 0 && parenDepth === 0) {
      const statement = clean.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  const tail = clean.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

function parseStringLiteral(value) {
  if (!value) return null;
  const token = value.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/)?.[0];
  if (!token) return null;
  if (token.startsWith('"')) return JSON.parse(token);
  return token.slice(1, -1).replace(/\\([nrtbf'"\\])/g, (_, ch) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', "'": "'", '"': '"', '\\': '\\' }[ch] ?? ch));
}

function extractFirstIriAfter(statement, predicate) {
  const escaped = predicate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = statement.match(new RegExp(`${escaped}\\s+<([^>]*)>`));
  return match?.[1] || null;
}

function extractResultAfter(statement) {
  const iri = extractFirstIriAfter(statement, 'mf:result');
  if (iri) return { kind: 'resource', resource: iri };
  if (/mf:result\s+false\b/.test(statement)) return { kind: 'false' };
  return null;
}

function extractTypes(statement) {
  const types = [];
  for (const match of statement.matchAll(/(?:rdf:type|\ba\b)\s+((?:rdft|mf):[A-Za-z][A-Za-z0-9_-]*)/g)) {
    types.push(match[1]);
  }
  return types;
}

function prefixMapFromManifest(text) {
  const prefixes = {
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
    mf: 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#',
    rdft: 'http://www.w3.org/ns/rdftest#',
  };
  for (const match of String(text || '').matchAll(/(?:@prefix|PREFIX)\s+([A-Za-z][A-Za-z0-9_-]*):\s*<([^>]*)>\s*\.?/g)) {
    prefixes[match[1]] = match[2];
  }
  return prefixes;
}

function expandManifestTerm(token, prefixes) {
  if (!token) return null;
  const trimmed = token.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed.slice(1, -1);
  const colon = trimmed.indexOf(':');
  if (colon > 0) {
    const prefix = trimmed.slice(0, colon);
    const local = trimmed.slice(colon + 1);
    if (Object.hasOwn(prefixes, prefix)) return prefixes[prefix] + local;
  }
  return null;
}

function extractIriListAfter(statement, predicate, prefixes) {
  const escaped = predicate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = statement.match(new RegExp(`${escaped}\\s+\\(([\\s\\S]*?)\\)`));
  if (!match) return [];
  const out = [];
  for (const token of match[1].match(/<[^>]*>|[A-Za-z][A-Za-z0-9_-]*:[^\s()]+/g) || []) {
    const iriValue = expandManifestTerm(token, prefixes);
    if (iriValue) out.push(iriValue);
  }
  return out;
}


function extractEntries(statements) {
  const entries = new Set();
  for (const statement of statements) {
    const match = statement.match(/\bmf:entries\s*\(([\s\S]*?)\)/);
    if (!match) continue;
    for (const token of match[1].match(/<[^>]*>|[A-Za-z][A-Za-z0-9_-]*:[^\s()]+/g) || []) {
      entries.add(token);
    }
  }
  return entries;
}

function extractEntailmentRegime(statement) {
  const literalValue = parseStringLiteral(statement.match(/mf:entailmentRegime\s+("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/)?.[1]);
  if (literalValue) return literalValue;
  const word = statement.match(/mf:entailmentRegime\s+([A-Za-z][A-Za-z0-9_-]*)/)?.[1];
  return word || 'simple';
}

function parseManifestText(text, resource) {
  const includes = [];
  const tests = [];
  const statements = splitStatements(text);
  const prefixes = prefixMapFromManifest(text);
  const manifestEntries = extractEntries(statements);

  for (const statement of statements) {
    const includeMatch = statement.match(/mf:include\s*\(([\s\S]*?)\)/);
    if (includeMatch) {
      for (const iriMatch of includeMatch[1].matchAll(/<([^>]*)>/g)) {
        let ref = iriMatch[1];
        if (!/\.ttl(?:#.*)?$/i.test(ref) && !ref.endsWith('/')) ref += '/';
        includes.push(resolveResource(ref.endsWith('/') ? `${ref}manifest.ttl` : ref, resource));
      }
    }

    const types = extractTypes(statement);
    const type = types.find((t) => SUPPORTED_SYNTAX_TYPES.has(t) || SUPPORTED_EVAL_TYPES.has(t) || SEMANTICS_TYPES.has(t) || NEGATIVE_TYPES.has(t));
    if (!type) continue;

    const id = statement.match(/^([^\s;]+)/)?.[1] || null;
    if (manifestEntries.size > 0 && id && !manifestEntries.has(id)) continue;
    const name = parseStringLiteral(statement.match(/mf:name\s+("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/)?.[1]) || id || type;
    const action = extractFirstIriAfter(statement, 'mf:action');
    const resultInfo = extractResultAfter(statement);
    tests.push({
      id,
      type,
      name,
      manifest: resource,
      action: action ? resolveResource(action, resource) : null,
      result: resultInfo?.kind === 'resource' ? resolveResource(resultInfo.resource, resource) : null,
      resultKind: resultInfo?.kind || null,
      entailmentRegime: SEMANTICS_TYPES.has(type) ? extractEntailmentRegime(statement) : null,
      recognizedDatatypes: SEMANTICS_TYPES.has(type) ? extractIriListAfter(statement, 'mf:recognizedDatatypes', prefixes) : [],
      unrecognizedDatatypes: SEMANTICS_TYPES.has(type) ? extractIriListAfter(statement, 'mf:unrecognizedDatatypes', prefixes) : [],
    });
  }

  return { resource, includes, tests };
}

async function loadW3cRdfManifest(resource, options = {}) {
  const root = normalizeResource(resource);
  const seen = new Set();
  const manifests = [];
  const tests = [];

  async function visit(current) {
    if (!current || seen.has(current)) return;
    seen.add(current);
    const text = await readResource(current);
    const manifest = parseManifestText(text, current);
    manifests.push({ resource: current, includeCount: manifest.includes.length, testCount: manifest.tests.length });
    tests.push(...manifest.tests);
    if (options.followIncludes !== false) {
      for (const include of manifest.includes) await visit(include);
    }
  }

  await visit(root);
  return { root, manifests, tests };
}

function parserForResource(resource, type) {
  const lower = String(resource || '').toLowerCase();
  if (type?.includes('NTriples') || lower.endsWith('.nt')) return 'ntriples';
  if (type?.includes('NQuads') || lower.endsWith('.nq')) return 'nquads';
  if (type?.includes('Trig') || lower.endsWith('.trig')) return 'trig';
  if (type?.includes('Turtle') || lower.endsWith('.ttl')) return 'turtle';
  return 'unknown';
}

function parseGraph(source, resource, type) {
  const parser = parserForResource(resource, type);
  if (parser === 'ntriples' || parser === 'nquads') return parseNQuads(source, { profileId: parser === 'ntriples' ? 'ntriples-graph-v0' : 'nquads-dataset-v0', format: parser });
  if (parser === 'turtle' || parser === 'trig') return parseN3(source, { profile: parser, filename: resource, base: isUrl(resource) ? resource : pathToFileURL(path.resolve(resource)).href });
  throw new Error(`No parser selected for ${resource || type}`);
}


function collectBlankTermsInTerm(term, out) {
  if (!term) return;
  if (term.kind === 'blank') out.add(term.value);
  else if (term.kind === 'triple') {
    collectBlankTermsInTerm(term.s, out);
    collectBlankTermsInTerm(term.p, out);
    collectBlankTermsInTerm(term.o, out);
  }
}

function collectBlankLabels(triples) {
  const out = new Set();
  for (const t of triples || []) {
    collectBlankTermsInTerm(t.s, out);
    collectBlankTermsInTerm(t.p, out);
    collectBlankTermsInTerm(t.o, out);
    collectBlankTermsInTerm(t.graph, out);
  }
  return Array.from(out).sort();
}

function termIsoString(term, mapping = new Map()) {
  if (!term) return '';
  if (term.kind === 'iri') return `<${term.value}>`;
  if (term.kind === 'blank') return `_:${mapping.get(term.value) || term.value}`;
  if (term.kind === 'literal') return `"${term.value}"^^${term.datatype || ''}@${term.language || ''}`;
  if (term.kind === 'triple') return `<<${termIsoString(term.s, mapping)} ${termIsoString(term.p, mapping)} ${termIsoString(term.o, mapping)}>>`;
  return JSON.stringify(term);
}

function tripleIsoString(t, mapping = new Map()) {
  return `${termIsoString(t.s, mapping)} ${termIsoString(t.p, mapping)} ${termIsoString(t.o, mapping)} ${termIsoString(t.graph, mapping)}`;
}

function* permutations(values) {
  if (values.length === 0) { yield []; return; }
  for (let i = 0; i < values.length; i += 1) {
    const first = values[i];
    const rest = values.slice(0, i).concat(values.slice(i + 1));
    for (const tail of permutations(rest)) yield [first, ...tail];
  }
}

function blankPositionSignature(label, triples) {
  const parts = [];
  function visit(term, path) {
    if (!term) return;
    if (term.kind === 'blank' && term.value === label) parts.push(path);
    else if (term.kind === 'triple') {
      visit(term.s, `${path}/ts`);
      visit(term.p, `${path}/tp`);
      visit(term.o, `${path}/to`);
    }
  }
  for (const t of triples || []) {
    visit(t.s, 's');
    visit(t.p, 'p');
    visit(t.o, 'o');
    visit(t.graph, 'g');
  }
  return parts.sort().join('|');
}

function termIsoStringPartial(term, mapping = new Map(), requireMapped = true) {
  if (!term) return '';
  if (term.kind === 'iri') return `<${term.value}>`;
  if (term.kind === 'blank') {
    const mapped = mapping.get(term.value);
    if (!mapped && requireMapped) return null;
    return `_:${mapped || term.value}`;
  }
  if (term.kind === 'literal') return `"${term.value}"^^${term.datatype || ''}@${term.language || ''}`;
  if (term.kind === 'triple') {
    const s = termIsoStringPartial(term.s, mapping, requireMapped);
    const p = termIsoStringPartial(term.p, mapping, requireMapped);
    const o = termIsoStringPartial(term.o, mapping, requireMapped);
    if (s == null || p == null || o == null) return null;
    return `<<${s} ${p} ${o}>>`;
  }
  return JSON.stringify(term);
}

function tripleIsoStringPartial(t, mapping = new Map(), requireMapped = true) {
  const s = termIsoStringPartial(t.s, mapping, requireMapped);
  const p = termIsoStringPartial(t.p, mapping, requireMapped);
  const o = termIsoStringPartial(t.o, mapping, requireMapped);
  const g = termIsoStringPartial(t.graph, mapping, requireMapped);
  if (s == null || p == null || o == null || g == null) return null;
  return `${s} ${p} ${o} ${g}`;
}

function uniqueTriplesForIso(triples) {
  // RDF graphs/datasets are sets.  Some eval inputs repeat an asserted triple while
  // adding distinct RDF 1.2 annotation blocks; keep only exact duplicate triples
  // before doing graph-isomorphism.  This preserves distinct blank-node structures
  // while avoiding false mismatches from duplicate asserted triples.
  const seen = new Set();
  const out = [];
  for (const t of triples || []) {
    const key = tripleIsoString(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function graphsIsomorphic(actualTriples0, expectedTriples0) {
  const actualTriples = uniqueTriplesForIso(actualTriples0);
  const expectedTriples = uniqueTriplesForIso(expectedTriples0);
  if ((actualTriples || []).length !== (expectedTriples || []).length) return false;
  const actualBlanks = collectBlankLabels(actualTriples);
  const expectedBlanks = collectBlankLabels(expectedTriples);
  if (actualBlanks.length !== expectedBlanks.length) return false;
  const expectedSet = new Set((expectedTriples || []).map((t) => tripleIsoString(t)));
  if (actualBlanks.length === 0) return (actualTriples || []).every((t) => expectedSet.has(tripleIsoString(t)));

  const expectedSig = new Map(expectedBlanks.map((label) => [label, blankPositionSignature(label, expectedTriples)]));
  const actualSig = new Map(actualBlanks.map((label) => [label, blankPositionSignature(label, actualTriples)]));
  const order = [...actualBlanks].sort((a, b) => {
    const ca = (actualTriples || []).filter((t) => tripleIsoString(t).includes(`_:${a}`)).length;
    const cb = (actualTriples || []).filter((t) => tripleIsoString(t).includes(`_:${b}`)).length;
    return cb - ca;
  });
  const candidates = new Map(order.map((a) => {
    // Do not over-constrain by local position signatures: RDF 1.2 annotation
    // tests often contain several structurally similar fresh reifiers whose
    // identities are intentionally arbitrary. Exhaustive search is fine for
    // the small W3C eval graphs used here.
    return [a, expectedBlanks];
  }));

  function partialConsistent(mapping) {
    for (const t of actualTriples || []) {
      const str = tripleIsoStringPartial(t, mapping, true);
      if (str && !expectedSet.has(str)) return false;
    }
    return true;
  }

  function search(index, mapping, used) {
    if (index >= order.length) return (actualTriples || []).every((t) => expectedSet.has(tripleIsoString(t, mapping)));
    const a = order[index];
    for (const b of candidates.get(a) || expectedBlanks) {
      if (used.has(b)) continue;
      mapping.set(a, b);
      used.add(b);
      // The W3C eval graphs are small. Avoid over-pruning: RDF 1.2 annotation tests
      // can contain several fresh reifiers with identical rdf:reifies edges but
      // distinct annotation payloads, and a premature partial check can reject
      // the mapping before the other fresh nodes are assigned.
      if (search(index + 1, mapping, used)) return true;
      used.delete(b);
      mapping.delete(a);
    }
    return false;
  }
  return search(0, new Map(), new Set());
}
function datasetSet(program) {
  return new Set(triplesToNQuads(program.facts || []).split('\n').filter(Boolean));
}

function setEquals(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function setDiff(a, b, limit = 5) {
  const out = [];
  for (const value of a) {
    if (!b.has(value)) out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

async function runSyntaxTest(test) {
  if (!test.action) return { status: 'fail', message: 'missing mf:action' };
  const expectAccept = !NEGATIVE_TYPES.has(test.type);
  try {
    const source = await readResource(test.action);
    parseGraph(source, test.action, test.type);
    return expectAccept
      ? { status: 'pass', message: 'accepted as expected' }
      : { status: 'fail', message: 'negative syntax test was accepted' };
  } catch (error) {
    return expectAccept
      ? { status: 'fail', message: `positive syntax/eval test was rejected: ${error.message}` }
      : { status: 'pass', message: `rejected as expected: ${error.message}` };
  }
}

async function runEvalTest(test) {
  if (!test.action || !test.result) return { status: 'fail', message: 'missing mf:action or mf:result' };
  try {
    const [actionText, resultText] = await Promise.all([readResource(test.action), readResource(test.result)]);
    const actualProgram = parseGraph(actionText, test.action, test.type);
    const expectedProgram = parseGraph(resultText, test.result, test.type);
    if (graphsIsomorphic(actualProgram.facts || [], expectedProgram.facts || [])) return { status: 'pass', message: 'parsed graph matches expected result graph' };
    const actual = datasetSet(actualProgram);
    const expected = datasetSet(expectedProgram);
    const missing = setDiff(expected, actual);
    const extra = setDiff(actual, expected);
    return { status: 'fail', message: `graph mismatch: missing ${missing.length ? missing.join(' | ') : 'none'}; extra ${extra.length ? extra.join(' | ') : 'none'}` };
  } catch (error) {
    return { status: 'fail', message: error.message };
  }
}

async function runEntailmentTest(test) {
  if (!test.action) return { status: 'fail', message: 'missing mf:action' };
  try {
    const actionText = await readResource(test.action);
    const actionProgram = parseGraph(actionText, test.action, test.type);
    let resultProgram = null;
    if (test.resultKind !== 'false') {
      if (!test.result) return { status: 'fail', message: 'missing mf:result' };
      const resultText = await readResource(test.result);
      resultProgram = parseGraph(resultText, test.result, test.type);
    }
    const positive = /PositiveEntailmentTest$/.test(test.type);
    const evaluated = evaluateEntailmentTest(actionProgram.facts || [], resultProgram ? resultProgram.facts || [] : [], {
      positive,
      resultKind: test.resultKind,
      regime: test.entailmentRegime || 'simple',
      recognizedDatatypes: test.recognizedDatatypes || [],
      unrecognizedDatatypes: test.unrecognizedDatatypes || [],
    });
    return evaluated.passed
      ? { status: 'pass', message: `${test.entailmentRegime || 'simple'} entailment: ${evaluated.message}` }
      : { status: 'fail', message: `${test.entailmentRegime || 'simple'} entailment failed: ${evaluated.message}` };
  } catch (error) {
    return { status: 'fail', message: error.message };
  }
}

async function runRdfTest(test) {
  const t0 = Date.now();
  let outcome;
  if (SEMANTICS_TYPES.has(test.type)) outcome = await runEntailmentTest(test);
  else if (SUPPORTED_EVAL_TYPES.has(test.type)) outcome = await runEvalTest(test);
  else if (SUPPORTED_SYNTAX_TYPES.has(test.type) || NEGATIVE_TYPES.has(test.type)) outcome = await runSyntaxTest(test);
  else outcome = { status: 'skip', message: `unsupported RDF test type ${test.type}` };
  return { ...test, ...outcome, durationMs: Date.now() - t0 };
}

async function runW3cRdfManifest(resource, options = {}) {
  const t0 = Date.now();
  const manifest = await loadW3cRdfManifest(resource, options);
  const results = [];
  for (let index = 0; index < manifest.tests.length; index += 1) {
    const item = await runRdfTest(manifest.tests[index]);
    results.push(item);
    if (typeof options.onProgress === 'function') options.onProgress(item, index, manifest.tests.length, manifest.root);
  }
  const counts = {
    total: results.length,
    pass: results.filter((r) => r.status === 'pass').length,
    fail: results.filter((r) => r.status === 'fail').length,
    skip: results.filter((r) => r.status === 'skip').length,
  };
  return { ok: counts.fail === 0 && counts.total > 0, source: manifest.root, manifests: manifest.manifests, counts, durationMs: Date.now() - t0, results };
}

async function runW3cRdfManifests(resources = defaultW3cRdfManifestUrls, options = {}) {
  const t0 = Date.now();
  const inputs = Array.isArray(resources) && resources.length ? resources : defaultW3cRdfManifestUrls;
  const manifests = [];
  for (const resource of inputs) {
    if (typeof options.onManifestStart === 'function') options.onManifestStart(resource, manifests.length, inputs.length);
    const result = await runW3cRdfManifest(resource, options);
    manifests.push(result);
    if (typeof options.onManifestDone === 'function') options.onManifestDone(result, manifests.length - 1, inputs.length);
  }
  const counts = manifests.reduce((acc, result) => {
    acc.total += result.counts.total;
    acc.pass += result.counts.pass;
    acc.fail += result.counts.fail;
    acc.skip += result.counts.skip;
    return acc;
  }, { total: 0, pass: 0, fail: 0, skip: 0 });
  return { ok: counts.fail === 0 && counts.total > 0, manifestCount: manifests.length, counts, durationMs: Date.now() - t0, manifests };
}

function nullColors() {
  return { g: '', r: '', y: '', dim: '', n: '' };
}

function colorizeStatus(status, colors = nullColors()) {
  if (status === 'pass') return `${colors.g}OK${colors.n}`;
  if (status === 'skip') return `${colors.y}SKIP${colors.n}`;
  return `${colors.r}FAIL${colors.n}`;
}

function formatMs(ms, colors = nullColors()) {
  return `${colors.dim}(${ms} ms)${colors.n}`;
}

function colorizeTextForStatus(status, text, colors = nullColors()) {
  if (status === 'pass') return `${colors.g}${text}${colors.n}`;
  if (status === 'skip') return `${colors.y}${text}${colors.n}`;
  return `${colors.r}${text}${colors.n}`;
}

function formatW3cRdfProgressLine(item, index, options = {}) {
  const C = options.colors || nullColors();
  const tag = colorizeStatus(item.status, C);
  const idx = `${C.dim}${String(index + 1).padStart(3, '0')}${C.n}`;
  const description = colorizeTextForStatus(item.status, `${item.type} ${item.name}`, C);
  let line = `${idx} ${tag} ${description} ${formatMs(item.durationMs, C)}`;
  if (item.status !== 'pass') line += `\n    ${colorizeTextForStatus(item.status, item.message, C)}`;
  return line;
}

function formatW3cRdfManifestSummaryLine(result, options = {}) {
  const C = options.colors || nullColors();
  const skipPart = result.counts.skip ? `, ${result.counts.skip} skipped` : '';
  const status = colorizeStatus(result.counts.fail === 0 ? 'pass' : 'fail', C);
  return `${status} ${result.counts.pass}/${result.counts.total} tests passed${skipPart} ${formatMs(result.durationMs, C)}`;
}

function formatW3cRdfManifestResult(result, options = {}) {
  const C = options.colors || nullColors();
  const lines = [];
  lines.push(`${C.y}==${C.n} W3C RDF manifest`);
  lines.push(`Source: ${result.source}`);
  lines.push(`Manifests: ${result.manifests.length}`);
  result.results.forEach((item, index) => lines.push(formatW3cRdfProgressLine(item, index, options)));
  lines.push(formatW3cRdfManifestSummaryLine(result, options));
  return lines.join('\n');
}

function formatW3cRdfManifestsResult(result, options = {}) {
  const C = options.colors || nullColors();
  const lines = [`${C.y}==${C.n} W3C RDF manifests`];
  for (const manifest of result.manifests) lines.push(formatW3cRdfManifestResult(manifest, options));
  const skipPart = result.counts.skip ? `, ${result.counts.skip} skipped` : '';
  const status = colorizeStatus(result.counts.fail === 0 ? 'pass' : 'fail', C);
  lines.push(`${C.y}==${C.n} Total`);
  lines.push(`${status} ${result.counts.pass}/${result.counts.total} tests passed${skipPart} across ${result.manifestCount} manifest(s) ${formatMs(result.durationMs, C)}`);
  return lines.join('\n');
}

function rdfManifestsToEarl(result, options = {}) {
  const assertedBy = options.assertedBy || '<https://github.com/eyereasoner/eyeleng>';
  const lines = [
    '@prefix earl: <http://www.w3.org/ns/earl#> .',
    '@prefix doap: <http://usefulinc.com/ns/doap#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    `${assertedBy} a earl:Software, doap:Project ;`,
    '  doap:name "Eyeleng" .',
    '',
  ];
  for (const manifest of result.manifests || []) {
    for (const item of manifest.results || []) {
      const outcome = item.status === 'pass' ? 'earl:passed' : item.status === 'skip' ? 'earl:untested' : 'earl:failed';
      const rawTestUri = item.action || item.id || `urn:eyeleng:w3c-rdf:${item.name}`;
      const testUri = isUrl(rawTestUri) || String(rawTestUri).startsWith('urn:') ? rawTestUri : pathToFileURL(rawTestUri).href;
      lines.push('[] a earl:Assertion ;');
      lines.push(`  earl:assertedBy ${assertedBy} ;`);
      lines.push(`  earl:subject ${assertedBy} ;`);
      lines.push(`  earl:test <${String(testUri).replace(/[<>]/g, '')}> ;`);
      lines.push('  earl:result [');
      lines.push('    a earl:TestResult ;');
      lines.push(`    earl:outcome ${outcome} ;`);
      lines.push(`    earl:info ${JSON.stringify(item.message || item.status)} ;`);
      lines.push('  ] .');
      lines.push('');
    }
  }
  return lines.join('\n');
}

function defaultRdfReportPath() {
  return path.join(__dirname, '..', 'reports', 'w3c-rdf-earl.ttl');
}

function writeRdfEarlReport(result, file = defaultRdfReportPath(), options = {}) {
  const earl = rdfManifestsToEarl(result, options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${earl}\n`, 'utf8');
  return file;
}

module.exports = {
  defaultW3cRdfManifestUrls,
  parseNQuads,
  termToNQuads,
  tripleToNQuads,
  triplesToNQuads,
  parseN3,
  loadW3cRdfManifest,
  runW3cRdfManifest,
  runW3cRdfManifests,
  formatW3cRdfProgressLine,
  formatW3cRdfManifestSummaryLine,
  formatW3cRdfManifestResult,
  formatW3cRdfManifestsResult,
  rdfManifestsToEarl,
  writeRdfEarlReport,
  defaultRdfReportPath,
};
