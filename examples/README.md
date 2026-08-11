# SHACL 1.2 Rules examples

This directory contains runnable SRL and RDF Rules examples, including files based on the SHACL 1.2 Rules draft.

- `.srl` files exercise the Shape Rules Language syntax.
- `.ttl` files exercise the RDF Rules syntax front-end.

All `.srl` and `.ttl` files in this directory are run by `test/examples.test.js`; most have golden TriG outputs in `examples/output/*.trig`.

For a minimal starting point, `socrates.srl` derives that Socrates is mortal from the fact that Socrates is human and a rule stating that humans are mortal.
