# eyeleng

[![npm version](https://img.shields.io/npm/v/eyeleng.svg)](https://www.npmjs.com/package/eyeleng)
[![DOI](https://img.shields.io/badge/DOI-10.5281%2Fzenodo.20342577-blue.svg)](https://doi.org/10.5281/zenodo.20342577)

The `leng` in `eyeleng` stands for **Logic Engine Next Generation**. Eyeleng is a compact JavaScript implementation of SHACL 1.2 Rules, aligned with the W3C Working Draft published 10 August 2026. Its main purpose is **automatic hybrid reasoning**: it combines forward materialization with tabled backward proving and automatically chooses how rules should be evaluated.

It supports two rule front-ends:

- **SRL** — the Shape Rules Language syntax used by the SHACL 1.2 Rules draft.
- **RDF Rules** — a Turtle/RDF syntax for rule sets.

Ordinary finite consequences are materialized with forward chaining. When a query or rule body demands a function-like predicate, the default planner can instead prove it just in time with a tabled backward prover. The implementation is deliberately small, readable as ordinary JavaScript, and usable from the CLI, Node.js, and the browser playground.

Eyeleng remains primarily a rules engine. Standards-based RDF parsing is delegated to `rdf-parse`, while SHACL conformance for `FOR ?v IN <shape>` is delegated to `shacl-engine`. The fully saturated closure can also be validated explicitly with `runAndValidateAsync(...)` or `--validate --shapes FILE`; validation is a separate post-rule phase.

## Why Eyeleng?

Eyeleng is a next-generation path for rule-based RDF reasoning: it combines a language being developed on the W3C standards track with an execution model that automatically uses both forward and backward reasoning.

The central choice is **SHACL 1.2 Rules instead of N3 as the native rule language**. SHACL 1.2 Rules is being developed by the W3C Data Shapes Working Group as a W3C Working Draft on the Recommendation track. It defines both an RDF representation of rule sets and the concise Shape Rules Language (SRL), together with `infer` and `query` operations. By contrast, the current N3 specification is a W3C Community Group Report. Community Group Reports are useful specifications, but they are not on the W3C standards track and are not W3C-endorsed standards.

That standards position does not require giving up the kinds of programs traditionally written in N3. The N3 examples translated to SRL or RDF Rules and tested with Eyeleng so far have retained their intended reasoning behavior. This is practical evidence that existing N3 rule programs can migrate to the SHACL Rules model, although Eyeleng does not parse N3 syntax directly and this is not yet a claim that every possible N3 extension has a translation.

Eyeleng also removes a choice that N3 engines commonly expose to the rule author. In EYE, Eyeling, and Eyeron, `=>` and `<=` explicitly select forward and backward rules. In Eyeleng, rules describe the logical relationship while the engine analyzes dependencies and demand. It materializes ordinary consequences forward and can prove safe, function-like predicates backward with tabling only when they are needed. This avoids exposing internal helper triples merely because they were required during a computation, while preserving forward closure where materialization is appropriate.

The related engines therefore mark stages and implementation choices rather than hard limits on what Eyeleng may replace:

| Project | Native language and runtime | Main reason to choose it |
| --- | --- | --- |
| **EYE** | N3 on SWI-Prolog | The mature, extensive N3 implementation and ecosystem |
| **Eyeling** | N3 implemented in JavaScript | Direct JavaScript and RDF-JS integration with explicit forward and backward N3 rules |
| **Eyeron** | N3 implemented in Rust, with native and WebAssembly APIs | Rust-native or WebAssembly deployment with N3 proofs and built-ins |
| **Eyeleng** | SHACL 1.2 SRL and RDF Rules implemented in JavaScript | A W3C Recommendation-track language plus automatic hybrid reasoning |

Choose Eyeleng when you want to:

- build new rule systems on SHACL 1.2 Rules rather than a Community Group language;
- migrate N3 reasoning workloads to SRL or RDF Rules;
- let the engine choose between materialization and goal-directed evaluation;
- use tabling for recursive, function-like computations without publishing their intermediate facts;
- combine stratified negation, dependency analysis, RDF 1.2 syntax, and rule execution in one compact engine;
- use the same RDF/JS-based implementation from a CLI, Node.js, or a browser build.

In short: **Eyeleng aims to carry the practical reasoning power demonstrated by the EYE family into SHACL 1.2 Rules, with automatic hybrid execution as the default rather than explicit reasoning direction as a language-level choice.**

Standards references: [SHACL 1.2 Rules](https://www.w3.org/TR/shacl12-rules/), [Notation3 Community Group](https://www.w3.org/groups/cg/n3-dev/), and [W3C document types](https://www.w3.org/standards/types/).

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

## How automatic hybrid reasoning works

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

External RDF input is parsed by [`rdf-parse`](https://github.com/rubensworks/rdf-parse.js/) into RDF/JS quads. SRL itself, including `DATA { ... }`, remains parsed by the SRL grammar so Eyeleng-specific generalized terms stay available there. The W3C RDF syntax harness therefore exercises `rdf-parse` directly rather than a second Eyeleng RDF grammar.

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

The focus variable is pre-bound to target focus nodes that conform to the referenced shape. Pass a SHACL shapes graph to the async API (or `--shapes` on the CLI) and Eyeleng uses `shacl-engine` to compute that eligible set. The set is evaluated against the graph at the start of the rule stratum and then frozen for that stratum.

```js
const { runAsync } = require('eyeleng');

const result = await runAsync(source, {
  shapes: shapesTurtle,
  shapesFilename: 'shapes.ttl'
});
```

`focusNodeResolver` remains available as an integration override for external validators or remote shape services. A custom `shapeEngine` may provide both `dependencies(shapeIRI)` and `eligibleFocusNodes(shapeIRI, context)`.

Shape dependencies become closed stratification edges: rules that can change predicates read by a shape run first, and cycles from a targeted rule back into its own shape dependencies are rejected. Targeted rules remain excluded from backward planning until the prover has an equivalent SHACL targeting gate.

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

The W3C harness in `src/rdfManifest.js` and `src/rdfEntailment.js` additionally covers:

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
```

`npm test` includes the W3C harnesses and prints progress test by test. Set `EYELENG_W3C_REQUIRED=0` to allow remote checks to be skipped when the W3C URLs are unavailable. The `*:earl` scripts print progress but write the EARL Turtle only to `reports/`.

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
./eyeleng.js https://example.org/rules.n3
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

RDF Rules and built-in SHACL targeting use the asynchronous API because `rdf-parse` is stream-based:

```js
const { runAsync } = require('./src/index.js');

const result = await runAsync(rdfRulesSource, {
  syntax: 'rdf',
  filename: 'rules.ttl',
  shapes: shapesSource,
  shapesFilename: 'shapes.ttl'
});
```

For SRL-only source, `parse`, `compile`, `run`, and `runToString` remain synchronous. External validators can be integrated with `focusNodeResolver`, or with a `shapeEngine` that also declares shape dependencies for stratification.

To perform the rule→shape composition discussed for SHACL 1.2, validate only after the complete rule closure has saturated:

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

The tests are executable documentation. They cover parsing, recursion, filters, negation, assignment, typed/language literals, RDF 1.2 syntax, property paths, stratification, imports, queries, examples, deep taxonomy benchmarks, W3C SHACL Rules, W3C RDF syntax, and RDF/RDFS entailment.

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

A safe extension usually needs:

1. syntax support
2. one focused example
3. parser/API tests
4. execution tests
5. README or handbook notes
6. bundle regeneration
