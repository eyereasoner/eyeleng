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

// `?constructor`, `?toString` and friends are ordinary VARNAMEs ([123] and
// [126] of SPARQL 1.2 RL §7.6), but they are also `Object.prototype`
// property names, so a solution mapping held in a plain `{}` answered
// `binding[name]` with an inherited function instead of `undefined`. Every
// rule binding such a variable then silently failed to fire.
test('variables named after Object.prototype properties bind normally', () => {
  const names = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', '__proto__'];
  for (const name of names) {
    const source = `PREFIX : <http://example/>
DATA { :writer :canPerform :writeTask }
RULE { ?${name} :retains ?task } WHERE { ?${name} :canPerform ?task }`;
    const compiled = eyeleng.compile(source, { strictGrammar: true });
    const result = eyeleng.evaluate(compiled.program, { analysis: compiled.analysis });
    const retains = result.inferred.filter((triple) => triple.p.value === 'http://example/retains');
    assert.equal(retains.length, 1, `?${name} should bind and fire the rule`);
    assert.equal(retains[0].s.value, 'http://example/writer', `?${name} bound the wrong term`);
  }
});

// The same hazard reached queries, which seed their own solution mapping.
test('a query variable named after an Object.prototype property binds', () => {
  const source = `PREFIX : <http://example/>
DATA { :writer :canPerform :writeTask }`;
  for (const queryMode of ['forward', 'backward']) {
    const result = eyeleng.runQuery(source, '?constructor :canPerform ?task', { queryMode });
    assert.equal(result.query.bindings.length, 1, `${queryMode} query should bind ?constructor`);
    assert.equal(result.query.bindings[0].constructor.value, 'http://example/writer');
  }
});

// SPARQL 1.2 RL, Working Draft 01 October 2026, §4.1 and §4.3.
test('head triple-term templates containing variables are run-once rules', () => {
  for (const template of [
    '?s :quoted <<( ?s :p :o )>>',
    '?s :quoted <<( :s ?p :o )>>',
    '?s :quoted <<( :s :p ?o )>>',
    '?s :quoted <<( :s :p <<( :s :p ?o )>> )>>',
    '<<( ?s :p :o )>> :quoted :o',
  ]) {
    const compiled = eyeleng.compile(`PREFIX : <http://example/>
RULE { ${template} } WHERE { ?s ?p ?o }`, { throwOnDiagnostics: false });
    assert.equal(compiled.program.rules[0].runOnce, true, template);
    const rule = compiled.analysis.dependency.rules[0];
    assert.equal(rule.headHasVariableTripleTerm, true, template);
    assert.equal(rule.createsTerms, true, template);
    assert.equal(compiled.analysis.dependency.edges[0].label, 'closed', template);
    assert.equal(compiled.analysis.errors[0].code, 'unstratified-closed-dependency', template);
  }
});

test('constant triple terms and variables carrying existing terms remain general rules', () => {
  const compiled = eyeleng.compile(`PREFIX : <http://example/>
RULE { ?s :quoted <<( :s :p <<( :s :p :o )>> )>> } WHERE { ?s :input ?o }
RULE { ?s :copy ?term } WHERE { ?s :quoted ?term }`);
  assert(compiled.program.rules.every((rule) => !rule.runOnce));
  assert(compiled.analysis.dependency.rules.every((rule) => !rule.createsTerms));
  assert.equal(compiled.analysis.dependency.edges[0].label, 'open');
});

test('recursive triple-term construction is rejected before evaluation', () => {
  assert.throws(() => eyeleng.compile(`PREFIX : <http://example/>
DATA { :s :p :o }
RULE { :s :p <<( :s :p ?o )>> } WHERE { :s :p ?o }`), /Stratification condition/);
});

const tripleTermRules = `PREFIX : <http://example/>
DATA { :a :edge :b . :b :edge :c }
RULE { ?s :quoted <<( ?s :edge ?o )>> } WHERE { ?s :reach ?o }
RULE { ?s :seen ?o } WHERE { ?s :quoted <<( ?s :edge ?o )>> }
RULE { ?s :reach ?o } WHERE { ?s :edge ?o }
RULE { ?s :reach ?o } WHERE { ?s :reach ?m . ?m :edge ?o }`;

test('triple-term construction waits for recursive producers and feeds general consumers', async () => {
  const compiled = eyeleng.compile(tripleTermRules);
  const dependencies = compiled.analysis.dependency;
  assert(dependencies.edges.filter((edge) => edge.from === 0).every((edge) => edge.closed));
  assert(dependencies.layerIndexes[0].includes(2));
  assert(dependencies.layerIndexes[0].includes(3));
  assert(dependencies.layerIndexes[1].includes(0));
  for (const result of [eyeleng.run(tripleTermRules), await eyeleng.runAsync(tripleTermRules)]) {
    const quoted = result.inferred.filter((triple) => triple.p.value === 'http://example/quoted');
    assert.equal(quoted.length, 3);
    assert(quoted.every((triple) => triple.o.type === 'triple'));
    assert.equal(result.perRule[0].applications, 3);
    const seen = result.inferred.filter((triple) => triple.p.value === 'http://example/seen');
    assert.equal(seen.length, 3);
    assert(seen.some((triple) => triple.s.value === 'http://example/a' && triple.o.value === 'http://example/c'));
  }
});

test('queries demanding constructed triple terms use forward evaluation', () => {
  const result = eyeleng.runQuery(tripleTermRules, '?s :quoted ?term', { queryMode: 'auto' });
  assert.equal(result.query.mode, 'forward');
  assert.equal(result.query.bindings.length, 3);
});

test('WHERE DATA triple-term construction ignores inferred producers', () => {
  const source = `PREFIX : <http://example/>
RULE { ?s :quoted <<( ?s :p ?o )>> } WHERE DATA { ?s :p ?o }
RULE { :inferred :p :o } WHERE {}`;
  const baseGraph = [t('http://example/base', 'http://example/p', iri('http://example/o'))];
  const compiled = eyeleng.compile(source, { baseGraph });
  assert.equal(compiled.program.rules[0].runOnce, true);
  assert.equal(compiled.analysis.dependency.edges.length, 0);
  const result = eyeleng.run(source, { baseGraph });
  const quoted = result.inferred.filter((triple) => triple.p.value === 'http://example/quoted');
  assert.equal(quoted.length, 1);
  assert.equal(quoted[0].s.value, 'http://example/base');
});

main();
