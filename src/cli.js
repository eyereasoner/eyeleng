'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const {
  compile,
  evaluate,
  parseQuery,
  queryResult,
  queryProgram,
  queryRunOptions,
  formatTriples,
  formatProof,
  formatBindings,
  toJSON,
  resultTriples,
} = require('./api.js');
const { compactIRI } = require('./term.js');

function readPackageVersion() {
  const candidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, 'package.json'),
  ];
  for (const filename of candidates) {
    try {
      return JSON.parse(fs.readFileSync(filename, 'utf8')).version;
    } catch (_) {
      // Try the next location.
    }
  }
  return '0.0.0';
}

const VERSION = readPackageVersion();

function legacyHelp() {
  return `eyeleng ${VERSION}\n\nA dependency-free JavaScript implementation experiment for the SHACL 1.2 Rules draft, including SRL and RDF Rules syntax front-ends.\n\nUsage:\n  eyeleng [options] [file ...]\n\nOptions:\n  --all                 Print the full closure, including input facts\n  --json                Print JSON instead of compact triples/bindings\n  --trace               Print derivation trace to stderr, or include it in JSON\n  --stats               Print iteration and triple counts to stderr\n  --check               Parse and analyze only; do not run rules\n  --strict              Treat static warnings as errors, including recursive term generation\n  --deps                Print rule dependency edges during --check\n  --query TEXT          Run a raw SRL body pattern over the closure or backward planner\n  --query-file FILE     Read a raw SRL body pattern from a file\n  --query-mode MODE     Use auto, forward, or backward query planning (default auto)\n  --hybrid              Force aggressive hybrid orientation for function-like rules\n  --no-hybrid           Disable automatic hybrid forward/backward execution\n  --max-iterations N    Stop after N fixpoint iterations within a recursive layer\n  --no-imports          Parse IMPORTS/owl:imports but do not load imported rule sets\n  --rdf-messages        Parse input as an RDF Message Log\n  --include-message-facts Include payload facts while parsing RDF Message Logs\n  --syntax MODE         Use srl, rdf, or auto syntax detection (default auto)\n  --ruleset TERM        In RDF syntax, run only the selected srl:RuleSet\n  --version             Print version\n  -h, --help            Print this help\n\nWith no file arguments, eyeleng reads from stdin.\n`;
}

function help() {
  return legacyHelp().replace(
    '  --trace               Print derivation trace to stderr, or include it in JSON',
    '  --prove               Print proof explanations',
  ).replace(
    'Usage:\n  eyeleng [options] [file ...]',
    'Usage: eyeleng [options] [file-or-url.n3|- ...]',
  ).replace(
    'With no file arguments, eyeleng reads from stdin.',
    'With no input arguments, eyeleng prints this help. Use - to read from stdin.',
  );
}

function parseArgs(argv) {
  const options = {
    all: false,
    json: false,
    prove: false,
    stats: false,
    check: false,
    strict: false,
    deps: false,
    query: null,
    queryFile: null,
    queryMode: 'auto',
    hybrid: 'auto',
    maxIterations: 10000,
    imports: true,
    syntax: 'auto',
    ruleSet: null,
    rdfMessages: false,
    includeMessageFacts: false,
  };
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') options.all = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--prove') options.prove = true;
    else if (arg === '--stats') options.stats = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--deps') options.deps = true;
    else if (arg === '--no-imports') options.imports = false;
    else if (arg === '--hybrid') options.hybrid = true;
    else if (arg === '--no-hybrid') options.hybrid = false;
    else if (arg === '--rdf-messages') options.rdfMessages = true;
    else if (arg === '--include-message-facts') options.includeMessageFacts = true;
    else if (arg === '--syntax') {
      i += 1;
      if (i >= argv.length) throw new Error('--syntax requires srl, rdf, or auto');
      options.syntax = argv[i];
      if (!['srl', 'rdf', 'auto'].includes(options.syntax)) throw new Error('--syntax requires srl, rdf, or auto');
    } else if (arg === '--ruleset') {
      i += 1;
      if (i >= argv.length) throw new Error('--ruleset requires an RDF term');
      options.ruleSet = argv[i];
    } else if (arg === '--query-mode') {
      i += 1;
      if (i >= argv.length) throw new Error('--query-mode requires auto, forward, or backward');
      options.queryMode = argv[i];
      if (!['auto', 'forward', 'backward'].includes(options.queryMode)) throw new Error('--query-mode requires auto, forward, or backward');
    } else if (arg === '--query') {
      i += 1;
      if (i >= argv.length) throw new Error('--query requires a value');
      options.query = argv[i];
    } else if (arg === '--query-file') {
      i += 1;
      if (i >= argv.length) throw new Error('--query-file requires a file');
      options.queryFile = argv[i];
    } else if (arg === '--max-iterations') {
      i += 1;
      if (i >= argv.length) throw new Error('--max-iterations requires a value');
      options.maxIterations = Number(argv[i]);
      if (!Number.isInteger(options.maxIterations) || options.maxIterations < 1) throw new Error('--max-iterations must be a positive integer');
    } else if (arg === '--version') {
      options.version = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-') {
      files.push(arg);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option ${arg}`);
    } else {
      files.push(arg);
    }
  }
  if (options.query && options.queryFile) throw new Error('Use either --query or --query-file, not both');
  return { options, files };
}

async function readInput(files, fetchImpl = globalThis.fetch) {
  const inputs = [];
  let readStdin = false;
  for (const spec of files) {
    if (spec === '-') {
      if (readStdin) throw new Error('Standard input (-) may only be specified once');
      readStdin = true;
      inputs.push({ source: fs.readFileSync(0, 'utf8'), filename: '<stdin>', baseIRI: null });
    } else if (/^https?:\/\//i.test(spec)) {
      if (typeof fetchImpl !== 'function') throw new Error(`Cannot fetch URL ${spec}: fetch is unavailable`);
      const response = await fetchImpl(spec);
      if (!response.ok) throw new Error(`Cannot fetch URL ${spec}: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
      inputs.push({ source: await response.text(), filename: spec, baseIRI: spec });
    } else {
      const filename = path.resolve(spec);
      inputs.push({ source: fs.readFileSync(filename, 'utf8'), filename, baseIRI: pathToFileURL(filename).href });
    }
  }
  if (inputs.length === 1) return inputs[0];
  return { source: inputs.map((input) => input.source).join('\n'), filename: '<input>', baseIRI: null };
}

function createFileImportResolver() {
  return function importResolver(target) {
    if (!target.startsWith('file:')) throw new Error(`Cannot import remote URL ${target}; this self-contained CLI only loads file: imports`);
    const filename = fileURLToPath(target);
    return {
      source: fs.readFileSync(filename, 'utf8'),
      options: { filename, baseIRI: pathToFileURL(filename).href },
    };
  };
}

function printDiagnostics(diagnostics, stderr) {
  for (const diagnostic of diagnostics) stderr.write(`eyeleng: ${diagnostic.severity}: ${diagnostic.message}\n`);
}

function hasFatalDiagnostics(analysis, strict) {
  return analysis.errors.length > 0 || (strict && analysis.warnings.length > 0);
}

function printDependencies(analysis, prefixes, stderr) {
  const edges = analysis.dependency.edges;
  if (edges.length === 0) {
    stderr.write('eyeleng: deps: no rule dependencies\n');
    return;
  }
  for (const edge of edges) {
    const from = formatRuleName(analysis.dependency.rules[edge.from].name, prefixes);
    const to = formatRuleName(analysis.dependency.rules[edge.to].name, prefixes);
    const kind = edge.negated ? 'NOT' : (edge.termGeneration ? 'generates' : 'uses');
    stderr.write(`eyeleng: deps: ${from} --${kind} ${edge.predicate ? compactIRI(edge.predicate, prefixes) : '*'}--> ${to}\n`);
  }
  if (analysis.dependency.layers && analysis.dependency.layers.length > 0) {
    analysis.dependency.layers.forEach((layer, index) => {
      stderr.write(`eyeleng: deps: layer ${index + 1}: ${layer.join(', ')}\n`);
    });
  }
}

function formatRuleName(name, prefixes = {}) {
  return /^https?:/.test(name) ? compactIRI(name, prefixes) : name;
}

async function main(argv = process.argv.slice(2), io = process) {
  try {
    const { options, files } = parseArgs(argv);
    if (options.help) {
      io.stdout.write(help());
      return 0;
    }
    if (options.version) {
      io.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (files.length === 0) {
      io.stdout.write(help());
      return 0;
    }
    const input = await readInput(files);
    const compiled = compile(input.source, {
      filename: input.filename,
      baseIRI: input.baseIRI,
      strict: false,
      throwOnDiagnostics: false,
      resolveImports: options.imports,
      importResolver: options.imports ? createFileImportResolver() : null,
      syntax: options.syntax === 'auto' ? undefined : options.syntax,
      ruleSet: options.ruleSet,
      rdfMessages: options.rdfMessages,
      includeMessageFacts: options.includeMessageFacts,
    });
    const fatal = hasFatalDiagnostics(compiled.analysis, options.strict);

    if (compiled.diagnostics.length > 0) printDiagnostics(compiled.diagnostics, io.stderr);
    if (options.deps) printDependencies(compiled.analysis, compiled.program.prefixes, io.stderr);

    if (options.check) {
      if (compiled.diagnostics.length === 0) io.stderr.write('eyeleng: ok\n');
      return fatal ? 1 : 0;
    }
    if (fatal) return 1;

    const queryText = options.queryFile ? fs.readFileSync(options.queryFile, 'utf8') : options.query;
    const querySpec = queryText
      ? parseQuery(queryText, { filename: options.queryFile || '<query>', prefixes: compiled.program.prefixes, baseIRI: compiled.program.baseIRI })
      : null;

    let result;
    if (querySpec) {
      const directQuery = queryProgram(compiled.program, querySpec, options);
      if (directQuery) {
        result = {
          baseIRI: compiled.program.baseIRI,
          prefixes: compiled.program.prefixes,
          input: compiled.program.data.slice(),
          inferred: [],
          closure: compiled.program.data.slice(),
          iterations: 0,
          layers: [],
          ruleApplications: 0,
          perRule: [],
          trace: [],
          diagnostics: compiled.diagnostics,
          analysis: compiled.analysis,
          query: directQuery,
        };
      }
    }

    if (!result) {
      const runOptions = querySpec
        ? queryRunOptions(compiled.program, querySpec, options)
        : { ...options, hybrid: options.hybrid };
      result = evaluate(compiled.program, { ...runOptions, analysis: compiled.analysis });
      result.diagnostics = compiled.diagnostics;
      result.analysis = compiled.analysis;
      if (querySpec) result.query = queryResult(result, querySpec, runOptions);
    }

    if (options.json) {
      io.stdout.write(`${JSON.stringify(toJSON(result, { all: options.all, proof: options.prove, analysis: options.deps }), null, 2)}\n`);
    } else if (result.query) {
      const out = formatBindings(result.query.bindings, result.prefixes, result.query.select);
      if (out) io.stdout.write(`${out}\n`);
    } else {
      const triples = resultTriples(result, compiled.program, options);
      const out = formatTriples(triples, result.prefixes);
      if (out) io.stdout.write(`${out}\n`);
      if (options.prove) {
        const proof = formatProof(result.trace, result.prefixes);
        if (proof) io.stdout.write(`${out ? '\n' : ''}${proof}\n`);
      }
    }

    if (options.stats) {
      io.stderr.write(`eyeleng: iterations=${result.iterations} layers=${result.layers.length} input=${result.input.length} inferred=${result.inferred.length} closure=${result.closure.length} ruleApplications=${result.ruleApplications}${result.query && result.query.mode ? ` queryMode=${result.query.mode}` : ''}\n`);
      if (result.query && result.query.stats) io.stderr.write(`eyeleng: backward goals=${result.query.stats.goals} facts=${result.query.stats.facts} rules=${result.query.stats.rules} memoHits=${result.query.stats.memoHits} memoStores=${result.query.stats.memoStores}\n`);
      if (result.hybridStats) io.stderr.write(`eyeleng: hybridBackward goals=${result.hybridStats.goals} facts=${result.hybridStats.facts} rules=${result.hybridStats.rules} memoHits=${result.hybridStats.memoHits} memoStores=${result.hybridStats.memoStores}\n`);
      for (const rule of result.perRule) {
        if (rule.applications > 0 || rule.added > 0) io.stderr.write(`eyeleng: rule ${rule.name}: applications=${rule.applications} added=${rule.added}${rule.runOnce ? ' runOnce=true' : ''}\n`);
      }
    }
    return 0;
  } catch (error) {
    io.stderr.write(`eyeleng: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { main, parseArgs, readInput, help, VERSION, createFileImportResolver };
