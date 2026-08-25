#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createHarness } = require('./harness.js');
const eyeleng = require('../src/index.js');
const { iri, literal, tripleKey } = require('../src/term.js');

const { test, main } = createHarness('SPARQL-RL W3C regressions');
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

function t(s, p, o) { return { s: iri(s), p: iri(p), o }; }

test('well-formedness checks can be isolated from stratification', () => {
  const source = `PREFIX : <http://example/>
RULE { ?s ?p ?o }
WHERE { ?s :p ?o . SET(?p := :p) }`;
  assert.doesNotThrow(() => eyeleng.compile(source, { strictGrammar: true, checkStratification: false }));
  assert.throws(() => eyeleng.compile(source, { strictGrammar: true }), /Stratification condition/);
});

test('labeled blank nodes in rule bodies act as scoped pattern variables', () => {
  const source = `PREFIX : <http://example/>
DATA { :x :p :x . :s :p :o . }
RULE { :x ?p "match" }
WHERE { _:b ?p _:b }`;
  const compiled = eyeleng.compile(source, { strictGrammar: true });
  const result = eyeleng.evaluate(compiled.program, { analysis: compiled.analysis });
  assert(result.inferred.some((triple) => triple.s.value === 'http://example/x' && triple.p.value === 'http://example/p' && triple.o.value === 'match'));
});

test('a labeled blank node can join multiple body triple patterns', () => {
  const source = `PREFIX : <http://example/>
DATA { :s1 :p1 :join . :join :p2 :o . :s2 :p1 :other . }
RULE { ?s :q ?o }
WHERE { ?s :p1 _:b . _:b :p2 ?o }`;
  const compiled = eyeleng.compile(source, { strictGrammar: true });
  const result = eyeleng.evaluate(compiled.program, { analysis: compiled.analysis });
  assert(result.inferred.some((triple) => triple.s.value === 'http://example/s1' && triple.p.value === 'http://example/q' && triple.o.value === 'http://example/o'));
});

test('WHERE DATA does not create rule dependencies and ignores inferred input', () => {
  const base = [
    t('http://example/x2', 'http://example/distanceMiles', literal(10, XSD_INTEGER)),
  ];
  const source = `PREFIX : <http://example/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
RULE { :x3 :distanceMiles 20 } WHERE {}
RULE { ?x :distanceKm ?kilometers }
WHERE DATA {
  ?x :distanceMiles ?miles
  NOT { ?x :distanceKm ?km }
  SET(?kilometers := xsd:integer(?miles * 1.60934))
}`;
  const compiled = eyeleng.compile(source, { strictGrammar: true, baseGraph: base });
  assert.equal(compiled.analysis.dependency.edges.length, 0);
  const result = eyeleng.evaluate(compiled.program, { analysis: compiled.analysis });
  assert(result.inferred.some((triple) => triple.s.value === 'http://example/x2' && triple.p.value === 'http://example/distanceKm' && triple.o.value === 16));
  assert(!result.inferred.some((triple) => triple.s.value === 'http://example/x3' && triple.p.value === 'http://example/distanceKm'));
});

test('NOT DATA does not create a rule dependency on an inferred predicate', () => {
  const base = [
    t('http://example/x1', 'http://example/distanceMiles', literal(1, XSD_INTEGER)),
    t('http://example/x1', 'http://example/distanceKm', literal(1.6, 'http://www.w3.org/2001/XMLSchema#decimal')),
    t('http://example/x2', 'http://example/distanceMiles', literal(10, XSD_INTEGER)),
  ];
  const source = `PREFIX : <http://example/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
RULE { ?x :distanceKm ?kilometers }
WHERE {
  ?x :distanceMiles ?miles
  NOT DATA { ?x :distanceKm ?km }
  SET(?kilometers := xsd:integer(?miles * 1.60934))
}`;
  const compiled = eyeleng.compile(source, { strictGrammar: true, baseGraph: base });
  assert.equal(compiled.analysis.dependency.edges.length, 0);
  const result = eyeleng.evaluate(compiled.program, { analysis: compiled.analysis });
  assert.deepEqual(result.inferred.map(tripleKey), [
    'I:http://example/x2 I:http://example/distanceKm L:16^^http://www.w3.org/2001/XMLSchema#integer@--',
  ]);
});

test('division by zero is an expression error in FILTER and SET', () => {
  const base = [
    t('http://example/x0', 'http://example/data', literal(0, XSD_INTEGER)),
    t('http://example/x2', 'http://example/data', literal(2, XSD_INTEGER)),
  ];
  const filterSource = `PREFIX : <http://example/>
RULE { ?x :out ?o } WHERE { ?x :data ?o . FILTER(1/?o) }`;
  const filterCompiled = eyeleng.compile(filterSource, { strictGrammar: true, baseGraph: base });
  const filterResult = eyeleng.evaluate(filterCompiled.program, { analysis: filterCompiled.analysis });
  assert.equal(filterResult.inferred.length, 1);
  assert.equal(filterResult.inferred[0].s.value, 'http://example/x2');

  const setSource = `PREFIX : <http://example/>
RULE { ?x :in ?o ; :out ?z } WHERE { ?x :data ?o . SET(?z := 1/?o) }`;
  const setCompiled = eyeleng.compile(setSource, { strictGrammar: true, baseGraph: base });
  const setResult = eyeleng.evaluate(setCompiled.program, { analysis: setCompiled.analysis });
  assert.equal(setResult.inferred.length, 2);
  assert(setResult.inferred.every((triple) => triple.s.value === 'http://example/x2'));
});

main();
