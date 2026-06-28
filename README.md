# eyeleng

[![npm version](https://img.shields.io/npm/v/eyeleng.svg)](https://www.npmjs.com/package/eyeleng)
[![DOI](https://img.shields.io/badge/DOI-10.5281%2Fzenodo.20342577-blue.svg)](https://doi.org/10.5281/zenodo.20342577)

`eyeleng` stands for **EYE Logic Engine**. It is a compact JavaScript implementation of SHACL 1.2 Rules with two rule front-ends:

- **SRL** — the Shape Rules Language syntax used by the SHACL 1.2 Rules draft.
- **RDF Rules** — a Turtle/RDF syntax for rule sets.

Eyeleng is a forward-chaining reasoner over RDF-style triples. It is deliberately small, dependency-free at runtime, readable as ordinary JavaScript, and usable from the CLI, Node.js, and the browser playground.

Eyeleng implements the rules/reasoning surface. It is **not** a SHACL validation engine and does not emit SHACL validation reports.

## Quick start

```sh
npm install
npm test
./eyeleng.js examples/family.srl
./eyeleng.js --all examples/family.srl
./eyeleng.js examples/basic-ruleset.ttl
./eyeleng.js --check --deps examples/stratified-negation.srl
```

A minimal SRL program:

```srl
PREFIX : <http://example/>

DATA {
  :Socrates a :Man .
}

RULE { ?x a :Mortal } WHERE { ?x a :Man }
```

It derives:

```srl
:Socrates a :Mortal .
```

Open the [Playground](https://eyereasoner.github.io/eyeleng/playground) for a self-contained browser UI with URL loading, autosave, share links, diagnostics, queries, and SRL/RDF Rules syntax selection.

## How the reasoner works

Eyeleng computes the closure of a rule set:

```text
parse source
analyze dependencies and strata
match rule bodies against known triples
instantiate rule heads
add new triples
repeat until stable
```

A rule has a body and a head:

```srl
RULE { ?child :childOf ?parent } WHERE { ?parent :parentOf ?child }
```

If the graph contains:

```srl
:alice :parentOf :bob .
```

then the body matches with `?parent = :alice` and `?child = :bob`, and the head derives:

```srl
:bob :childOf :alice .
```

Negation is handled by stratified evaluation: rules are grouped into dependency layers, and recursion through negation is rejected so the result stays deterministic.

Recursive rules that create new terms through `SET`/`BIND` or head blank nodes run in relaxed mode by default. Relaxed mode can derive useful finite closures, but termination is not guaranteed; use `--max-iterations` as a safety valve. `--strict` rejects these recursive term-generating cycles at analysis time. Head blank nodes are deterministically skolemized per rule and solution mapping, so the same firing reuses the same witness node instead of creating a fresh one each pass.

## Language surface

SRL supports the practical rule features used by the SHACL 1.2 Rules tests and examples:

```srl
PREFIX : <http://example/>

DATA {
  :alice :score 7 .
  :bob :score 3 .
}

RULE { ?x :grade ?grade } WHERE {
  ?x :score ?score .
  FILTER(?score >= 5)
  BIND(concat("pass-", str(?score)) AS ?grade)
}

RULE { ?x :eligible true } WHERE {
  ?x :grade ?grade .
  NOT { ?x :blocked true . }
}
```

Implemented syntax includes:

- `PREFIX`, `BASE`, `VERSION`, and `IMPORTS`
- `DATA`, `RULE`, `WHERE`, `FILTER`, `BIND`, `SET`, and `NOT`
- variables such as `?x`
- IRIs, prefixed names, blank nodes, literals, RDF collections, and RDF 1.2 triple terms
- Turtle-style `;`, `,`, `a`, blank-node property lists, lists, annotations, and reifiers where supported
- property paths in rule bodies
- language tags, base-direction literals, and common XML Schema datatypes
- SRL and RDF Rules syntax front-ends

The RDF parsing path is shared with the W3C RDF syntax harness, so SRL `DATA { ... }` uses the same grammar-hardened RDF parser surface as Turtle/TriG input.

## Builtins and expressions

`FILTER`, `BIND`, and `SET` use expression evaluation. Supported operations include comparisons, boolean operators, arithmetic, `IN`, `NOT IN`, datatype/language checks, string functions, numeric functions, and selected date/time helpers.

Common builtins include:

```text
str, concat, lcase, ucase, replace
abs, round, floor, ceil
datatype, lang, iri, uri
now, year, month, day
```

The goal is useful SHACL Rules/SRL behavior, not complete SPARQL expression coverage.

## RDF 1.2 features

Eyeleng includes grammar-hardened RDF 1.1/1.2 parsing support in `src/rdfSyntax.js` and W3C manifest runners in `src/rdfManifest.js` / `src/rdfEntailment.js`.

Covered surfaces include:

- N-Triples and N-Quads
- Turtle and TriG
- RDF 1.2 triple terms
- reifiers and annotation blocks
- language-direction literals
- graph isomorphism for blank nodes
- simple, RDF, and RDFS entailment checks for RDF-MT / RDF 1.2 Semantics manifests

W3C checks:

```sh
npm run w3c:rules
npm run w3c:rules:json
npm run w3c:rules:earl
npm run w3c:rdf
npm run w3c:rdf:json
npm run w3c:rdf:earl
npm run w3c:all
```

`npm test` includes the W3C harnesses. When W3C URLs are reachable, progress is printed test by test. In offline environments, remote W3C checks are reported as unreachable unless `EYELENG_W3C_REQUIRED=1` is set. The `*:earl` scripts also print test progress, but write the EARL Turtle only to `reports/` instead of printing the report to the terminal.

The official Eyeleng EARL 1.0 report for the W3C SHACL 1.2 Rules manifest is in [reports/w3c-shacl12-rules-earl.ttl](./reports/w3c-shacl12-rules-earl.ttl).

## RDF Message Logs

Eyeleng can parse RDF Message Logs with Eyeling-compatible message delimiters and expose a replay view under the `eymsg:` vocabulary. A message log starts with `VERSION "1.2-messages"` and separates payloads with `MESSAGE` or `@message .`.

```trig
VERSION "1.2-messages"
PREFIX : <http://example/messages#>

_:reading :sensor :s1 .
MESSAGE
# empty heartbeat
MESSAGE
_:reading :sensor :s2 .
```

Use message logs directly, import them from SRL, or force message-log parsing from the CLI:

```sh
./eyeleng.js examples/rdf-messages.srl
./eyeleng.js --rdf-messages --all examples/rdf-messages.trig
```

The replay data includes message streams, envelopes, offsets, next-envelope links, payload kind, payload graph, and `eymsg:payloadTriple` triple terms. Blank-node labels are scoped per message. For Eyeleng, each payload graph is also represented as a closed RDF list of RDF 1.2 triple terms via `log:nameOf`.

## CLI

Common commands:

```sh
./eyeleng.js examples/family.srl
./eyeleng.js --all examples/family.srl
./eyeleng.js --check --deps examples/stratified-negation.srl
./eyeleng.js --json --trace --stats examples/if-then.srl
./eyeleng.js --query-file examples/query-body.txt examples/query.srl
./eyeleng.js --syntax rdf examples/w3c-rule-set-snippet.ttl
```

Important options:

```text
--all                 print the full closure, including input facts
--json                print JSON instead of compact triples/bindings
--trace               print derivation trace to stderr, or include it in JSON
--stats               print iteration and triple counts to stderr
--check               parse and analyze only; do not run rules
--strict              treat static warnings as errors, including recursive term generation
--deps                print rule dependency edges during --check
--query TEXT          run a raw SRL body pattern over the closure or backward planner
--query-file FILE     read a raw SRL body pattern from a file
--query-mode MODE     use auto, forward, or backward query planning (default auto)
--hybrid              force aggressive hybrid orientation for function-like rules
--no-hybrid           disable automatic hybrid forward/backward execution
--max-iterations N    stop after N fixpoint iterations within a recursive layer
--no-imports          parse IMPORTS/owl:imports but do not load imported rule sets
--rdf-messages        parse input as an RDF Message Log
--include-message-facts include payload facts while parsing RDF Message Logs
--syntax MODE         use srl, rdf, or auto syntax detection (default auto)
--ruleset TERM        in RDF syntax, run only the selected srl:RuleSet
--version             print version
-h, --help            print help
```

## Public API

Typical API use:

```js
const { run, formatTriples } = require('./src/index.js');

const result = run(`
PREFIX : <http://example/>
DATA { :Socrates a :Man . }
RULE { ?x a :Mortal } WHERE { ?x a :Man }
`);

console.log(formatTriples(result.inferred, result.prefixes));
```

Query mode:

```js
const { runQuery, formatBindings } = require('./src/index.js');

const result = runQuery(source, '?x :ancestorOf ?y');
console.log(formatBindings(result.query.bindings, result.prefixes));

// Query mode defaults to auto. Supported query/rule shapes are proved
// backward with tabling. If full backward proving is not safe but the
// ruleset contains function-like derived predicates, auto mode uses a
// hybrid plan before falling back to plain forward closure.
const justInTime = runQuery(source, ':alice :computedValue ?value', { queryMode: 'backward' });

// Run mode uses conservative auto-hybrid planning by default. It keeps
// ordinary rules materialized, but can prove demanded function-like predicates
// backward with tabling. Pass { hybrid: false } to force pure forward closure,
// or { hybrid: true } to force aggressive hybrid orientation.
const resultWithAutoHybrid = run(source);

// The backward planner is demand-driven: irrelevant unsupported rules do not
// prevent a query from using tabled backward proving.
```

Imports:

```js
const result = run(source, {
  baseIRI: 'file:///main.srl',
  importResolver(target) {
    return {
      source: readSomehow(target),
      options: { baseIRI: target, filename: target }
    };
  }
});
```

The API returns structured parsed programs, diagnostics, inferred triples, closure triples, traces, stats, and query bindings.

## Project layout

```text
src/tokenizer.js      source text -> tokens
src/parser.js         SRL parser -> program object
src/rdfSyntax.js      RDF 1.1/1.2 N-Triples/N-Quads/Turtle/TriG syntax
src/rdfManifest.js    W3C RDF manifest runner
src/rdfEntailment.js  simple/RDF/RDFS entailment checks
src/rdfMessages.js    RDF Message Log replay support
src/term.js           terms, keys, equality, formatting
src/store.js          triple set, predicate index, matching, paths
src/builtins.js       expression evaluation and built-in functions
src/analyze.js        diagnostics, dependencies, strata
src/engine.js         layered forward-chaining evaluator
src/backward.js       goal-directed backward query prover with tabling
src/query.js          external raw-body query operation
src/format.js         text and JSON output
src/api.js            public JavaScript API and import merging
src/cli.js            command-line interface
tools/bundle.js       self-contained bundle generator
test/*.test.js        executable regression and conformance tests
examples/*.srl        runnable SRL examples
examples/*.ttl        RDF Rules / Turtle examples
```

A good reading order is `term.js`, `tokenizer.js`, `parser.js`, `rdfSyntax.js`, `store.js`, `builtins.js`, `analyze.js`, `engine.js`, then `api.js` and `cli.js`.

## Tests and build

```sh
npm test
npm run build
```

`npm run build` writes the command-line bundle to `eyeleng.js` and the browser API bundle to `dist/browser/eyeleng.browser.js`. In a browser, the bundle exposes `window.eyeleng`.

The tests are executable documentation. They cover parsing, recursion, filters, negation, assignment, typed/language literals, RDF 1.2 syntax, property paths, stratification, imports, queries, examples, deep taxonomy benchmarks, W3C SHACL Rules, W3C RDF syntax, and RDF/RDFS entailment.

## Examples

Examples live in [examples/](./examples/):

- `family.srl` — small recursive rules
- `negation.srl` — stratified negation
- `assignment.srl` — assignment and expressions
- `property-paths.srl` — path matching in bodies
- `basic-ruleset.ttl` — RDF Rules syntax
- `rdf-messages.srl` / `rdf-messages.trig` — RDF Message Log replay
- `deep-taxonomy-*.srl` — generated benchmark programs

## Known boundaries

Eyeleng intentionally remains a compact reasoner:

- it does not implement SHACL validation or validation reports
- it does not aim to be a full RDF database
- RDF Rules syntax support is a front-end for rule execution, not a shapes-validation layer
- property paths and SPARQL expressions are practical subsets
- W3C manifests are used as executable alignment tests, but implementation status should be read from the current test reports

## Extending Eyeleng safely

Preserve the pipeline:

```text
syntax -> AST/program -> analysis -> evaluation -> formatting
```

Avoid making the evaluator parse strings. Parsing belongs in `parser.js` or `rdfSyntax.js`. Avoid making the parser derive triples. Inference belongs in `engine.js`.

A safe extension usually needs:

1. syntax support
2. one focused example
3. parser/API tests
4. execution tests
5. README or handbook notes
6. bundle regeneration
