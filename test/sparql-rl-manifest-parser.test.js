#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createHarness } = require('./harness.js');
const {
  sparqlRlTestPrefix,
  parseManifestTests,
  sparqlRlManifestToEarl,
  rdfGraphsIsomorphic,
} = require('../src/sparqlRlManifest.js');

const { iri, blankNode, literal } = require('../src/term.js');

const { test, main } = createHarness('SPARQL-RL manifest parser');

const TEST_NS = 'http://www.w3.org/ns/sparql-rl-tests#';

test('discovers current W3C srlt prefix', () => {
  const manifestUrl = 'https://w3c.example/tests/sparql-rl/syntax/manifest.ttl';
  const text = `
PREFIX : <manifest#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX mf: <http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#>
PREFIX srlt: <${TEST_NS}>

:test_1 rdf:type srlt:RulesPositiveSyntaxTest ;
  mf:name "syntax-01.srl" ;
  mf:action <syntax-01.srl> ;
  .
`;
  assert.equal(sparqlRlTestPrefix(text), 'srlt');
  const tests = parseManifestTests(manifestUrl, text);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].type, 'RulesPositiveSyntaxTest');
  assert.equal(tests[0].actionUrl, 'https://w3c.example/tests/sparql-rl/syntax/syntax-01.srl');
  assert.equal(tests[0].testUrl, 'https://w3c.example/tests/sparql-rl/syntax/manifest#test_1');
});

test('test namespace prefix name is not hard-coded', () => {
  const manifestUrl = 'https://w3c.example/tests/sparql-rl/wellformed/manifest.ttl';
  const text = `
PREFIX : <manifest#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX mf: <http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#>
PREFIX rulesTests: <${TEST_NS}>

:test_1 rdf:type rulesTests:RulesNegativeWellFormednessTest ;
  mf:name "bad.srl" ;
  mf:action <bad.srl> ;
  .
`;
  const tests = parseManifestTests(manifestUrl, text);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].type, 'RulesNegativeWellFormednessTest');
});

test('discovers eval ruleset and data using current prefix', () => {
  const manifestUrl = 'https://w3c.example/tests/sparql-rl/eval/manifest.ttl';
  const text = `
PREFIX : <https://w3c.example/rdf-tests/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX mf: <http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#>
PREFIX srlt: <${TEST_NS}>

:eval-basic-01 rdf:type srlt:RulesEvalTest ;
  mf:name "eval-basic-01" ;
  mf:action [ srlt:ruleset <eval-basic-01.srl> ; srlt:data <data-01.ttl> ] ;
  mf:result <eval-basic-01-results.ttl> ;
  .
`;
  const tests = parseManifestTests(manifestUrl, text);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].rulesetUrl, 'https://w3c.example/tests/sparql-rl/eval/eval-basic-01.srl');
  assert.equal(tests[0].dataUrl, 'https://w3c.example/tests/sparql-rl/eval/data-01.ttl');
  assert.equal(tests[0].resultUrl, 'https://w3c.example/tests/sparql-rl/eval/eval-basic-01-results.ttl');
  assert.equal(tests[0].testUrl, 'https://w3c.example/rdf-tests/eval-basic-01');
});

test('zero-test EARL summary cannot claim passed', () => {
  const earl = sparqlRlManifestToEarl({
    source: 'https://example.test/manifest.ttl',
    counts: { total: 0, pass: 0, fail: 0, skip: 0 },
    results: [],
  }, { date: '2026-08-26T00:00:00.000Z' });
  assert.match(earl, /earl:outcome earl:untested/);
  assert.doesNotMatch(earl, /earl:outcome earl:passed/);
});


test('mf:entries controls discovery and commented tests stay disabled', () => {
  const manifestUrl = 'https://w3c.example/tests/sparql-rl/eval/manifest.ttl';
  const text = `
PREFIX : <manifest#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX mf: <http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#>
PREFIX srlt: <${TEST_NS}>

<> a mf:Manifest ; mf:entries ( :good ) .

:good rdf:type srlt:RulesEvalTest ;
  mf:name "good" ;
  mf:action [ srlt:ruleset <good.srl> ; srlt:data <good-data.ttl> ] ;
  mf:result <good-results.ttl>
  .

## :phantom rdf:type srlt:RulesEvalTest ;
##   mf:name "phantom" ;
##   mf:action [ srlt:ruleset <missing.srl> ; srlt:data <missing-data.ttl> ] ;
##   mf:result <missing-results.ttl> ;
##   .

:unlisted rdf:type srlt:RulesEvalTest ;
  mf:name "unlisted" ;
  mf:action [ srlt:ruleset <unlisted.srl> ; srlt:data <unlisted-data.ttl> ] ;
  mf:result <unlisted-results.ttl> ;
  .
`;
  const tests = parseManifestTests(manifestUrl, text);
  assert.deepEqual(tests.map((item) => item.name), ['good']);
});

test('RDF graph comparison ignores blank-node labels but preserves identity', () => {
  const p = iri('http://example/p');
  const q = iri('http://example/q');
  const expected = [
    { s: blankNode('expected-a'), p, o: literal('Rule') },
    { s: blankNode('expected-a'), p: q, o: blankNode('expected-b') },
  ];
  const actual = [
    { s: blankNode('generated-7'), p, o: literal('Rule') },
    { s: blankNode('generated-7'), p: q, o: blankNode('generated-9') },
  ];
  const nonIso = [
    { s: blankNode('generated-7'), p, o: literal('Rule') },
    { s: blankNode('generated-8'), p: q, o: blankNode('generated-9') },
  ];
  assert.equal(rdfGraphsIsomorphic(actual, expected), true);
  assert.equal(rdfGraphsIsomorphic(nonIso, expected), false);
});

main();
