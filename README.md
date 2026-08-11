# eyeleng

[![npm version](https://img.shields.io/npm/v/eyeleng.svg)](https://www.npmjs.com/package/eyeleng)
[![DOI](https://img.shields.io/badge/DOI-10.5281%2Fzenodo.20342577-blue.svg)](https://doi.org/10.5281/zenodo.20342577)

The `leng` in `eyeleng` stands for **Logic Engine Next Generation**. Eyeleng is a compact JavaScript implementation of SHACL 1.2 Rules, aligned with the W3C Working Draft published 10 August 2026. Its main purpose is **automatic hybrid reasoning**: it combines forward materialization with tabled backward proving and automatically chooses how rules should be evaluated.

It supports two rule front-ends:

- **SRL** — the Shape Rules Language syntax used by the SHACL 1.2 Rules draft.
- **RDF Rules** — a Turtle/RDF syntax for rule sets.

Ordinary finite consequences are materialized with forward chaining. When a query or rule body demands a function-like predicate, the default planner can instead prove it just in time with a tabled backward prover. The implementation is deliberately small, readable as ordinary JavaScript, and usable from the CLI, Node.js, and the browser playground.

Eyeleng remains primarily a rules engine. Standards-based RDF parsing is delegated to [`rdf-parse`](https://github.com/rubensworks/rdf-parse.js/), while SHACL conformance and validation are delegated to [`shacl-engine`](https://github.com/rdf-ext/shacl-engine). Eyeleng adds the rule-specific layer between them: dependency analysis, shape-aware stratification, rule saturation, and optional validation of the completed closure.

## Why Eyeleng?

Eyeleng focuses on SHACL 1.2 rule execution rather than reimplementing the surrounding RDF and SHACL stack. It uses [rdf-parse](https://github.com/rubensworks/rdf-parse.js/) for standards-based RDF parsing and [shacl-engine](https://github.com/rdf-ext/shacl-engine) for SHACL validation and shape conformance. This keeps the implementation centered on rules, dependency analysis, and execution.

A key part of that execution model is **stratification**. Eyeleng analyzes dependencies between rules, negation, and referenced SHACL shapes before evaluation. Rules that can change predicates read by a shape are scheduled in earlier strata. A targeted `FOR ?v IN <shape>` rule therefore sees a stable shape state for its stratum, while cyclic rule/shape dependencies are rejected.

Use Eyeleng when you want to:

- run SHACL 1.2 Rules in SRL or RDF Rules syntax;
- combine forward materialization with tabled backward proving;
- use stratified negation and shape-aware dependency analysis;
- use SHACL shapes to gate targeted rules;
- validate the fully saturated closure after rule execution;
- work with RDF/JS from Node.js, the CLI, or the browser build.

Standards reference: [SHACL 1.2 Rules](https://www.w3.org/TR/shacl12-rules/).

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

Open the [Playground](https://eyereasoner.github.io/eyeleng/playground) for a browser UI with URL loading, autosave, share links, diagnostics, queries, and SRL/RDF Rules syntax selection. Run `npm install && npm run build` to bundle the RDF and SHACL dependencies for browser use.

## Reasoning and stratification

Eyeleng first analyzes dependencies, then evaluates rules stratum by stratum until the closure is stable:

```text
parse source
  ↓
analyze rule, negation, and shape dependencies
  ↓
evaluate each stratum to a fixpoint
  ↓
complete rule closure
  ↓
optional SHACL validation
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

Negation is handled by stratified evaluation: rules are grouped into dependency layers, and recursion through negation is rejected. Shape dependencies participate in the same analysis. If a rule can produce a predicate used by a referenced SHACL shape, that producer runs in an earlier stratum. A targeted rule therefore evaluates against a stable shape state, and a cycle in which a targeted rule can change its own shape conformance is rejected.

By default, run mode uses **auto-hybrid reasoning**. Ordinary rules are still materialized forward into the closure. Rules that behave like internal functions can instead be proved backward with tabling when their predicates occur as demanded body goals. For example, a Fibonacci helper predicate can be computed just in time for the public `:fib` results, without printing all intermediate helper triples. Use `--no-hybrid` or `{ hybrid: false }` to force pure forward materialization, and use `--hybrid` or `{ hybrid: true }` to force more aggressive backward orientation.

For explicit `--query` / `--query-file` use, the query body is the top-level goal. Each triple pattern in that body is then a sub-goal that may be answered by the backward prover. If pure backward proving is not safe for the demanded predicates, query mode can run a hybrid plan and finally fall back to ordinary forward closure.

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
- targeted SRL rules using `FOR ?focus IN <shape>` in the positions defined by the current grammar
- variables such as `?x`
- IRIs, prefixed names, blank nodes, literals, RDF collections, and RDF 1.2 triple terms
- Turtle-style `;`, `,`, `a`, blank-node property lists, lists, annotations, and reifiers where supported
- property paths in rule bodies
- language tags, base-direction literals, and common XML Schema datatypes
- SRL and RDF Rules syntax front-ends

External RDF input is parsed by [`rdf-parse`](https://github.com/rubensworks/rdf-parse.js/) into RDF/JS quads. SRL, including `DATA { ... }`, is parsed by the SRL grammar.

### SHACL-targeted rules (`FOR`)

The 10 August 2026 Working Draft adds an optional `FOR ?v IN <shape>` clause. In the current published grammar, the clause follows the head template in the `RULE ... WHERE` form and precedes the body in the `IF ... THEN` form:

```srl
PREFIX : <http://example/>

RULE { ?this :status :adult }
FOR ?this IN :AdultShape
WHERE { ?this :age ?age . FILTER(?age >= 18) }

IF FOR ?this IN :AdultShape { ?this :active true }
THEN { ?this :seen true }
```

The focus variable is pre-bound to target focus nodes that conform to the referenced shape. With a SHACL shapes graph, Eyeleng uses [`shacl-engine`](https://github.com/rdf-ext/shacl-engine) to compute those nodes. The eligible set is evaluated at the start of the rule stratum and remains fixed for that stratum.

```js
const { runAsync } = require('eyeleng');

const result = await runAsync(source, {
  shapes: shapesTurtle,
  shapesFilename: 'shapes.ttl'
});
```

`focusNodeResolver` remains available as an integration override. A custom `shapeEngine` may provide both `dependencies(shapeIRI)` and `eligibleFocusNodes(shapeIRI, context)`.

Shape dependencies become closed stratification edges: producers of predicates read by a shape run first, and cycles from a targeted rule back into its own shape dependencies are rejected. Targeted rules are not backward-planned.

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

Eyeleng does not maintain a second standards-RDF grammar. `src/rdfSyntax.js` adapts `rdf-parse` RDF/JS quads to Eyeleng's program model, so supported concrete syntaxes follow the installed `rdf-parse` version.

SRL remains a distinct language and continues to parse its own `DATA { ... }` blocks, including Eyeleng's generalized SRL term surface.

SHACL Rules conformance checks:

```sh
npm run w3c:rules
npm run w3c:rules:json
npm run w3c:rules:earl
```

`npm test` includes the W3C SHACL Rules harness and prints progress test by test. Set `EYELENG_W3C_REQUIRED=0` to allow remote checks to be skipped when the W3C URLs are unavailable. The `w3c:rules:earl` script prints progress but writes the EARL Turtle only to `reports/`.

The official Eyeleng EARL 1.0 report for the W3C SHACL 1.2 Rules manifest is in [reports/w3c-shacl12-rules-earl.ttl](./reports/w3c-shacl12-rules-earl.ttl).

## RDF Message Logs

Eyeleng can parse RDF Message Logs and expose a replay view under the `eymsg:` vocabulary. A message log starts with `VERSION "1.2-messages"` and separates payloads with `MESSAGE` or `@message .`.

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

```text
Usage: eyeleng [options] [file-or-url|- ...]
```

With no input arguments, Eyeleng prints help. Pass `-` to read from standard input; local files and HTTP(S) URLs can be combined as positional inputs.

Common commands:

```sh
./eyeleng.js examples/family.srl
./eyeleng.js --all examples/family.srl
./eyeleng.js --check --deps examples/stratified-negation.srl
./eyeleng.js --json --prove --stats examples/if-then.srl
./eyeleng.js --query-file examples/query-body.txt examples/query.srl
./eyeleng.js --syntax rdf examples/w3c-rule-set-snippet.ttl
cat examples/family.srl | ./eyeleng.js -
./eyeleng.js https://example.org/rules.ttl
```

Important options:

```text
--all                 print the full closure, including input facts
--json                print JSON instead of compact triples/bindings
--prove               print proof explanations
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
--shapes FILE         SHACL shapes graph used by FOR ?v IN <shape>
--validate            validate the saturated closure against --shapes
--version             print version
-h, --help            print help
```

## Public API

### Synchronous SRL API

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

Hybrid and query mode:

```js
const { run, runQuery, formatBindings } = require('./src/index.js');

// Normal run mode defaults to conservative auto-hybrid reasoning.
// Ordinary output rules still materialize forward, while selected
// function-like helper predicates can be proved backward on demand.
const resultWithAutoHybrid = run(source);

// Force pure forward closure if you want every derivable helper fact materialized.
const pureForward = run(source, { hybrid: false });

// For explicit queries, the whole raw body is the top-level goal.
// Each triple pattern in that body is a sub-goal for the planner.
const result = runQuery(source, '?x :ancestorOf ?y');
console.log(formatBindings(result.query.bindings, result.prefixes));

// queryMode defaults to auto: try tabled backward proving for demanded
// predicates, then hybrid execution, then ordinary forward closure.
const justInTime = runQuery(source, ':alice :computedValue ?value');

// Force the tabled backward prover for supported query shapes.
const backwardOnly = runQuery(source, ':alice :computedValue ?value', { queryMode: 'backward' });
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

### Asynchronous RDF and SHACL API

RDF Rules and SHACL integration use the asynchronous API because `rdf-parse` is stream-based:

```js
const { runAsync } = require('./src/index.js');

const result = await runAsync(rdfRulesSource, {
  syntax: 'rdf',
  filename: 'rules.ttl',
  shapes: shapesSource,
  shapesFilename: 'shapes.ttl'
});
```

For SRL-only source, `parse`, `compile`, `run`, and `runToString` remain synchronous. A custom `shapeEngine` can override SHACL focus-node resolution and dependency discovery.

For Rule→Shape composition, validate after the complete rule closure has saturated:

```js
const { runAndValidateAsync } = require('./src/index.js');

const result = await runAndValidateAsync(ruleSource, {
  shapes: shapesSource,
  shapesFilename: 'shapes.ttl'
});

console.log(result.validationReport.conforms);
```

The equivalent CLI command is:

```sh
./eyeleng.js --shapes shapes.ttl --validate rules.srl
```

A non-conforming validation report makes the CLI exit with status 1.

The API returns structured parsed programs, diagnostics, inferred triples, closure triples, traces, stats, query bindings, and—when requested—a SHACL validation report.

## Project layout

```text
src/tokenizer.js      source text -> tokens
src/parser.js         SRL parser -> program object
src/rdfSyntax.js      rdf-parse adapter + RDF Rules graph-to-program mapping
src/shacl.js          shacl-engine adapter, targets, and shape dependencies
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
tools/bundle.js       CLI/browser bundle generator
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

The tests are executable documentation. They cover parsing, recursion, filters, negation, assignment, typed/language literals, RDF 1.2 syntax, property paths, stratification, imports, queries, examples, deep taxonomy benchmarks, and W3C SHACL Rules.

## Examples

Examples live in [examples/](./examples/):

- `family.srl` — small recursive rules
- `negation.srl` — stratified negation
- `assignment.srl` — assignment and expressions
- `property-paths.srl` — path matching in bodies
- `basic-ruleset.ttl` — RDF Rules syntax
- `rdf-messages.srl` / `rdf-messages.trig` — RDF Message Log replay
- `fibonacci.srl` — fast-doubling Fibonacci using just-in-time backward helper predicates
- `deep-taxonomy-*.srl` — generated benchmark programs

## Known boundaries

Eyeleng intentionally remains a compact reasoner:

- SHACL semantics are delegated to `shacl-engine`; Eyeleng does not reimplement them.
- Built-in `FOR` focus-node discovery covers SHACL Core targets. Custom or SPARQL targets require `customTargetResolver` for targeted rules.
- Shape dependency extraction is conservative: closed shapes, SPARQL constraints, and custom targets become wildcard dependencies.
- The default composition is **rules saturate → shapes validate**. Arbitrary Rule→Shape→Rule interleaving is not supported as language syntax.
- Eyeleng is not a full RDF database.
- RDF Rules syntax is a front-end for rule execution.
- Property paths and SPARQL expressions are practical subsets.
- W3C manifests are executable alignment tests; consult the current reports for implementation status.

## Extending Eyeleng safely

Preserve the pipeline:

```text
syntax -> AST/program -> analysis -> evaluation -> formatting
```

Avoid making the evaluator parse strings. Parsing belongs in `parser.js` or `rdfSyntax.js`. Avoid making the parser derive triples. Inference belongs in `engine.js`.

A safe extension usually needs syntax support, a focused example, parser/API and execution tests, documentation, and bundle regeneration.
