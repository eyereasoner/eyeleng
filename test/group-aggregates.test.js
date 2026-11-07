#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createHarness } = require('./harness.js');
const eyeleng = require('../src/index.js');
const { tripleKey, XSD_INTEGER, XSD_DECIMAL, XSD_DOUBLE } = require('../src/term.js');

const { test, main } = createHarness('SPARQL-RL November 2026 grouping and Unicode');
const prefix = 'PREFIX : <http://example/>\n';
const options = { strictGrammar: true };
const run = (source, extra = {}) => eyeleng.run(prefix + source, { ...options, ...extra });
const compile = (source) => eyeleng.compile(prefix + source, options);
const outputs = (result) => result.inferred.filter((triple) => triple.p.value === 'http://example/out');

test('the draft vulnerability-count example groups by an incoming key', () => {
  const result = run(`DATA {
    :frontend a :Component ; :exposedTo :v1, :v2 .
    :db a :Component ; :exposedTo :v1 . :logger a :Component .
  }
  RULE { ?x :out ?n } WHERE {
    ?x a :Component . GROUP BY ?x { ?x :exposedTo ?v } [ ?n := COUNT(*) ]
  }`);
  assert.deepEqual(outputs(result).map((triple) => [triple.s.value, triple.o.value]).sort(), [
    ['http://example/db', 1], ['http://example/frontend', 2],
  ]);
});

test('group keys can be introduced inside the group and deduplicate key names', () => {
  const result = run(`DATA { :a :p 1, 2 . :b :p 3 . }
    RULE { ?s :out ?n } WHERE { GROUP BY ?s ?s { ?s :p ?v } [ ?n := COUNT(?v) ] }`);
  assert.deepEqual(outputs(result).map((triple) => [triple.s.value, triple.o.value]), [
    ['http://example/a', 2], ['http://example/b', 1],
  ]);
});

test('multiple keys group separately and remain available to later elements', () => {
  const result = run(`DATA { :a :p 1, 2 ; :tag :x, :y . }
    RULE { ?tag :out ?m } WHERE {
      GROUP BY ?s ?tag { ?s :p ?v ; :tag ?tag } [ ?n := COUNT(*) ]
      SET(?m := ?n + 1) FILTER(?s = :a)
    }`);
  assert.deepEqual(outputs(result).map((triple) => [triple.s.value, triple.o.value]), [
    ['http://example/x', 3], ['http://example/y', 3],
  ]);
});

test('only keys correlate: inner variables shadow incoming non-key bindings', () => {
  const result = run(`DATA { :outer :value 99 . :a :p 1, 2 . }
    RULE { ?s :out ?v ; :count ?n } WHERE {
      ?s :value ?v . GROUP { ?s :p ?v } [ ?n := COUNT(*) ]
    }`);
  assert.equal(outputs(result)[0].s.value, 'http://example/outer');
  assert.equal(outputs(result)[0].o.value, 99);
  assert.equal(result.inferred.find((triple) => triple.p.value === 'http://example/count').o.value, 2);
});

test('group FILTER and SET see keys and local bindings', () => {
  const result = run(`DATA { :a :p 1, 2, 3 . }
    RULE { :result :out ?sum } WHERE {
      GROUP { ?s :p ?v . FILTER(?v > 1) SET(?w := ?v * 2) } [ ?sum := SUM(?w) ]
    }`);
  assert.equal(outputs(result)[0].o.value, 10);
});

test('COUNT variants preserve multiplicity and distinguish values from mappings', () => {
  const result = run(`DATA { :a :p 1 ; :tag :x, :y . :b :p 1 ; :tag :x . }
    RULE { :result :all ?all ; :values ?values ; :distinct ?distinct ; :out ?rows } WHERE {
      GROUP { ?s :p ?v ; :tag ?tag }
        [ ?all := COUNT(*), ?values := COUNT(?v), ?distinct := COUNT(DISTINCT ?v), ?rows := COUNT(DISTINCT *) ]
    }`);
  const value = (name) => result.inferred.find((triple) => triple.p.value === `http://example/${name}`).o;
  assert.equal(value('all').value, 3);
  assert.equal(value('values').value, 3);
  assert.equal(value('distinct').value, 1);
  assert.equal(value('out').value, 3);
  assert.equal(value('all').datatype, XSD_INTEGER);
});

test('SUM, MIN and MAX include repeated values', () => {
  const result = run(`DATA { :a :p 2 . :b :p 2 . :c :p 7 . }
    RULE { :result :out ?sum ; :min ?min ; :max ?max } WHERE {
      GROUP { ?s :p ?v } [ ?sum := SUM(?v), ?min := MIN(?v), ?max := MAX(?v) ]
    }`);
  assert.equal(outputs(result)[0].o.value, 11);
  assert.equal(result.inferred.find((triple) => triple.p.value === 'http://example/min').o.value, 2);
  assert.equal(result.inferred.find((triple) => triple.p.value === 'http://example/max').o.value, 7);
});

test('numeric SUM promotes datatypes and preserves large integer precision', () => {
  for (const [values, expected, datatype] of [
    ['1, 2.0', 3, XSD_DECIMAL],
    ['1.0, 2e0', 3, XSD_DOUBLE],
    ['9007199254740993, 2', 9007199254740995n, XSD_INTEGER],
  ]) {
    const result = run(`DATA { :a :p ${values} }
      RULE { :result :out ?n } WHERE { GROUP { ?s :p ?v } [ ?n := SUM(?v) ] }`);
    assert.equal(outputs(result)[0].o.value, expected);
    assert.equal(outputs(result)[0].o.datatype, datatype);
  }
});

test('MIN and MAX retain the original RDF terms and order numeric values', () => {
  const result = run(`DATA { :a :p 10, 2.0 ; :label "z"@en, "a"@en . }
    RULE { :result :out ?min ; :max ?max ; :smallestLabel ?label } WHERE {
      GROUP { ?s :p ?v } [ ?min := MIN(?v), ?max := MAX(?v) ]
      GROUP { ?s :label ?v } [ ?label := MIN(?v) ]
    }`);
  assert.deepEqual(outputs(result)[0].o, { type: 'literal', value: 2, datatype: XSD_DECIMAL, lang: null, langDir: null });
  assert.equal(result.inferred.find((triple) => triple.p.value === 'http://example/max').o.value, 10);
  assert.equal(result.inferred.find((triple) => triple.p.value === 'http://example/smallestLabel').o.lang, 'en');
});

test('SUM accepts derived integers and float literals with numeric promotion', () => {
  const result = run(`DATA { :a :p "2"^^xsd:int, "3.5"^^xsd:float . }
    RULE { :result :out ?n } WHERE { GROUP { ?s :p ?v } [ ?n := SUM(?v) ] }`);
  assert.equal(outputs(result)[0].o.value, 5.5);
  assert.equal(outputs(result)[0].o.datatype, 'http://www.w3.org/2001/XMLSchema#float');
});

test('SUM promotes very large integers to floating point when required', () => {
  const result = run(`DATA { :a :p 9007199254740993, 1e40 . }
    RULE { :result :out ?n } WHERE { GROUP { ?s :p ?v } [ ?n := SUM(?v) ] }`);
  assert.equal(outputs(result)[0].o.value, Number(9007199254740993n) + 1e40);
  assert.equal(outputs(result)[0].o.datatype, XSD_DOUBLE);
  const minimum = run(`DATA { :a :p 9007199254740993, 9007199254740992e0 . }
    RULE { :result :out ?n } WHERE { GROUP { ?s :p ?v } [ ?n := MIN(?v) ] }`);
  assert.equal(outputs(minimum)[0].o.datatype, XSD_DOUBLE);
});

test('aggregate output names may coincide with Object.prototype properties', () => {
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const result = run(`DATA { :a :p 1, 2 . }
      RULE { :result :out ?${name} } WHERE { GROUP { ?s :p ?v } [ ?${name} := COUNT(*) ] }`);
    assert.equal(outputs(result)[0].o.value, 2);
  }
});

test('MIN and MAX follow the RDF term ordering, including triple terms', () => {
  const result = run(`DATA { :a :p _:b, :iri, "text", <<( :s :p :o )>> . }
    RULE { :result :out ?min ; :largest ?max } WHERE {
      GROUP { ?s :p ?v } [ ?min := MIN(?v), ?max := MAX(?v) ]
    }`);
  assert.equal(outputs(result)[0].o.type, 'blank');
  assert.equal(result.inferred.find((triple) => triple.p.value === 'http://example/largest').o.type, 'triple');
});

test('MIN compares strings and IRIs by Unicode code point', () => {
  for (const values of ['"\uE000", "😀"', '<http://example/\uE000>, <http://example/😀>']) {
    const result = run(`DATA { :a :p ${values} }
      RULE { :result :out ?min } WHERE { GROUP { ?s :p ?v } [ ?min := MIN(?v) ] }`);
    assert(outputs(result)[0].o.value.endsWith('\uE000'));
  }
});

test('no-BY groups on no matches return zero for COUNT and SUM', () => {
  const result = run(`RULE { :result :out ?n ; :sum ?sum ; :distinct ?d } WHERE {
    GROUP { ?s :absent ?v } [ ?n := COUNT(*), ?sum := SUM(?v), ?d := COUNT(DISTINCT *) ]
  }`);
  assert.equal(result.inferred.length, 3);
  assert(result.inferred.every((triple) => triple.o.value === 0 && triple.o.datatype === XSD_INTEGER));
});

test('an empty group pattern has the identity solution', () => {
  assert.equal(outputs(run(`RULE { :result :out ?n } WHERE { GROUP {} [ ?n := COUNT(*) ] }`))[0].o.value, 1);
});

test('empty keyed results produce no groups', () => {
  assert.equal(outputs(run(`RULE { ?s :out ?n } WHERE {
    GROUP BY ?s { ?s :absent ?v } [ ?n := COUNT(*) ]
  }`)).length, 0);
});

test('an empty aggregate list projects distinct keys', () => {
  const result = run(`DATA { :a :p 1, 2 . :b :p 3 . }
    RULE { ?s :out true } WHERE { GROUP BY ?s { ?s :p ?v } [] }`);
  assert.equal(outputs(result).length, 2);
  assert.equal(result.perRule[0].applications, 2);
});

test('an empty aggregate list without BY emits a solution on no matches', () => {
  assert.equal(outputs(run(`RULE { :result :out true } WHERE { GROUP { ?s :absent ?v } [] }`)).length, 1);
});

test('aggregate errors drop an entire group and keep other groups', () => {
  const result = run(`DATA { :a :p 1, "bad" . :b :p 2, 3 . }
    RULE { ?s :out ?n ; :sum ?sum } WHERE {
      GROUP BY ?s { ?s :p ?v } [ ?n := COUNT(*), ?sum := SUM(?v) ]
    }`);
  assert.deepEqual(outputs(result).map((triple) => [triple.s.value, triple.o.value]), [['http://example/b', 2]]);
});

test('MIN and MAX on an empty unkeyed group drop that group', () => {
  for (const name of ['MIN', 'MAX']) {
    assert.equal(outputs(run(`RULE { :result :out ?n } WHERE {
      GROUP { ?s :absent ?v } [ ?n := ${name}(?v) ]
    }`)).length, 0);
  }
});

test('group SET errors discard solutions before aggregating', () => {
  assert.equal(outputs(run(`DATA { :a :p 0, 2 . }
    RULE { :result :out ?n } WHERE {
      GROUP { ?s :p ?v . SET(?w := 1 / ?v) } [ ?n := COUNT(*) ]
    }`))[0].o.value, 1);
});

test('groups wait for recursive producers and run exactly once', () => {
  const source = `DATA { :a :edge :b . :b :edge :c . }
    RULE :count { :result :out ?n } WHERE { GROUP { ?x :reach ?y } [ ?n := COUNT(*) ] }
    RULE :transitive { ?x :reach ?z } WHERE { ?x :reach ?y . ?y :edge ?z }
    RULE :seed { ?x :reach ?y } WHERE { ?x :edge ?y }`;
  const compiled = compile(source);
  assert.equal(compiled.program.rules[0].runOnce, true);
  assert.equal(compiled.analysis.dependency.rules[0].hasGroup, true);
  assert(compiled.analysis.dependency.edges.filter((edge) => edge.from === 0).every((edge) => edge.closed));
  const result = run(source);
  assert.equal(outputs(result)[0].o.value, 3);
  assert.equal(result.perRule[0].applications, 1);
});

test('recursive aggregation violates stratification even with no aggregate assignments', () => {
  assert.throws(() => compile(`RULE { ?s :p ?o } WHERE { GROUP BY ?s ?o { ?s :p ?o } [] }`), /Stratification/);
});

test('WHERE DATA groups read the base graph and create no dependencies', () => {
  const baseGraph = [{ s: { type: 'iri', value: 'http://example/base' }, p: { type: 'iri', value: 'http://example/p' }, o: { type: 'literal', value: 1, datatype: XSD_INTEGER } }];
  const source = `DATA { :data :p 2 . }
    RULE { :derived :p 3 } WHERE {}
    RULE { :result :out ?n } WHERE DATA { GROUP { ?s :p ?v } [ ?n := COUNT(*) ] }`;
  const result = run(source, { baseGraph });
  assert.equal(outputs(result)[0].o.value, 1);
  assert.equal(result.analysis.dependency.edges.length, 0);
});

test('group predicates include property paths and nested triple-term patterns', () => {
  const compiled = compile(`
    RULE :aggregate { :result :out ?n } WHERE {
      GROUP { ?s :p/:q ?o . ?s :term <<( ?x :r ?o )>> } [ ?n := COUNT(*) ]
    }
    RULE :p { :a :p :b } WHERE {}
    RULE :q { :b :q :c } WHERE {}
    RULE :term { :a :term <<( :x :r :c )>> } WHERE {}`);
  assert.equal(compiled.analysis.dependency.edges.filter((edge) => edge.from === 0).length, 3);
  assert.equal(outputs(eyeleng.evaluate(compiled.program, { analysis: compiled.analysis }))[0].o.value, 1);
});

test('group keys and aggregate outputs are in scope, pattern locals are not', () => {
  for (const body of [
    'GROUP BY ?s { ?s :p ?v } [ ?n := COUNT(*) ] FILTER(?v > 0)',
    'GROUP BY ?s { ?s :p ?v } [ ?n := COUNT(*) ] SET(?m := ?v)',
  ]) assert.throws(() => compile(`RULE { :result :out ?n } WHERE { ${body} }`), /before it is bound/);
  assert.throws(() => compile(`RULE { :result :out ?v } WHERE { GROUP { ?s :p ?v } [] }`), /unbound head variable/);
});

test('group well-formedness enforces fresh aggregate variables and bound arguments', () => {
  for (const [body, error] of [
    ['GROUP BY ?missing { ?s :p ?v } []', /GROUP key/],
    ['GROUP { ?s :p ?v } [ ?n := COUNT(?missing) ]', /unbound variable/],
    ['GROUP { ?s :p ?v } [ ?v := COUNT(*) ]', /already bound/],
    ['?s :p ?n . GROUP { ?x :q ?v } [ ?n := COUNT(*) ]', /already bound/],
    ['GROUP { ?s :p ?v } [ ?n := COUNT(*), ?n := SUM(?v) ]', /more than once/],
    ['?s :p ?outer . GROUP { FILTER(?outer > 0) } []', /before it is bound/],
    ['?s :p ?outer . GROUP { SET(?v := ?outer) } []', /before it is bound/],
    ['GROUP { FILTER(?v > 0) ?s :p ?v } []', /before it is bound/],
    ['GROUP { ?s :p ?v . SET(?v := 0) } []', /already bound/],
  ]) assert.throws(() => compile(`RULE { :result :out true } WHERE { ${body} }`), error);
});

test('sequential groups preserve earlier outputs without leaking them into later patterns', () => {
  const result = run(`DATA { :a :p 1, 2 . :b :p 3 . }
    RULE { :result :out ?total } WHERE {
      GROUP { ?s :p ?v } [ ?n := COUNT(*) ]
      GROUP { ?s :p ?v } [ ?sum := SUM(?v) ]
      SET(?total := ?n + ?sum)
    }`);
  assert.equal(outputs(result)[0].o.value, 9);
});

test('repeated group mappings create fresh head blank nodes per occurrence', () => {
  const repeated = run(`DATA { :a :p :b, :c . :b :q :d . :c :q :d . }
    RULE { [] :out true } WHERE {
      ?s :p/:q ?o . GROUP {} []
    }`);
  assert.equal(outputs(repeated).length, 2);
});

test('COUNT(DISTINCT *) deduplicates repeated mappings from sequence paths', () => {
  const result = run(`DATA { :a :p :b, :c . :b :q :d . :c :q :d . }
    RULE { :result :out ?n ; :distinct ?d } WHERE {
      GROUP { ?s :p/:q ?o } [ ?n := COUNT(*), ?d := COUNT(DISTINCT *) ]
    }`);
  assert.equal(outputs(result)[0].o.value, 2);
  assert.equal(result.inferred.find((triple) => triple.p.value === 'http://example/distinct').o.value, 1);
});

test('aggregate queries use forward evaluation with sync and async parity', async () => {
  const source = prefix + `DATA { :a :p 1, 2 . }
    RULE { :result :out ?n } WHERE { GROUP { ?s :p ?v } [ ?n := COUNT(*) ] }`;
  const sync = eyeleng.runQuery(source, '?s :out ?n', options);
  const asyncResult = await eyeleng.runQueryAsync(source, '?s :out ?n', options);
  assert.equal(sync.query.mode, 'forward');
  assert.equal(sync.query.bindings[0].n.value, 2);
  assert.deepEqual(sync.inferred.map(tripleKey), asyncResult.inferred.map(tripleKey));
  assert.deepEqual(sync.query.bindings, asyncResult.query.bindings);
});

test('a query group uses forward evaluation and preserves aggregate inputs', () => {
  const result = eyeleng.runQuery(prefix + 'DATA { :a :p 1, 2 . }',
    'GROUP { ?s :p ?v } [ ?n := COUNT(*) ]', options);
  assert.equal(result.query.mode, 'forward');
  assert.equal(result.query.bindings[0].n.value, 2);
  assert.deepEqual(result.query.select, ['n']);
});

test('imports preserve aggregation rules and their producer dependencies', async () => {
  const source = prefix + 'IMPORTS <http://example/library> RULE { :a :p 1 } WHERE {}';
  const library = prefix + 'RULE { :result :out ?n } WHERE { GROUP { ?s :p ?v } [ ?n := COUNT(*) ] }';
  const result = await eyeleng.runAsync(source, { ...options, importResolver: () => library });
  assert.equal(outputs(result)[0].o.value, 1);
});

test('group grammar accepts case-insensitive keywords and optional dots', () => {
  assert.equal(outputs(run(`DATA { :a :p 1 . }
    RULE { :result :out ?n } WHERE { gRoUp { ?s :p ?v . sEt(?w := ?v) . } [ ?n := cOuNt(dIsTiNcT ?w) ] . }`))[0].o.value, 1);
});

test('group grammar rejects nested groups, negation, expressions and unsupported aggregates', () => {
  for (const body of [
    'GROUP BY {} []',
    'GROUP { GROUP {} [] } []',
    'GROUP { NOT {} } []',
    'NOT { GROUP {} [] }',
    'GROUP {} [ ?n := AVG(?v) ]',
    'GROUP {} [ ?n := MIN(*) ]',
    'GROUP {} [ ?n := SUM(DISTINCT ?v) ]',
    'GROUP {} [ ?n := COUNT(?v + 1) ]',
    'GROUP {} [ ?n := "COUNT"(*) ]',
    'GROUP {} [ ?n := COUNT(*), ]',
    'GROUP {}',
  ]) assert.throws(() => eyeleng.parse(prefix + `RULE {} WHERE { ${body} }`, options));
});

test('numeric escapes reject surrogate code points in strings and IRIs', () => {
  for (const escape of ['\\uD800', '\\uDFFF', '\\U0000D800', '\\U0000DFFF', '\\uD83D\\uDE00', '\\U00110000']) {
    for (const term of [`"${escape}"`, `<http://example/${escape}>`]) {
      assert.throws(() => eyeleng.parse(prefix + `DATA { :s :p ${term} }`, options), /Invalid.*escape/);
    }
  }
});

test('documents reject unpaired surrogates, including in comments', () => {
  for (const character of ['\uD800', '\uDFFF']) {
    assert.throws(() => eyeleng.parse(prefix + `DATA { :s :p "${character}" }`, options), /Unicode scalar/);
    assert.throws(() => eyeleng.parse(prefix + `# ${character}`, options), /Unicode scalar/);
  }
});

test('Unicode scalar boundaries and supplementary characters remain accepted', () => {
  for (const value of ['\\uD7FF', '\\uE000', '\\U0001F600', '\\U0010FFFF', '😀']) {
    assert.doesNotThrow(() => eyeleng.parse(prefix + `DATA { :s :p "${value}" }`, options));
  }
});

test('comments end at CR, LF, CRLF and end of file', () => {
  for (const newline of ['\r', '\n', '\r\n']) {
    assert.equal(outputs(run(`# comment${newline}RULE { :result :out true } WHERE {} # trailing`)).length, 1);
  }
});

main();
