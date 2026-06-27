#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness, colors: C, summaryLine } = require('./harness.js');
const {
  defaultW3cRdfManifestUrls,
  runW3cRdfManifests,
  formatW3cRdfProgressLine,
  writeRdfEarlReport,
} = require('../src/rdfManifest.js');
const { parseNQuads, parseN3 } = require('../src/rdfSyntax.js');
const { evaluateEntailmentTest, entails } = require('../src/rdfEntailment.js');

const { test, main } = createHarness('W3C RDF syntax harness');


function appendSummary(summary) {
  const file = process.env.EYELENG_TEST_SUMMARY_FILE;
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(summary)}\n`, 'utf8');
}

function isLikelyNetworkError(err) {
  const msg = String(err && (err.stack || err.message || err));
  return /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|network|timed out|Failed to fetch/i.test(msg);
}

test('grammar-hardened N-Triples/N-Quads parser handles RDF 1.2 edge cases', () => {
  assert.equal(parseNQuads('<http://ex/s> <http://ex/p> "hi"@en--ltr .', { format: 'ntriples' }).facts.length, 1);
  assert.equal(parseNQuads('_:s<http://ex/p>_:o.', { format: 'ntriples' }).facts.length, 1);
  assert.throws(() => parseNQuads('<http://ex/s> <http://ex/p> "hi"^^<http://www.w3.org/1999/02/22-rdf-syntax-ns#langString> .', { format: 'ntriples' }));
});

test('grammar-hardened Turtle/TriG parser handles RDF 1.2 annotations and graph syntax', () => {
  const ttl = `
    PREFIX : <http://example/>
    :s :p :o {| :source :a |} {| :source :b |} .
    << :s :p :o >> :q :r .
    :x :y <<( :s :p :o )>> .
  `;
  const trig = `
    PREFIX : <http://example/>
    :g { _:s:p"Alice" . }
    GRAPH :h { :s :p :o . }
  `;
  assert.ok(parseN3(ttl, { profile: 'turtle', base: 'http://example/base' }).facts.length >= 6);
  assert.ok(parseN3(trig, { profile: 'trig', base: 'http://example/base' }).facts.length >= 2);
});

test('W3C RDF progress lines color the whole successful description', () => {
  const line = formatW3cRdfProgressLine({
    status: 'pass',
    type: 'rdft:TestNTriplesPositiveSyntax',
    name: 'nt-syntax-file-0',
    durationMs: 1,
  }, 0, { colors: { g: '<g>', r: '<r>', y: '<y>', dim: '<d>', n: '</>' } });
  assert.ok(line.includes('<g>OK</> <g>rdft:TestNTriplesPositiveSyntax nt-syntax-file-0</>'));
});



test('RDF-MT/RDF 1.2 semantics entailment runner handles simple, RDF, RDFS, and datatype cases', () => {
  const iri = (value) => ({ kind: 'iri', value });
  const lit = (value, datatype = null, language = null) => ({ kind: 'literal', value: String(value), datatype, language });
  const tripleTerm = (s, p, o) => ({ kind: 'triple', s, p, o });
  const t = (s, p, o) => ({ s, p, o, graph: null });
  const ex = 'http://example/';
  const rdf = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  const rdfs = 'http://www.w3.org/2000/01/rdf-schema#';
  const xsd = 'http://www.w3.org/2001/XMLSchema#';

  assert.equal(entails([t(iri(ex + 's'), iri(ex + 'p'), iri(ex + 'o'))], [t({ kind: 'blank', value: 'b' }, iri(ex + 'p'), iri(ex + 'o'))], { regime: 'simple' }), true);
  assert.equal(evaluateEntailmentTest([
    t(iri(ex + 'p'), iri(rdfs + 'domain'), iri(ex + 'C')),
    t(iri(ex + 's'), iri(ex + 'p'), iri(ex + 'o')),
  ], [t(iri(ex + 's'), iri(rdf + 'type'), iri(ex + 'C'))], { positive: true, regime: 'RDFS' }).passed, true);
  assert.equal(evaluateEntailmentTest([
    t(iri(ex + 's'), iri(ex + 'p'), lit('abc', xsd + 'integer')),
  ], [], { positive: true, resultKind: 'false', regime: 'RDFS', recognizedDatatypes: [xsd + 'integer'] }).passed, true);

  // D-entailment value-space equality across compatible datatypes.
  assert.equal(entails([
    t(iri(ex + 's'), iri(ex + 'p'), lit('1', xsd + 'integer')),
  ], [
    t(iri(ex + 's'), iri(ex + 'p'), lit('1.0', xsd + 'decimal')),
  ], { regime: 'RDF', recognizedDatatypes: [xsd + 'integer', xsd + 'decimal'] }), true);

  // RDFS-D inconsistency from datatype range clashes and incompatible datatype subclasses.
  assert.equal(evaluateEntailmentTest([
    t(iri(ex + 'p'), iri(rdfs + 'range'), iri(xsd + 'integer')),
    t(iri(ex + 's'), iri(ex + 'p'), lit('abc', xsd + 'string')),
  ], [], { positive: true, resultKind: 'false', regime: 'RDFS', recognizedDatatypes: [xsd + 'integer', xsd + 'string'] }).passed, true);
  assert.equal(evaluateEntailmentTest([
    t(iri(xsd + 'integer'), iri(rdfs + 'subClassOf'), iri(xsd + 'string')),
  ], [], { positive: true, resultKind: 'false', regime: 'RDFS', recognizedDatatypes: [xsd + 'integer', xsd + 'string'] }).passed, true);

  // Literals denote instances of their datatypes, and RDF 1.2 triple terms denote propositions.
  assert.equal(entails([
    t(iri(ex + 's'), iri(ex + 'p'), lit('7', xsd + 'integer')),
  ], [
    t(lit('7', xsd + 'integer'), iri(rdf + 'type'), iri(xsd + 'integer')),
  ], { regime: 'RDF', recognizedDatatypes: [xsd + 'integer'] }), true);
  const tt = tripleTerm(iri(ex + 's'), iri(ex + 'p'), iri(ex + 'o'));
  assert.equal(entails([
    t(iri(ex + 'x'), iri(ex + 'mentions'), tt),
  ], [
    t(tt, iri(rdf + 'type'), iri(rdfs + 'Proposition')),
  ], { regime: 'simple' }), true);
  assert.equal(entails([
    t(iri(ex + 'r'), iri(rdf + 'reifies'), tt),
  ], [
    t(tt, iri(rdf + 'type'), iri(rdfs + 'Proposition')),
  ], { regime: 'RDFS' }), true);
  assert.equal(entails([
    t(iri(ex + 'r'), iri(rdf + 'reifies'), tt),
  ], [
    t(tt, iri(rdf + 'type'), iri(rdf + 'TripleTerm')),
  ], { regime: 'RDFS' }), true);
  assert.equal(entails([
    t(iri(ex + 'r'), iri(rdf + 'reifies'), tt),
  ], [
    t(iri(ex + 'r'), iri(rdf + 'type'), iri(rdfs + 'Proposition')),
  ], { regime: 'RDFS' }), true);
  assert.equal(entails([
    t(iri(ex + 'a'), iri(rdf + 'reifies'), iri(ex + 'b')),
  ], [
    t(iri(ex + 'b'), iri(rdf + 'type'), iri(rdfs + 'Proposition')),
  ], { regime: 'RDFS' }), true);
  assert.equal(entails([
    t(iri(ex + 'a1'), iri(ex + 'p1'), tt),
  ], [
    t(iri(ex + 'a1'), iri(ex + 'p1'), { kind: 'blank', value: 'pp' }),
    t({ kind: 'blank', value: 'pp' }, iri(rdf + 'type'), iri(rdfs + 'Proposition')),
  ], { regime: 'RDFS' }), true);

  // JSON objects are unordered, while arrays and positive/negative zero remain distinct.
  assert.equal(entails([
    t(iri(ex + 's'), iri(ex + 'p'), lit('{"b":2,"a":1}', rdf + 'JSON')),
  ], [
    t(iri(ex + 's'), iri(ex + 'p'), lit('{"a":1,"b":2}', rdf + 'JSON')),
  ], { regime: 'RDF', recognizedDatatypes: [rdf + 'JSON'] }), true);
  assert.equal(entails([
    t(iri(ex + 's'), iri(ex + 'p'), lit('0', rdf + 'JSON')),
  ], [
    t(iri(ex + 's'), iri(ex + 'p'), lit('-0', rdf + 'JSON')),
  ], { regime: 'RDF', recognizedDatatypes: [rdf + 'JSON'] }), false);

  // Floating point value equality uses the proper value space and distinguishes signed zero.
  assert.equal(entails([
    t(iri(ex + 's'), iri(ex + 'p'), lit('16777206.5', xsd + 'float')),
  ], [
    t(iri(ex + 's'), iri(ex + 'p'), lit('16777205.5', xsd + 'float')),
  ], { regime: 'RDF', recognizedDatatypes: [xsd + 'float'] }), true);
  assert.equal(entails([
    t(iri(ex + 's'), iri(ex + 'p'), lit('0', xsd + 'double')),
  ], [
    t(iri(ex + 's'), iri(ex + 'p'), lit('-0', xsd + 'double')),
  ], { regime: 'RDF', recognizedDatatypes: [xsd + 'double'] }), false);
});

test('official W3C RDF manifests run with streaming progress when reachable', async () => {
  if (process.env.EYELENG_SKIP_W3C_RDF === '1') {
    console.log(`${C.dim}skipped by EYELENG_SKIP_W3C_RDF=1${C.n}`);
    return;
  }
  let result;
  try {
    result = await runW3cRdfManifests(defaultW3cRdfManifestUrls, {
      onManifestStart(resource, index, total) {
        console.log(`${C.dim}manifest ${index + 1}/${total}: ${resource}${C.n}`);
      },
      onProgress(item, index) {
        console.log(formatW3cRdfProgressLine(item, index, { colors: C }));
      },
    });
  } catch (err) {
    if (isLikelyNetworkError(err) && process.env.EYELENG_W3C_REQUIRED === '0') {
      console.log(`${C.dim}W3C RDF manifests not reachable; EYELENG_W3C_REQUIRED=0 permits this skip.${C.n}`);
      return;
    }
    throw err;
  }
  assert.equal(result.counts.fail, 0, `${result.counts.fail} W3C RDF failure(s)`);
  assert.ok(result.counts.pass > 0, 'expected at least one W3C RDF parser test to pass');
  const reportPath = writeRdfEarlReport(result);
  console.log(`${C.dim}EARL report: ${path.relative(path.join(__dirname, '..'), reportPath)}${C.n}`);
  summaryLine('ok', result.counts.pass, result.counts.total, result.durationMs, {
    skipped: result.counts.skip,
    label: 'W3C RDF manifests',
  });
  appendSummary({
    section: 'W3C RDF manifests',
    passed: result.counts.pass,
    failed: result.counts.fail,
    skipped: result.counts.skip,
    total: result.counts.total,
    ms: result.durationMs,
  });
});

main();
