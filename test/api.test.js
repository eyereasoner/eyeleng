'use strict';

const { test, main } = require('./harness.js').createHarness('API');
const assert = require('node:assert/strict');
const { parse, compile, run, runToString, runAsync, runToStringAsync, runQuery, parseRdfMessageLog } = require('../src/index.js');
const { tripleKey, iri } = require('../src/term.js');

test('parse reads prefixes, data, and rules', () => {
  const program = parse(`
PREFIX : <http://example/>
DATA { :A :p :B . }
RULE { ?x :q ?y } WHERE { ?x :p ?y }
`);
  assert.equal(program.prefixes[''], 'http://example/');
  assert.equal(program.data.length, 1);
  assert.equal(program.rules.length, 1);
  assert.equal(Object.hasOwn(program, 'queries'), false);
});

test('forward chaining derives a recursive closure', () => {
  const source = `
PREFIX : <http://example/>
DATA { :A :parentOf :B . :B :parentOf :C . }
RULE { ?x :ancestorOf ?y } WHERE { ?x :parentOf ?y }
RULE { ?x :ancestorOf ?z } WHERE { ?x :parentOf ?y . ?y :ancestorOf ?z }
`;
  const output = runToString(source);
  assert.match(output, /:A :ancestorOf :B \./);
  assert.match(output, /:A :ancestorOf :C \./);
});

test('large rule bodies are evaluated without using the JavaScript call stack', () => {
  const patterns = Array.from({ length: 2000 }, (_, index) => `  :source :value ?value${index} .`).join('\n');
  const output = runToString(`
PREFIX : <http://example/>
DATA { :source :value :target . }
RULE { :case :result :passed } WHERE {
${patterns}
}
`);
  assert.match(output, /:case :result :passed \./);
});

test('tuple lookups build a demand-driven index for the bound members', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA {
  (:a :b1 :c) :relation :v1 .
  (:a :b2 :d) :relation :v2 .
  (:z :b3 :c) :relation :v3 .
}
RULE { :case :value ?value } WHERE {
  (:a ?middle :c) :relation ?value .
}
`);
  assert.match(output, /:case :value :v1 \./);
  assert.doesNotMatch(output, /:case :value :v[23] \./);
});

test('FILTER, NOT, and SET work together', () => {
  const source = `
PREFIX : <http://example/>
DATA { :alice :score 7 . :bob :score 2 . :bob :blocked true . }
RULE { ?x :label ?label } WHERE {
  ?x :score ?score .
  FILTER(?score >= 5) .
  NOT { ?x :blocked true } .
  SET(?label := concat("score-", str(?score)))
}
`;
  const output = runToString(source);
  assert.match(output, /:alice :label "score-7" \./);
  assert.doesNotMatch(output, /:bob :label/);
});

test('API returns inferred and closure separately', () => {
  const result = run(`
PREFIX : <http://example/>
DATA { :Socrates a :Man . }
RULE { ?x a :Mortal } WHERE { ?x a :Man }
`);
  assert.equal(result.input.length, 0);
  assert.equal(result.data.length, 1);
  assert.equal(result.inferred.length, 2);
  assert.equal(result.closure.length, 2);
});



test('run-once SET rules can feed later general rules', () => {
  const source = `
PREFIX : <http://example/>
DATA { :a :p :b . }
RULE { :calc :label ?label } WHERE {
  :a :p ?next .
  SET(?label := CONCAT("a -> ", STR(?next)))
}
RULE { :answer :path ?label } WHERE { :calc :label ?label }
`;
  const output = runToString(source);
  assert.match(output, /:calc :label "a -> http:\/\/example\/b" \./);
  assert.match(output, /:answer :path "a -> http:\/\/example\/b" \./);
});

test('BASE resolves relative IRIs and default prefix', () => {
  const output = runToString(`
BASE <http://example/base/>
PREFIX : <>
DATA { <alice> :knows <bob> . }
RULE { ?x :friend ?y } WHERE { ?x :knows ?y }
`);
  assert.match(output, /:alice :friend :bob \./);
});

test('Turtle-style semicolon and comma abbreviations expand triples', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA { :alice :knows :bob, :carol ; :score 9 . }
RULE { ?friend :knownBy ?person ; :scoredFor ?score } WHERE {
  ?person :knows ?friend ; :score ?score .
}
`);
  assert.match(output, /:bob :knownBy :alice \./);
  assert.match(output, /:carol :knownBy :alice \./);
  assert.match(output, /:bob :scoredFor 9 \./);
});

test('typed and language-tagged literals work with builtins', () => {
  const output = runToString(`
PREFIX : <http://example/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
DATA { :alice :name "Alice Smith"@en ; :age "22"^^xsd:integer . }
RULE { :alice :slug ?slug } WHERE {
  :alice :name ?name ; :age ?age .
  FILTER(datatype(?age) = xsd:integer && ?age >= 18 && lang(?name) = "en") .
  SET(?slug := REPLACE(LCASE(STR(?name)), " ", "-"))
}
`);
  assert.match(output, /:alice :slug "alice-smith" \./);
});

test('compile rejects unsafe head variables', () => {
  const source = `
PREFIX : <http://example/>
DATA { :alice :knows :bob . }
RULE { ?x :bad true } WHERE { :alice :knows :bob }
`;
  const { diagnostics } = compile(source, { throwOnDiagnostics: false });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'unsafe-head-variable');
  assert.throws(() => compile(source), /unbound head variable/);
});


test('CLI-style raw query body projects bindings over the closure', () => {
  const { runQuery, formatBindings } = require('../src/index.js');
  const result = runQuery(`
PREFIX : <http://example/>
DATA { :alice :parentOf :bob . :bob :parentOf :carol . }
RULE { ?x :ancestorOf ?y } WHERE { ?x :parentOf ?y }
RULE { ?x :ancestorOf ?z } WHERE { ?x :parentOf ?y . ?y :ancestorOf ?z }
`, ':alice :ancestorOf ?d');
  const output = formatBindings(result.query.bindings, result.prefixes, result.query.select);
  assert.match(output, /\?d = :bob/);
  assert.match(output, /\?d = :carol/);
});



test('backward query mode proves recursive derived predicates with tabling', () => {
  const { runQuery, formatBindings } = require('../src/index.js');
  const result = runQuery(`
PREFIX : <http://example/>
DATA { :alice :parentOf :bob . :bob :parentOf :carol . }
RULE { ?x :ancestorOf ?y } WHERE { ?x :parentOf ?y }
RULE { ?x :ancestorOf ?z } WHERE { ?x :parentOf ?y . ?y :ancestorOf ?z }
`, ':alice :ancestorOf ?d', { queryMode: 'backward' });
  assert.equal(result.iterations, 0);
  assert.equal(result.query.mode, 'backward');
  assert.ok(result.query.stats.memoStores > 0);
  const output = formatBindings(result.query.bindings, result.prefixes, result.query.select);
  assert.match(output, /\?d = :bob/);
  assert.match(output, /\?d = :carol/);
});

test('run-once assignment rules fall back to forward query evaluation', () => {
  const { runQuery, formatBindings } = require('../src/index.js');
  const source = `
PREFIX : <http://example/>
DATA { :alice :score 41 . :bob :score 2 . }
RULE { ?x :nextScore ?m } WHERE { ?x :score ?n . SET(?m := ?n + 1) }
`;
  assert.throws(() => runQuery(source, '?who :nextScore ?score', { queryMode: 'backward' }), /not supported by the backward prover/);
  const result = runQuery(source, '?who :nextScore ?score');
  assert.equal(result.query.mode, 'forward');
  const output = formatBindings(result.query.bindings, result.prefixes, result.query.select);
  assert.match(output, /\?score = 42; \?who = :alice/);
  assert.match(output, /\?score = 3; \?who = :bob/);
});

test('auto query mode uses backward planning for supported rules', () => {
  const { runQuery } = require('../src/index.js');
  const result = runQuery(`
PREFIX : <http://example/>
DATA { :a :p :b . }
RULE { ?x :q ?y } WHERE { ?x :p ?y }
`, ':a :q ?y');
  assert.equal(result.query.mode, 'backward');
  assert.equal(result.iterations, 0);
});


test('direct backward query sees external base graph facts', () => {
  const result = runQuery(`
PREFIX : <http://example/>
RULE { ?x :q ?y } WHERE { ?x :p ?y }
`, ':a :q ?y', {
    queryMode: 'backward',
    baseGraph: [{ s: iri('http://example/a'), p: iri('http://example/p'), o: iri('http://example/b') }],
  });
  assert.equal(result.query.mode, 'backward');
  assert.equal(result.query.bindings[0].y.value, 'http://example/b');
});

test('WHERE DATA rules fall back to forward query evaluation', () => {
  const source = `
PREFIX : <http://example/>
RULE { ?x :q ?y } WHERE DATA { ?x :p ?y }
`;
  const options = {
    baseGraph: [{ s: iri('http://example/a'), p: iri('http://example/p'), o: iri('http://example/b') }],
  };
  assert.throws(() => runQuery(source, ':a :q ?y', { ...options, queryMode: 'backward' }), /not supported by the backward prover/);
  const result = runQuery(source, ':a :q ?y', options);
  assert.equal(result.query.mode, 'forward');
  assert.equal(result.query.bindings[0].y.value, 'http://example/b');
});

test('NOT DATA query clauses use only the immutable base graph', () => {
  const result = runQuery(`
PREFIX : <http://example/>
DATA { :a :seed true . }
RULE { :a :blocked true } WHERE { :a :seed true }
`, ':a :seed true . NOT DATA { :a :blocked true }');
  assert.equal(result.query.mode, 'forward');
  assert.equal(result.query.bindings.length, 1);
});




test('auto query mode falls back to forward when the demanded slice contains a run-once rule', () => {
  const { runQuery, formatBindings } = require('../src/index.js');
  const result = runQuery(`
PREFIX : <http://example/>
DATA { :alice :score 41 . :bob :score 2 . :seed :seen :x . }
RULE { ?x :nextScore ?m } WHERE { ?x :score ?n . SET(?m := ?n + 1) }
RULE { ?x :ready ?score } WHERE { ?x :nextScore ?score . FILTER(?score = 42) }
RULE { [] :unrelated :x } WHERE { :seed :seen :x }
`, '?who :ready ?score');
  assert.equal(result.query.mode, 'forward');
  const output = formatBindings(result.query.bindings, result.prefixes, result.query.select);
  assert.match(output, /\?score = 42; \?who = :alice/);
  assert.doesNotMatch(output, /bob/);
});

test('auto query mode falls back to forward when a demanded predicate needs a run-once rule', () => {
  const { runQuery, formatBindings } = require('../src/index.js');
  const result = runQuery(`
PREFIX : <http://example/>
DATA { :alice :score 41 . :bob :score 2 . :seed :seen :x . }
RULE { ?x :nextScore ?m } WHERE { ?x :score ?n . SET(?m := ?n + 1) }
RULE { ?x :ready ?score } WHERE { ?x :nextScore ?score . FILTER(?score = 42) }
RULE { [] :ready 999 } WHERE { :seed :seen :x }
`, '?who :ready ?score');
  assert.equal(result.query.mode, 'forward');
  assert.match(result.closure.map(tripleKey).join('\n'), /nextScore/);
  const output = formatBindings(result.query.bindings, result.prefixes, result.query.select);
  assert.match(output, /\?score = 42; \?who = :alice/);
});

test('parseQuery accepts raw body text and rejects non-SRL QUERY/SELECT syntax', () => {
  const { parseQuery } = require('../src/index.js');
  const raw = parseQuery('?x :p ?y', { prefixes: { '': 'http://example/' } });
  assert.equal(raw.body.length, 1);
  const braced = parseQuery('{ ?x :p :y }', { prefixes: { '': 'http://example/' } });
  assert.equal(braced.body.length, 1);
  assert.throws(() => parseQuery('QUERY ?x WHERE { ?x :p :y }'), /not part of the SPARQL-RL rule-set grammar/);
  assert.throws(() => parseQuery('SELECT ?x WHERE { ?x :p :y }'), /not part of the SPARQL-RL rule-set grammar/);
});

test('top-level QUERY, SELECT, and N3 implication are not accepted as SRL', () => {
  assert.throws(() => parse('PREFIX : <http://example/> QUERY ?x WHERE { ?x :p :y }'), /Expected PREFIX, BASE, VERSION, IMPORTS, DATA, or RULE/);
  assert.throws(() => parse('PREFIX : <http://example/> SELECT ?x WHERE { ?x :p :y }'), /Expected PREFIX, BASE, VERSION, IMPORTS, DATA, or RULE/);
  assert.throws(() => parse('PREFIX : <http://example/> { ?x :p :y } => { ?x :q :y }'), /Expected PREFIX, BASE, VERSION, IMPORTS, DATA, or RULE/);
});

test('legacy IF THEN rule form is rejected by the current grammar', () => {
  assert.throws(() => parse(`
PREFIX : <http://example/>
IF { ?x a :Man } THEN { ?x a :Mortal }
`, { strictGrammar: true }), /Expected PREFIX, BASE, VERSION, IMPORTS, DATA, or RULE/);
});

test('analysis rejects recursive negation through dependency graph', () => {
  const source = `
PREFIX : <http://example/>
DATA { :alice :person true . }
RULE { ?x :in true } WHERE { ?x :person true . NOT { ?x :out true } }
RULE { ?x :out true } WHERE { ?x :person true . NOT { ?x :in true } }
`;
  const { compile } = require('../src/index.js');
  assert.throws(() => compile(source), /recursive closed dependency|Stratification condition/i);
  const unchecked = compile(source, { throwOnDiagnostics: false });
  assert.equal(unchecked.analysis.errors[0].code, 'unstratified-closed-dependency');
});

test('VERSION, blank nodes, single-quoted strings, and IN/NOT IN expressions parse and run', () => {
  const result = run(`
VERSION "1.2"
PREFIX : <http://example/>
DATA { _:a :level 'gold' . :bob :level 'bronze' . }
RULE { ?x :priority true } WHERE { ?x :level ?level . FILTER(?level IN ('gold', 'platinum')) }
RULE { ?x :ordinary true } WHERE { ?x :level ?level . FILTER(?level NOT IN ('gold', 'platinum')) }
`);
  const output = require('../src/index.js').formatTriples(result.inferred, result.prefixes);
  assert.equal(result.version, '1.2');
  assert.match(output, /_:a :priority true \./);
  assert.match(output, /:bob :ordinary true \./);
});

test('body property paths support sequence and inverse paths', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA { :alice :parentOf :bob . :bob :parentOf :carol . }
RULE { ?x :grandparentOf ?z } WHERE { ?x :parentOf/:parentOf ?z }
RULE { ?child :hasParent ?parent } WHERE { ?child ^:parentOf ?parent }
`);
  assert.match(output, /:alice :grandparentOf :carol \./);
  assert.match(output, /:bob :hasParent :alice \./);
  assert.match(output, /:carol :hasParent :bob \./);
});

test('stratified evaluation prevents source-order negation mistakes', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA { :bob a :Person . :carol a :Person ; :flagged true . }
RULE { ?x :eligible true } WHERE { ?x a :Person . NOT { ?x :blocked true } }
RULE { ?x :blocked true } WHERE { ?x :flagged true }
`);
  assert.match(output, /:bob :eligible true \./);
  assert.match(output, /:carol :blocked true \./);
  assert.doesNotMatch(output, /:carol :eligible true/);
});

test('IMPORTS can be resolved by the API without duplicate cycles', () => {
  const files = {
    'file:///main.srl': 'PREFIX : <http://example/> IMPORTS <lib.srl> DATA { :alice :parentOf :bob . :bob :parentOf :carol . }',
    'file:///lib.srl': 'PREFIX : <http://example/> IMPORTS <main.srl> RULE { ?x :ancestorOf ?y } WHERE { ?x :parentOf ?y } RULE { ?x :ancestorOf ?z } WHERE { ?x :parentOf ?y . ?y :ancestorOf ?z }',
  };
  const output = runToString(files['file:///main.srl'], {
    baseIRI: 'file:///main.srl',
    importResolver(target) {
      return { source: files[target], options: { baseIRI: target, filename: target } };
    },
  });
  assert.match(output, /:alice :ancestorOf :carol \./);
});


test('optional rule IRIs are accepted by the SPARQL 1.2 RL grammar', () => {
  const program = parse('PREFIX : <http://example/> RULE :named { ?x :q ?y } WHERE { ?x :p ?y }');
  assert.equal(program.rules[0].name, 'http://example/named');
});

test('blank-node property lists and RDF collections expand into graph patterns', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA {
  :alice :knows [ :name "Bob" ; :tag "friend" ] .
  :team :members ( :alice :bob ) .
}
RULE { ?x :knowsNamed ?name } WHERE { ?x :knows [ :name ?name ] }
RULE { :team :firstMember ?first } WHERE { :team :members/rdf:first ?first }
`);
  assert.match(output, /:alice :knowsNamed "Bob" \./);
  assert.match(output, /:team :firstMember :alice \./);
});

test('reified triple terms and annotation blocks can be matched', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA {
  :alice :says :hello {| :source :chat |} .
  << :bob :says :hi >> :source :email .
}
RULE { ?speaker :statementSource ?source } WHERE { << ?speaker :says ?object >> :source ?source }
`);
  assert.match(output, /:alice :statementSource :chat \./);
  assert.match(output, /:bob :statementSource :email \./);
});

test('$ variables, BNODE, TRIPLE accessors, and date builtins work', () => {
  const output = runToString(`
PREFIX : <http://example/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
DATA { :event :when "2026-05-15T10:20:30Z"^^xsd:dateTime . }
RULE { :event :year $year ; :blank $blank ; :tripleSubject $subject } WHERE {
  :event :when $when .
  SET($year := YEAR($when))
  SET($blank := BNODE("event"))
  SET($triple := TRIPLE(:subject, :predicate, :object))
  SET($subject := SUBJECT($triple))
}
`);
  assert.match(output, /:event :year 2026 \./);
  assert.match(output, /:event :blank _:event \./);
  assert.match(output, /:event :tripleSubject :subject \./);
});

test('sequential well-formedness rejects variables used before binding', () => {
  const source = `
PREFIX : <http://example/>
DATA { :alice :score 10 . }
RULE { :alice :bad true } WHERE { FILTER(?score > 5) . :alice :score ?score }
`;
  assert.throws(() => compile(source), /FILTER uses \?score before it is bound/);
  const checked = compile(source, { throwOnDiagnostics: false });
  assert.equal(checked.analysis.errors[0].code, 'unbound-filter-variable');
});


test('FILTER accepts direct built-in calls and language-direction literals retain direction', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA { :n1 :value -3.5 . :n2 :value 7 . :msg :text "bonjour"@fr--ltr . }
RULE { ?x :negative true } WHERE { ?x :value ?v . FILTER isNUMERIC(?v) . FILTER(?v < 0) }
RULE { :msg :dir ?dir } WHERE { :msg :text ?text . SET(?dir := LANGDIR(?text)) }
`);
  assert.match(output, /:n1 :negative true \./);
  assert.doesNotMatch(output, /:n2 :negative true/);
  assert.match(output, /:msg :dir "ltr" \./);
});

test('IRI-named function calls can be supplied as custom API builtins', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA { :alice :name "Alice" . :bob :name "Bob" . }
RULE { ?x :aName true } WHERE { ?x :name ?name . FILTER :startsWithA(?name) }
`, {
    builtins: {
      'http://example/startsWithA': ([value], helpers) => helpers.termToString(value).startsWith('A'),
    },
  });
  assert.match(output, /:alice :aName true \./);
  assert.doesNotMatch(output, /:bob :aName true/);
});

test('Unicode escapes and signed numeric RDF terms parse in data blocks', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA { :sample :text "A\\u0042\\U00000043" . :thermo :delta -12 . }
RULE { :sample :unicodeDecoded true } WHERE { :sample :text "ABC" }
RULE { :thermo :belowZero true } WHERE { :thermo :delta ?d . FILTER(?d < 0) }
`);
  assert.match(output, /:sample :unicodeDecoded true \./);
  assert.match(output, /:thermo :belowZero true \./);
});

test('dependency analysis accounts for variable predicates in rule heads and bodies', () => {
  const source = `
PREFIX : <http://example/>
DATA { :a :source :blocked . }
RULE { ?x ?p true } WHERE { ?x :source ?p . NOT { ?x :blocked true } }
RULE { ?x :blocked true } WHERE { ?x ?anyPredicate true }
`;
  assert.throws(() => compile(source), /recursive closed dependency|Stratification condition/i);
  const checked = compile(source, { throwOnDiagnostics: false });
  assert.equal(checked.analysis.errors[0].code, 'unstratified-closed-dependency');
});

test('RDF 1.2 reifiers expand through rdf:reifies and can be bound', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA {
  :alice :says :hello ~ :claim1 {| :source :chat |} .
  << :bob :says :hi ~ :claim2 >> :source :email .
}
RULE { ?speaker :statementSource ?source } WHERE {
  ?claim rdf:reifies <<(?speaker :says ?object)>> .
  ?claim :source ?source .
}
RULE { ?claim :isClaim true } WHERE { ?claim rdf:reifies <<(?speaker :says ?object)>> }
`);
  assert.match(output, /:alice :statementSource :chat \./);
  assert.match(output, /:bob :statementSource :email \./);
  assert.match(output, /:claim1 :isClaim true \./);
  assert.match(output, /:claim2 :isClaim true \./);
});

test('STRLANG and STRLANGDIR produce language-tagged literals comparable with parsed literals', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA { :msg :plain "hello"@en ; :directed "bonjour"@fr--ltr . }
RULE { :msg :plainRoundTrip true } WHERE {
  :msg :plain ?text .
  SET(?copy := STRLANG("hello", "en"))
  FILTER sameTerm(?text, ?copy)
}
RULE { :msg :directedRoundTrip true } WHERE {
  :msg :directed ?text .
  SET(?copy := STRLANGDIR("bonjour", "fr", "ltr"))
  FILTER sameTerm(?text, ?copy)
}
`);
  assert.match(output, /:msg :plainRoundTrip true \./);
  assert.match(output, /:msg :directedRoundTrip true \./);
});

test('NOW uses the same timestamp throughout one evaluation when supplied by the caller', () => {
  const output = runToString(`
PREFIX : <http://example/>
RULE { :clock :consistent true ; :snapshot ?t1 } WHERE {
  SET(?t1 := NOW())
  SET(?t2 := NOW())
  FILTER sameTerm(?t1, ?t2)
}
`, { now: new Date('2026-05-15T12:34:56Z') });
  assert.match(output, /:clock :consistent true \./);
  assert.match(output, /:clock :snapshot "2026-05-15T12:34:56\.000Z"\^\^xsd:dateTime \./);
});


test('strict grammar mode rejects non-grammar extensions and loose tokens', () => {
  const options = { strictGrammar: true };
  assert.throws(() => parse(`
PREFIX : <http://example/>
RULE { :s :p ?x } WHERE { :s :q ?y BIND(?y AS ?x) }
`, options), /BIND is not part of the SPARQL 1.2 RL grammar/);
  assert.throws(() => parse(`
PREFIX : <http://example/>
RULE { :s :p "bad\\q" } WHERE { :s :q ?x }
`, options), /Invalid escape/);
  assert.throws(() => parse(`
PREFIX : <http://example/>
RULE { :bad%ZZ :p ?x } WHERE { :s :q ?x }
`, options), /Invalid prefixed name/);
  assert.throws(() => parse(`
VERSION "2.0"
PREFIX : <http://example/>
RULE { :s :p ?x } WHERE { :s :q ?x }
`, options), /VERSION must be the SPARQL-RL version label/);
  assert.throws(() => parse(`
VERSION """1.2"""
PREFIX : <http://example/>
RULE { :s :p ?x } WHERE { :s :q ?x }
`, options), /VERSION must use a short string literal/);
  assert.doesNotThrow(() => parse(`
VERSION "1.2"
PREFIX : <http://example/>
RULE { :s :p ?x } WHERE { :s :q ?x SET(?z := STR(?x)) }
`, options));
});


test('recursive SET rules are rejected as closed recursive dependencies', () => {
  const source = `
PREFIX : <http://example/>
DATA { :counter :value 0 . :limit :max 3 . }
RULE { :counter :value ?next } WHERE {
  :counter :value ?value .
  :limit :max ?max .
  FILTER(?value < ?max)
  SET(?next := ?value + 1)
}
`;
  assert.throws(() => compile(source), /recursive closed dependency|Stratification condition/i);
  const unchecked = compile(source, { throwOnDiagnostics: false });
  assert.equal(unchecked.analysis.errors[0].code, 'unstratified-closed-dependency');
});

test('head blank nodes are deterministically skolemized with all universal bindings', () => {
  const source = `
PREFIX : <http://example/>
DATA { :a :p :o . :b :p :o . }
RULE { [] :source ?s ; :value :o } WHERE { ?s :p :o }
`;
  const first = run(source);
  const second = run(source);
  assert.deepEqual(first.inferred.map(tripleKey).sort(), second.inferred.map(tripleKey).sort());
  const sourcePredicate = 'http://example/source';
  const witnessSubjects = first.inferred
    .filter((triple) => triple.p.type === 'iri' && triple.p.value === sourcePredicate)
    .map((triple) => triple.s.value);
  assert.equal(witnessSubjects.length, 2);
  assert.equal(new Set(witnessSubjects).size, 2);
});


test('head blank skolemization is a standard function of all universals', () => {
  const source = `
PREFIX : <http://example.org/#>
DATA { :s1 :p :o . :s2 :p :o . }
RULE { [] :witnessFor ?s } WHERE { ?s :p :o }
`;
  const result = run(source, { maxIterations: 20, throwOnDiagnostics: false });
  const witnessSubjects = result.inferred
    .filter((triple) => triple.p.value === 'http://example.org/#witnessFor')
    .map((triple) => triple.s.value);
  assert.equal(witnessSubjects.length, 2);
  assert.equal(new Set(witnessSubjects).size, 2);
});

test('recursive blank-node-head rules violate the stratification condition', () => {
  const source = `
PREFIX : <http://example.org/#>
DATA { :s :p :o . }
RULE { [] :p :o } WHERE { ?s :p :o }
`;
  assert.throws(() => compile(source), /recursive closed dependency|Stratification condition/i);
});

test('RDF Message Logs expose Eyeling-style envelopes and payload triples', async () => {
  const messages = `VERSION "1.2-messages"
PREFIX : <http://example/messages#>

_:reading :sensor :s1 ; :value 21 .

MESSAGE

# Empty heartbeat message.

MESSAGE

_:reading :sensor :s2 ; :value 22 .
`;
  const rules = `PREFIX : <http://example/messages#>
PREFIX eymsg: <https://eyereasoner.github.io/eyeling/vocab/message#>
RULE { ?envelope :mentionsSensor ?sensor } WHERE {
  ?envelope eymsg:payloadGraph ?payload .
  ?payload eymsg:payloadTriple <<(?reading :sensor ?sensor)>> .
}
RULE { ?envelope :isHeartbeat true } WHERE {
  ?envelope eymsg:payloadKind eymsg:empty .
}`;
  const messageLog = await parseRdfMessageLog(messages, { baseIRI: 'urn:messages' });
  const result = await runAsync(rules, { baseGraph: messageLog.baseData });
  const out = await runToStringAsync(rules, { baseGraph: messageLog.baseData });
  assert.equal(result.prefixes.eymsg, 'https://eyereasoner.github.io/eyeling/vocab/message#');
  assert.match(out, /:mentionsSensor :s1 \./);
  assert.match(out, /:mentionsSensor :s2 \./);
  assert.match(out, /:isHeartbeat true \./);
});


test('DATA blocks retain the RDF-style SRL term surface', () => {
  const output = runToString(`
PREFIX : <http://example/>
DATA {
  :msg :text "bonjour"@fr--ltr .
  :root :nested ( 1 [ :p :q ] ) .
  :s :p :o {| :source :witness |} .
}
RULE { :msg :dir ?dir } WHERE { :msg :text ?text . SET(?dir := LANGDIR(?text)) }
RULE { :root :first ?first } WHERE { :root :nested/rdf:first ?first }
RULE { :test :annotation ?source } WHERE {
  ?statement rdf:reifies <<(:s :p :o)>> .
  ?statement :source ?source .
}
`);
  assert.match(output, /:msg :dir "ltr" \./);
  assert.match(output, /:root :first 1 \./);
  assert.match(output, /:test :annotation :witness \./);
});

test('DATA blocks accept RDF 1.2 symmetric and standalone reifier syntax', () => {
  const symmetric = parse(`
PREFIX : <http://example/>
DATA {
  123 :q 456 .
  <<( :s :p :o )>> :q <<( :s1 :p1 :o1 )>> .
}
`);
  assert.equal(symmetric.data.length, 2);
  assert.equal(symmetric.data[0].s.type, 'literal');
  assert.equal(symmetric.data[1].s.type, 'triple');

  const standalone = parse(`
PREFIX : <http://example/>
DATA { << :a :b :c ~:r >> . }
`);
  assert.equal(standalone.data.length, 1);
  assert.equal(standalone.data[0].s.value, 'http://example/r');
  assert.equal(standalone.data[0].p.value, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies');
});

test('SRL rejects invalid base directions, subject a, and empty annotations', () => {
  const invalidPatterns = [
    'RULE { } WHERE { :s :p "abc"@en--LTR }',
    'RULE { :s :p "abc"@en--LTR } WHERE { ?a ?b ?c }',
    'RULE { } WHERE { a :p "abc" }',
    'RULE { a :p "abc" } WHERE { ?a ?b ?c }',
    'RULE { } WHERE { :s :p :o ~:r {| |} }',
    'RULE { :s :p :o ~:r {| |} } WHERE { ?a ?b ?c }',
    'DATA { :s :p :o ~ ?r {| :p :z |} }',
  ];
  for (const pattern of invalidPatterns) {
    assert.throws(() => parse(`PREFIX : <http://example/>\n${pattern}`), Error, pattern);
  }
});


test('BIND is rejected and recursive SET dependencies are closed', () => {
  assert.throws(() => parse(`
PREFIX : <http://example.org/#>
RULE { ?s ?p ?o } WHERE { ?s :p ?o . BIND(:p AS ?p) }
`), /BIND is not part of the SPARQL 1.2 RL grammar/);

  assert.throws(() => compile(`
PREFIX : <http://example.org/#>
RULE { ?x :p ?v1 } WHERE { ?x :p ?v . SET(?v1 := ?v + 1) }
`), /recursive closed dependency|Stratification condition/i);
});

test('auto backward query ignores unsupported rules outside the demanded slice', () => {
  const source = `
PREFIX : <http://example/>
DATA { :alice :parent :bob . :bob :parent :carol . :a :q :b . :b :q :c . }
RULE { ?x :ancestor ?y } WHERE { ?x :parent ?y }
RULE { ?x :ancestor ?z } WHERE { ?x :parent ?y . ?y :ancestor ?z }
RULE { ?x :twoStep ?y } WHERE { ?x :q/:q ?y }
`;
  const result = runQuery(source, ':alice :ancestor ?who');
  assert.equal(result.query.mode, 'backward');
  assert.ok(result.query.stats.goals > 0);
  assert.deepEqual(
    result.query.bindings.map((binding) => binding.who.value).sort(),
    ['http://example/bob', 'http://example/carol'],
  );
});



test('WHERE DATA matches only the immutable ground-data graph', () => {
  const result = run(`
PREFIX : <http://example/>
DATA { :a :seed :x . }
RULE { ?x :derived :yes } WHERE { ?x :seed :x }
RULE { ?x :groundOnly :yes } WHERE DATA { ?x :derived :yes }
`);
  const keys = result.inferred.map(tripleKey);
  assert(keys.some((key) => key.includes('http://example/derived')));
  assert(!keys.some((key) => key.includes('http://example/groundOnly')));
});

test('NOT DATA ignores inferred triples but sees input and DATA triples', () => {
  const result = run(`
PREFIX : <http://example/>
DATA { :a :seed :x . }
RULE { ?x :blocked :yes } WHERE { ?x :seed :x }
RULE { ?x :allowed :yes } WHERE { ?x :seed :x . NOT DATA { ?x :blocked :yes } }
`);
  const keys = result.inferred.map(tripleKey);
  assert(keys.some((key) => key.includes('http://example/blocked')));
  assert(keys.some((key) => key.includes('http://example/allowed')));
});

test('legacy FOR clauses are rejected by the current grammar', () => {
  assert.throws(() => parse(`
PREFIX : <http://example/>
RULE :r1 { ?this :status :adult } FOR ?this IN :AdultShape WHERE { ?this :age ?age }
`, { strictGrammar: true }), /Expected WHERE, got FOR/);
});


main();
