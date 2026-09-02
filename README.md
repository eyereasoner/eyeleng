# Eyeleng

**Eyeleng** is a JavaScript implementation of **SPARQL 1.2 RL (SRL)**, following the W3C Recommendation-track specification at <https://www.w3.org/TR/sparql12-rl/>.

> Status: SPARQL 1.2 RL is currently a W3C Working Draft. Eyeleng tracks the current specification and may change as the specification advances.

## Features

- SPARQL 1.2 RL rule sets using `.srl` and media type `application/sparql-rl`.
- `srl:` namespace `http://www.w3.org/ns/sparql-rl#`.
- RDF 1.2 data input through [`rdf-parse`](https://github.com/rubensworks/rdf-parse.js/) 5.x.
- Open/closed dependency analysis and stratification.
- Run-once handling for rules containing `SET` or blank nodes in the head.
- Local rule-set imports through `IMPORTS`.
- Forward inference plus direct backward query evaluation.
- CLI, JavaScript API, browser bundle, examples, and W3C conformance harness.

## Graph model

Eyeleng distinguishes the two graphs used by SPARQL 1.2 RL:

- **base graph** — external RDF supplied by the caller, for example with `--data`; `WHERE DATA` and `NOT DATA` match this graph only;
- **inference graph** — starts with triples from SRL `DATA { ... }` blocks and grows with rule conclusions.

Normal rule bodies participate in rule evaluation over the available data, while ground-data clauses remain pinned to the base graph.

## Rule syntax

Eyeleng follows the current SPARQL 1.2 RL grammar: rules use `RULE ... WHERE ...`. Legacy `IF ... THEN` and `FOR ?var IN ...` forms are rejected.

## Install and build

```sh
npm install
npm run build
npm test
```

The build produces the standalone CLI (`eyeleng.js`) and browser bundle.

## CLI

Run a rule set containing its own `DATA` facts:

```sh
node eyeleng.js examples/family.srl
```

Use an RDF 1.2 document as the immutable base graph:

```sh
node eyeleng.js --data facts.ttl rules.srl
```

`--data` may be repeated. `rdf-parse` determines the RDF concrete syntax from the filename/content type and parses it in RDF 1.2 mode.

Important options:

```text
--data FILE             Add an RDF 1.2 document to the immutable base graph (repeatable)
--all                   Print base graph plus inference graph
--json                  Print JSON instead of compact triples/bindings
--prove                 Print proof explanations
--stats                 Print iteration and triple counts to stderr
--check                 Parse, check well-formedness, and stratify only
--strict                Treat warnings as errors
--deps                  Print open/closed rule dependencies during --check
--query TEXT            Run a raw SRL body pattern
--query-file FILE       Read a raw SRL body pattern from a file
--query-mode MODE       Use auto, forward, or backward query planning (default auto)
--max-iterations N      Stop after N fixpoint iterations within a stratum
--no-imports            Reject rule sets containing IMPORTS
--rdf-messages          Treat --data input as an RDF Message Log
--include-message-facts Include payload facts while parsing RDF Message Logs
--version               Print version
```

Run `node eyeleng.js --help` for the complete list.

## JavaScript API

SRL parsing and evaluation are synchronous when all data is embedded in the rule set:

```js
const { run } = require('./src/index.js');

const result = run(`
PREFIX : <http://example/>
DATA { :alice :parentOf :bob . }
RULE { ?y :childOf ?x } WHERE { ?x :parentOf ?y }
`);

console.log(result.inferred);
```

For an external RDF base graph, parse RDF asynchronously through `rdf-parse` and pass the resulting triples to the rule engine:

```js
const fs = require('node:fs');
const {
  parseRdfDocument,
  runAsync,
} = require('./src/index.js');

const rdfSource = fs.readFileSync('facts.ttl', 'utf8');
const { triples } = await parseRdfDocument(rdfSource, {
  filename: 'facts.ttl',
  baseIRI: 'file:///absolute/path/facts.ttl',
});

const rules = fs.readFileSync('rules.srl', 'utf8');
const result = await runAsync(rules, { baseGraph: triples });
console.log(result.inferred);
```

### Imports

`IMPORTS` incorporates SPARQL-RL rule sets. The embedding application may provide an import resolver; the CLI resolves local `file:` imports.

RDF data is supplied separately as the base graph with `--data` or `baseGraph`. Unsupported, unresolved, or non-SRL imports are rejected.

## RDF Message Logs

RDF Message Logs are supported as an ancillary base-data input:

```sh
node eyeleng.js --data examples/rdf-messages.trig examples/rdf-messages.srl
```

Use `--rdf-messages` to force message-log interpretation when no version announcement is present. `--include-message-facts` also exposes payload facts while parsing the log.

Message logs are data inputs, not importable rule sets.

## Conformance tests

Run the SPARQL 1.2 RL W3C test harness with:

```sh
npm run w3c:sparql-rl
npm run w3c:sparql-rl:json
npm run w3c:sparql-rl:earl
```

The harness covers syntax, well-formedness, stratification, and evaluation tests from the W3C SPARQL-RL test suite.

## Project layout

```text
src/parser.js              SPARQL 1.2 RL concrete syntax
src/analyze.js             well-formedness, open/closed dependencies, stratification
src/assignments.js         run-once classification
src/engine.js              forward evaluation and graph separation
src/rdf.js                 RDF 1.2 -> internal terms via rdf-parse
src/api.js                 public API, imports, RDF Message Log support
src/sparqlRlManifest.js    W3C SPARQL-RL test harness
src/cli.js                 command-line interface
examples/*.srl             executable SPARQL 1.2 RL examples
test/                      local tests plus W3C harness entry point
```

## Architecture

Eyeleng owns rule-language parsing, well-formedness checks, dependency and stratification analysis, and evaluation. RDF 1.2 document parsing is delegated to `rdf-parse` and converted from RDF/JS terms in `src/rdf.js`.
