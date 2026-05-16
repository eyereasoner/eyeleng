# eyesharl

`eyesharl` is a JavaScript implementation of SHACL 1.2 Rules, including SRL and RDF Rules syntax front-ends.

## Quick start

```sh
npm test
./eyesharl.js examples/family.srl
./eyesharl.js examples/spec-2-2-recursion.srl
./eyesharl.js examples/deep-taxonomy-100.srl
./eyesharl.js examples/basic-ruleset.ttl
./eyesharl.js --syntax rdf examples/w3c-rule-set-snippet.ttl
./eyesharl.js --check --deps examples/stratified-negation.srl
```

## Read next

Read [Handbook](https://eyereasoner.github.io/eyesharl/HANDBOOK) for the full explanation of Eyesharl as code and as a reasoning machine.

Open [Playground](https://eyereasoner.github.io/eyesharl/playground) for a self-contained browser playground with URL loading, autosave, share links, diagnostics, queries, and SRL/RDF Rules syntax selection.

`npm run build` writes the command-line bundle to `eyesharl.js` and the browser API bundle to `dist/browser/eyesharl.browser.js`. In a browser, the bundle exposes the API as `window.eyesharl`.

The examples live in [examples/](./examples/) at one level. Draft SRL examples are named `spec-*.srl`, RDF Rules syntax examples use `.ttl`, and deep taxonomy benchmarks are named `deep-taxonomy-*.srl`.

Status: Eyesharl runs a growing implementation of the SHACL 1.2 Rules draft surface. It is not a conformance claim and does not implement SHACL validation.
