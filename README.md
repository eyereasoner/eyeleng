# eyeleng

[![npm version](https://img.shields.io/npm/v/eyeleng.svg)](https://www.npmjs.com/package/eyeleng)
[![DOI](https://img.shields.io/badge/DOI-10.5281%2Fzenodo.20342577-blue.svg)](https://doi.org/10.5281/zenodo.20342577)

`eyeleng` is a JavaScript implementation of SHACL 1.2 Rules, including SRL and RDF Rules syntax front-ends.

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

Status: Eyeleng runs a growing implementation of the SHACL 1.2 Rules draft surface. It is not a conformance claim and does not implement SHACL validation.
