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

Read [HANDBOOK.md](./HANDBOOK.md) for the full explanation of Eyesharl as code and as a reasoning machine.

The examples live in [examples/](./examples/) at one level. Draft SRL examples are named `spec-*.srl`, RDF Rules syntax examples use `.ttl`, and deep taxonomy benchmarks are named `deep-taxonomy-*.srl`.

Status: Eyesharl runs a growing implementation of the SHACL 1.2 Rules draft surface. It is not a conformance claim and does not implement SHACL validation.
