# SPARQL 1.2 RL examples

These examples are executable `.srl` rule sets for Eyeleng's SPARQL 1.2 RL implementation.

Embedded `DATA { ... }` blocks contribute facts to the inference graph. For an external RDF 1.2 base graph, use the CLI `--data FILE` option or pass `baseGraph` through the API after parsing it with `parseRdfDocument`.

For the RDF Message Log example, run:

```sh
node eyeleng.js --data examples/rdf-messages.trig examples/rdf-messages.srl
```

The message log is base data. `IMPORTS` is reserved for SPARQL-RL rule sets.

`output/` holds each example's expected result graph as an `.srl` file, and
`proof/` its expected `--prove` document — itself an `.srl` rule set, whose
`DATA` block reifies one step per derived fact. The four rejection examples
have their expected `--check` message in `output/*.txt` instead. Regenerate
every golden with:

```sh
UPDATE_EXAMPLE_GOLDENS=1 npm test
```
