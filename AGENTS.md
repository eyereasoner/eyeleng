# Working on eyeleng

eyeleng is a JavaScript implementation of SPARQL 1.2 RL (SRL), with RDF 1.2
input, forward inference, backward queries, and proof output and checking.
It runs as a command-line program, a Node.js library, and a browser
application. Describe what it implements as it currently is, distinguish
demonstrated behavior from design goals, and keep diagnostics specific and
user-facing text direct.

## Repository map

- `src/`: source modules, all directly in this directory.
  - `tokenizer.js`, `parser.js`: SRL syntax and raw query-body parsing.
  - `term.js`, `store.js`: RDF terms, bindings, graph indexes, and matching.
  - `analyze.js`: sequential variable scope, dependencies, and stratification.
    `assignments.js` classifies run-once rules.
  - `engine.js`: synchronous and asynchronous forward evaluation.
    `backward.js`, `query.js`: backward planning and query evaluation.
  - `builtins.js`, `aggregates.js`: expressions and aggregate functions.
  - `rdf.js`, `rdfMessages.js`: RDF 1.2 and RDF Message Log input.
  - `format.js`, `output.js`: result and proof rendering.
    `check-proof.js`: proof reader and checker.
  - `api.js`: compilation, imports, and public operations; `index.js`
    exports the API. `cli.js` implements the command line.
  - `sparqlRlManifest.js`: W3C manifest parsing, execution, and EARL output.
- `eyeleng.js`, `dist/browser/`: committed CLI and browser bundles generated
  by `tools/bundle.js`. Edit `src/` and rebuild rather than editing bundles.
- `playground.html`: browser playground; the build refreshes its bundled
  fallback examples. `index.html` renders the root README on GitHub Pages.
- `examples/*.srl`: runnable programs. `examples/output/` holds result
  goldens (`.srl`) and rejection diagnostics (`.txt`); `examples/proof/`
  holds proof goldens. `examples/README.md` describes companion inputs.
- `test/`: local API, CLI, built-in, browser-bundle, example, proof, and SRL
  regression suites, plus the W3C harness entry point. `test/run.js` lists
  suites explicitly; register a new suite there.
- `tools/`: bundle generation, W3C runner, and performance benchmarks.
  `reports/w3c-sparql-rl-earl.ttl` is the saved conformance report.
- `README.md`: language status, CLI, API, graph model, and architecture.
- `release`, `.github/workflows/`: releases, Pages deployment, npm
  publishing, and GitHub releases.

## Commands

```sh
npm install
npm run build                          # rebuild CLI and browser bundles
node eyeleng.js examples/socrates.srl
node eyeleng.js --prove examples/socrates.srl
node eyeleng.js --check --deps examples/stratified-negation.srl
npm run test:api
node test/group-aggregates.test.js
npm run test:examples
npm run test:check-proof
npm test                               # build, then every registered suite
npm run w3c:sparql-rl                   # W3C tests and saved EARL report
npm run bench                          # compare timing with the baseline
git diff --check
```

Node.js 18 or later is required. The W3C suite fetches its manifests and
test files over the network; it is required by default. Set
`EYELENG_SPARQL_RL_MANIFEST` to use another manifest URL.
`EYELENG_W3C_REQUIRED=0` permits skipping the suite when the network is
unavailable; report that skip instead of claiming W3C tests passed.
`npm run w3c:sparql-rl -- --no-report` runs without rewriting the EARL file.

Large taxonomies produce very large results and proofs. Redirect them to a
temporary file and inspect focused parts. Run benchmarks on a quiet machine
without concurrent builds or other heavy jobs. `npm run bench:report`
prints timings without changing the baseline; update the baseline with
`npm run bench:update` only after reviewing an intentional change.

## Language and examples

- The W3C SPARQL 1.2 RL specification is the language authority:
  <https://www.w3.org/TR/sparql12-rl/>. README records the tracked draft.
  Read its relevant grammar and evaluation sections before changing language
  behavior, and keep the implementation, documentation, and tests consistent.
- SRL uses `RULE ... WHERE ...`, `SET`, `NOT`, and `GROUP`. Do not import
  N3 syntax or sibling-engine extensions into the conforming grammar.
- Keep the external base graph separate from the inference graph. `DATA`
  blocks contribute to inference; `WHERE DATA` and `NOT DATA` match only the
  immutable external base graph and introduce no rule dependencies.
- Preserve sequential variable scope, open and closed dependencies, and
  run-once classification. Negation and aggregation must see completed
  producer strata. Group patterns receive only their incoming group keys;
  their local variables do not escape. Aggregate input retains multiplicity.
- Keep synchronous and asynchronous evaluation consistent. Unsupported
  backward-query features fall back to forward evaluation in automatic mode;
  explicit backward mode reports unsupported cases.
- `IMPORTS` incorporates SRL rule sets, including their data blocks. External
  RDF and RDF Message Logs are separate base-data inputs. Preserve cyclic
  import handling and errors for unsupported or unresolved imports.
- Every example starts with a short comment explaining the situation,
  conclusions, and language feature for a wide audience. Describe the example
  as it is, without project provenance.
- Ordinary example tests read goldens. After intentional output changes,
  rebuild, run `UPDATE_EXAMPLE_GOLDENS=1 npm run test:examples`, and review
  the result and proof diffs. Large taxonomies and selected large examples
  deliberately omit proof goldens; respect the exclusions in the harness.

## Implementation and verification

Match the surrounding JavaScript: naming, comment density, and comments that
say why. Prefer small, direct changes over new machinery, and fix the code
that produces a wrong result rather than patching its output.

Proof checking must stay sound: a forged proof must never be reported as
checked. The current checker reports C1–C4, defined in `src/check-proof.js`;
do not claim the broader contracts of sibling projects. Check recorded
evidence against the compiled source rules, without calling the evaluator
to fill gaps. For proof-checking changes, add a forged proof the checker
rejects and confirm that the packaged proofs still check.

eyeleng, eyeling, eyeron, and eyeprolog are one family. Check whether shared
RDF, parsing, or proof fixes apply across projects, while deciding SRL
semantics from its own specification.

Run focused tests while working, then `npm test` before finishing code
changes. Add a regression for each meaningful behavior change in the
appropriate suite. Rebuild committed bundles after source changes so the
CLI, library, and playground agree. Run the performance benchmark after
engine or indexing changes. Documentation-only edits need a review and
`git diff --check`; documentation describes current behavior, not its history.

## Versions and releases

Commit directly to `main`. Do not use closing keywords such as `Fixes #N`
in commit messages; issues are closed by hand. Follow the user's
instructions about committing, pushing, and releasing.

`package.json` is the version source; never bump it by hand. Releases are
cut with the release script after `npm test` has passed:

```sh
./release patch "<release message>"
./release minor "<release message>"
./release major "<release message>"
```

The script switches to `main`, pulls with `--ff-only`, bumps the version
with `npm version`, stages every change, commits, creates an annotated
`v*` tag, and pushes the branch and tag. npm's lifecycle hooks run tests
before the version bump and rebuild bundles afterward. Review the complete
working tree first because the script stages everything. A push to `main`
deploys GitHub Pages; a `v*` tag creates the GitHub release and publishes
the package to npm.
