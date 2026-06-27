# eyeleng

[![npm version](https://img.shields.io/npm/v/eyeleng.svg)](https://www.npmjs.com/package/eyeleng)
[![DOI](https://img.shields.io/badge/DOI-10.5281%2Fzenodo.20342577-blue.svg)](https://doi.org/10.5281/zenodo.20342577)

`eyeleng` stands for **EYE Logic Engine**. Eyeleng is a JavaScript implementation of SHACL 1.2 Rules, including SRL and RDF Rules syntax front-ends.

## Quick start

```sh
npm test
./eyeleng.js examples/family.srl
./eyeleng.js examples/spec-2-2-recursion.srl
./eyeleng.js examples/deep-taxonomy-100.srl
./eyeleng.js examples/basic-ruleset.ttl
./eyeleng.js --syntax rdf examples/w3c-rule-set-snippet.ttl
./eyeleng.js --check --deps examples/stratified-negation.srl
```

## Read next

Read [Handbook](https://eyereasoner.github.io/eyeleng/HANDBOOK) for the full explanation of Eyeleng as code and as a reasoning machine.

Open [Playground](https://eyereasoner.github.io/eyeleng/playground) for a self-contained browser playground with URL loading, autosave, share links, diagnostics, queries, and SRL/RDF Rules syntax selection.

`npm run build` writes the command-line bundle to `eyeleng.js` and the browser API bundle to `dist/browser/eyeleng.browser.js`. In a browser, the bundle exposes the API as `window.eyeleng`.

The examples live in [examples/](./examples/) at one level. Draft SRL examples are named `spec-*.srl`, RDF Rules syntax examples use `.ttl`, and deep taxonomy benchmarks are named `deep-taxonomy-*.srl`.

Status: Eyeleng runs a growing implementation of the SHACL 1.2 Rules draft surface. It does not implement SHACL validation.

The official Eyeleng EARL 1.0 test report for the W3C SHACL 1.2 Rules manifest is in [reports/w3c-shacl12-rules-earl.ttl](./reports/w3c-shacl12-rules-earl.ttl). It records 88/88 passing tests for `https://w3c.github.io/data-shapes/shacl12-test-suite/tests/rules/manifest-rules.ttl`.


## W3C RDF syntax and semantics manifests

Eyeleng now integrates the grammar-hardened RDF syntax work into its normal `src/rdfSyntax.js` / `src/rdfManifest.js` structure, and adds a small RDF/RDFS entailment runner in `src/rdfEntailment.js`. The W3C RDF checks are therefore part of the same parser/reasoner discipline as the RDF Rules front-end.

```sh
npm run w3c:rules
npm run w3c:rdf
npm run w3c:all
npm run w3c:rdf:json
npm run w3c:rdf:earl
```

`npm test` includes both W3C harnesses. When the W3C URLs are reachable, progress is printed test by test. In offline environments, the remote W3C checks are reported as unreachable unless `EYELENG_W3C_REQUIRED=1` is set.

The RDF harness covers N-Triples, N-Quads, Turtle, and TriG RDF 1.1/1.2 parser syntax/eval manifests, plus the RDF-MT and RDF 1.2 Semantics entailment manifests. Entailment tests are evaluated under their declared `mf:entailmentRegime` (`simple`, `RDF`, or `RDFS`) with their declared recognized datatypes.


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

Use it directly, import it from SRL, or force message-log parsing from the CLI:

```sh
./eyeleng.js examples/rdf-messages.srl
./eyeleng.js --rdf-messages --all examples/rdf-messages.trig
./eyeleng.js --stream-messages --all examples/rdf-messages.trig
```

The replay data includes `eymsg:RDFMessageStream`, `eymsg:MessageEnvelope`, offsets, next-envelope links, payload kind, payload graph, and `eymsg:payloadTriple` triple terms. Blank-node labels are scoped per message. For Eyeleng, each payload graph is represented as a closed list of RDF 1.2 triple terms via `log:nameOf`, plus direct `eymsg:payloadTriple` links for convenient SRL rules.
