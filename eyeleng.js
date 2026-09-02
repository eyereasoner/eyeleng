#!/usr/bin/env node
'use strict';
(function () {
  const __nativeRequire = require;
  const __modules = {
    "src/cli.js": function (require, module, exports) {
      'use strict';
      
      const fs = require('node:fs');
      const path = require('node:path');
      const { fileURLToPath, pathToFileURL } = require('node:url');
      const {
        compileAsync,
        evaluateAsync,
        parseQuery,
        queryResult,
        queryProgram,
        formatTriples,
        formatProof,
        formatBindings,
        toJSON,
        resultTriples,
        parseRdfDocument,
        parseRdfMessageLog,
        looksLikeRdfMessageLog,
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
      
      function help() {
        return `eyeleng ${VERSION}\n\nSPARQL 1.2 RL (SRL) rule engine with RDF 1.2 base-graph input via rdf-parse.\n\nUsage: eyeleng [options] rules.srl\n\nOptions:\n  --data FILE            Add an RDF 1.2 document to the immutable base graph (repeatable)\n  --all                  Print base graph plus inference graph\n  --json                 Print JSON instead of compact triples/bindings\n  --prove                Print proof explanations\n  --stats                Print iteration and triple counts to stderr\n  --check                Parse, check well-formedness, and stratify only\n  --strict               Treat warnings as errors\n  --deps                 Print open/closed rule dependencies during --check\n  --query TEXT           Run a raw SRL body pattern\n  --query-file FILE      Read a raw SRL body pattern from a file\n  --query-mode MODE      Use auto, forward, or backward query planning (default auto)\n  --max-iterations N     Stop after N fixpoint iterations within a stratum\n  --no-imports           Reject rule sets containing IMPORTS\n  --rdf-messages         Treat --data input as an RDF Message Log (ancillary feature)\n  --include-message-facts Include payload facts while parsing RDF Message Logs\n  --version              Print version\n  -h, --help             Print this help\n\nThe rule-set media type is application/sparql-rl and the conventional extension is .srl.\n`;
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
          maxIterations: 10000,
          imports: true,
          dataFiles: [],
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
          else if (arg === '--rdf-messages') options.rdfMessages = true;
          else if (arg === '--include-message-facts') options.includeMessageFacts = true;
          else if (arg === '--data') {
            i += 1;
            if (i >= argv.length) throw new Error('--data requires an RDF file or URL');
            options.dataFiles.push(argv[i]);
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
          if (!target.startsWith('file:')) throw new Error(`Cannot import remote URL ${target}; this CLI only loads file: imports`);
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
          const kind = edge.closed ? 'closed' : 'open';
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
          const baseGraph = [];
          for (const dataSpec of options.dataFiles) {
            const dataInput = await readInput([dataSpec]);
            if (looksLikeRdfMessageLog(dataInput.source, { rdfMessages: options.rdfMessages })) {
              const messageLog = await parseRdfMessageLog(dataInput.source, {
                filename: dataInput.filename,
                baseIRI: dataInput.baseIRI,
                includeMessageFacts: options.includeMessageFacts,
              });
              baseGraph.push(...(messageLog.baseData || []));
            } else {
              const document = await parseRdfDocument(dataInput.source, { filename: dataInput.filename, baseIRI: dataInput.baseIRI, version: '1.2' });
              baseGraph.push(...document.triples);
            }
          }
          const compiled = await compileAsync(input.source, {
            filename: input.filename,
            baseIRI: input.baseIRI,
            baseGraph,
            strictGrammar: true,
            strict: false,
            throwOnDiagnostics: false,
            resolveImports: options.imports,
            importResolver: options.imports ? createFileImportResolver() : null,
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
                input: (compiled.program.baseData || []).slice(),
                data: (compiled.program.data || []).slice(),
                inferred: (compiled.program.data || []).filter((triple) => !(compiled.program.baseData || []).some((base) => require('./term.js').tripleKey(base) === require('./term.js').tripleKey(triple))),
                closure: [...(compiled.program.baseData || []), ...(compiled.program.data || [])],
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
            const runOptions = { ...compiled.options, ...options };
            result = await evaluateAsync(compiled.program, { ...runOptions, analysis: compiled.analysis });
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
      
    },
    "src/api.js": function (require, module, exports) {
      'use strict';
      
      const { parse, parseQuery } = require('./parser.js');
      const { parseRdfDocument } = require('./rdf.js');
      const { parseRdfMessageLog, looksLikeRdfMessageLog } = require('./rdfMessages.js');
      const { evaluate, evaluateAsync } = require('./engine.js');
      const { analyze } = require('./analyze.js');
      const { formatTriples, sortTriples, toJSON, formatTrace, formatProof, formatBindings } = require('./format.js');
      const { runQuery, runQueryAsync, queryResult, queryProgram } = require('./query.js');
      const { resultTriples } = require('./output.js');
      
      function parseInput(source, options = {}) {
        if (typeof source !== 'string') return source;
        if (looksLikeRdfMessageLog(source, options)) {
          throw new Error('RDF Message Log parsing is asynchronous with rdf-parse; use parseInputAsync(), compileAsync(), runAsync(), or the CLI');
        }
        return parse(source, options);
      }
      
      async function parseInputAsync(source, options = {}) {
        if (typeof source !== 'string') return source;
        if (looksLikeRdfMessageLog(source, options)) return await parseRdfMessageLog(source, options);
        return parse(source, options);
      }
      
      function compile(source, options = {}) {
        const parsed = parseInput(source, options);
        const resolved = resolveProgramImportsSync(parsed, options);
        const program = attachBaseGraph(resolved, options.baseGraph);
        return analyzeCompiled(program, options);
      }
      
      async function compileAsync(source, options = {}) {
        const parsed = await parseInputAsync(source, options);
        const resolved = await resolveProgramImportsAsync(parsed, options);
        const program = attachBaseGraph(resolved, options.baseGraph);
        return { ...analyzeCompiled(program, options), options };
      }
      
      function analyzeCompiled(program, options) {
        const analysis = analyze(program, options);
        const diagnostics = analysis.diagnostics;
        const fatal = analysis.errors.length > 0 || (options.strict && analysis.warnings.length > 0);
        if (fatal && options.throwOnDiagnostics !== false) {
          const details = diagnostics.map((diagnostic) => diagnostic.message).join('; ');
          throw new Error(`${analysis.errors.length > 0 ? 'Analysis failed' : 'Strict mode failed'}: ${details}`);
        }
        return { program, diagnostics, analysis };
      }
      
      function attachBaseGraph(program, baseGraph) {
        return { ...cloneProgram(program), baseData: Array.isArray(baseGraph) ? baseGraph.slice() : (program.baseData || []).slice() };
      }
      
      async function resolveProgramImportsAsync(program, options) {
        if (!program.imports || program.imports.length === 0) return cloneProgram(program);
        if (options.resolveImports === false || !options.importResolver) {
          throw new Error('This rule set contains IMPORTS, but no supported import resolver is enabled');
        }
        return resolveImportsAsync(program, options);
      }
      
      function resolveProgramImportsSync(program, options) {
        if (!program.imports || program.imports.length === 0) return cloneProgram(program);
        if (options.resolveImports === false || !options.importResolver) {
          throw new Error('This rule set contains IMPORTS, but no supported import resolver is enabled');
        }
        return resolveImports(program, options);
      }
      
      async function resolveImportsAsync(program, options = {}, seen = new Set()) {
        let merged = emptyProgram(program);
        const localKey = program.baseIRI || options.filename || '<input>';
        if (localKey) seen.add(localKey);
        for (const target of program.imports || []) {
          if (seen.has(target)) continue;
          seen.add(target);
          const resolved = await options.importResolver(target, { from: program.baseIRI || options.filename || null, seen });
          if (!resolved) throw new Error(`IMPORTS resolver returned no source for ${target}`);
          const importSource = typeof resolved === 'string' ? resolved : resolved.source;
          const importOptions = typeof resolved === 'string' ? {} : (resolved.options || {});
          // IMPORTS incorporates rule sets only (SPARQL 1.2 RL §4.5).
          // Do not auto-detect RDF/message data here: base data is a separate
          // evaluation input and must not be smuggled into the resolved rule set.
          const parsedImport = parse(importSource, { ...options, ...importOptions, baseIRI: importOptions.baseIRI || target, filename: importOptions.filename || target });
          const imported = await resolveImportsAsync(parsedImport, { ...options, ...importOptions }, seen);
          merged = mergePrograms(merged, imported);
        }
        return mergePrograms(merged, { ...program, imports: [] });
      }
      
      function resolveImports(program, options = {}, seen = new Set()) {
        let merged = emptyProgram(program);
        const localKey = program.baseIRI || options.filename || '<input>';
        if (localKey) seen.add(localKey);
        for (const target of program.imports || []) {
          if (seen.has(target)) continue;
          seen.add(target);
          const resolved = options.importResolver(target, { from: program.baseIRI || options.filename || null, seen });
          if (!resolved || (resolved && typeof resolved.then === 'function')) throw new Error(`Synchronous IMPORTS resolver returned no source for ${target}; use compileAsync() for async resolvers`);
          const importSource = typeof resolved === 'string' ? resolved : resolved.source;
          const importOptions = typeof resolved === 'string' ? {} : (resolved.options || {});
          // IMPORTS incorporates rule sets only (SPARQL 1.2 RL §4.5).
          const parsedImport = parse(importSource, { ...options, ...importOptions, baseIRI: importOptions.baseIRI || target, filename: importOptions.filename || target });
          const imported = resolveImports(parsedImport, { ...options, ...importOptions }, seen);
          merged = mergePrograms(merged, imported);
        }
        return mergePrograms(merged, { ...program, imports: [] });
      }
      
      function emptyProgram(program = {}) {
        return { baseIRI: program.baseIRI || null, version: program.version || null, imports: [], prefixes: { ...(program.prefixes || {}) }, baseData: [], data: [], rules: [] };
      }
      function cloneProgram(program) {
        return { baseIRI: program.baseIRI || null, version: program.version || null, imports: (program.imports || []).slice(), prefixes: { ...(program.prefixes || {}) }, baseData: (program.baseData || []).slice(), data: (program.data || []).slice(), rules: (program.rules || []).slice() };
      }
      function mergePrograms(left, right) {
        return {
          baseIRI: right.baseIRI || left.baseIRI || null,
          version: right.version || left.version || null,
          imports: Array.from(new Set([...(left.imports || []), ...(right.imports || [])])),
          prefixes: { ...(left.prefixes || {}), ...(right.prefixes || {}) },
          baseData: [...(left.baseData || []), ...(right.baseData || [])],
          data: [...(left.data || []), ...(right.data || [])],
          rules: [...(left.rules || []), ...(right.rules || [])],
        };
      }
      
      function run(source, options = {}) {
        const { program, diagnostics, analysis } = compile(source, options);
        const result = evaluate(program, { ...options, analysis });
        result.diagnostics = diagnostics; result.analysis = analysis; return result;
      }
      function runToString(source, options = {}) {
        const { program, diagnostics, analysis } = compile(source, options);
        const result = evaluate(program, { ...options, analysis }); result.diagnostics = diagnostics; result.analysis = analysis;
        return formatTriples(resultTriples(result, program, options), result.prefixes);
      }
      async function runAsync(source, options = {}) {
        const compiled = await compileAsync(source, options);
        const result = await evaluateAsync(compiled.program, { ...compiled.options, analysis: compiled.analysis });
        result.diagnostics = compiled.diagnostics; result.analysis = compiled.analysis; return result;
      }
      async function runToStringAsync(source, options = {}) {
        const compiled = await compileAsync(source, options);
        const result = await evaluateAsync(compiled.program, { ...compiled.options, analysis: compiled.analysis });
        result.diagnostics = compiled.diagnostics; result.analysis = compiled.analysis;
        return formatTriples(resultTriples(result, compiled.program, options), result.prefixes);
      }
      
      module.exports = {
        parse, parseQuery, parseInput, parseInputAsync, parseRdfDocument, parseRdfMessageLog, looksLikeRdfMessageLog,
        compile, compileAsync, resolveImports, resolveImportsAsync, mergePrograms, analyze, evaluate, evaluateAsync,
        run, runAsync, runToString, runToStringAsync, runQuery, runQueryAsync, queryResult, queryProgram,
        formatTriples, formatBindings, sortTriples, toJSON, formatTrace, formatProof, resultTriples,
      };
      
    },
    "src/parser.js": function (require, module, exports) {
      'use strict';
      
      const { tokenize, SyntaxErrorWithLocation } = require('./tokenizer.js');
      const { isBuiltinName } = require('./builtins.js');
      const { ruleNeedsRunOnce } = require('./assignments.js');
      const {
        iri,
        variable,
        blankNode,
        literal,
        tripleTerm,
        RDF_TYPE,
        RDF_FIRST,
        RDF_REST,
        RDF_NIL,
        RDF_REIFIES,
        XSD_STRING,
        XSD_BOOLEAN,
        XSD_INTEGER,
        XSD_DECIMAL,
        XSD_DOUBLE,
      } = require('./term.js');
      
      class Parser {
        constructor(source, options = {}) {
          this.tokens = Array.isArray(source) ? source : tokenize(source, options);
          this.pos = 0;
          this.options = options;
          this.baseIRI = options.baseIRI || null;
          this.version = null;
          this.imports = [];
          this.bnodeCounter = 0;
          this.bodyBnodeLabels = null;
          this.prefixes = {
            rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
            srl: 'http://www.w3.org/ns/sparql-rl#',
            xsd: 'http://www.w3.org/2001/XMLSchema#',
            ...options.prefixes,
          };
        }
      
        parseProgram() {
          const data = [];
          const rules = [];
          while (!this.is('eof')) {
            if (this.matchWord('PREFIX')) {
              this.parsePrefix(false);
            } else if (this.matchWord('BASE')) {
              this.parseBase(false);
            } else if (this.matchWord('VERSION')) {
              this.parseVersion();
            } else if (this.matchWord('IMPORTS')) {
              this.parseImports();
            } else if (this.matchWord('DATA')) {
              this.expectValue('{');
              data.push(...this.parseTriplesBlock({ allowPath: false, context: 'data' }));
            } else if (this.matchWord('RULE')) {
              rules.push(this.parseRule());
            } else {
              throw this.error(`Expected PREFIX, BASE, VERSION, IMPORTS, DATA, or RULE; got ${this.peek().value}`);
            }
          }
          return {
            baseIRI: this.baseIRI,
            version: this.version,
            imports: this.imports.slice(),
            prefixes: { ...this.prefixes },
            data,
            rules,
          };
        }
      
        parseBase(wasAtBase = false) {
          const iriToken = this.expectType('iri');
          this.baseIRI = iriToken.value;
          if (wasAtBase) this.consumeOptionalDot();
        }
      
        parsePrefix(wasAtPrefix = false) {
          const nameToken = this.advance();
          if (nameToken.type !== 'word') throw this.error('Expected prefix name', nameToken);
          let name = nameToken.value;
          if (!name.endsWith(':')) throw this.error('Prefix name must end with :', nameToken);
          name = name.slice(0, -1);
          if (this.strictGrammar() && !isValidPNPrefix(name)) throw this.error(`Invalid prefix name ${nameToken.value}`, nameToken);
          const iriToken = this.expectType('iri');
          this.prefixes[name] = this.resolveIRI(iriToken.value, iriToken);
          if (wasAtPrefix) this.consumeOptionalDot();
        }
      
        parseVersion() {
          const token = this.expectType('string');
          if (this.strictGrammar()) {
            if (token.long) throw this.error('VERSION must use a short string literal', token);
            if (token.value !== '1.2') throw this.error('VERSION must be the SPARQL-RL version label \"1.2\"', token);
          }
          this.version = token.value;
        }
      
        parseImports() {
          const target = this.parseIRIValue();
          this.imports.push(target.value);
          this.consumeOptionalDot();
        }
      
        parseRule() {
          let name = null;
          if (!this.checkValue('{')) name = this.parseIRIValue().value;
          this.expectValue('{');
          const head = this.parseTriplesBlock({ allowPath: false, context: 'head' });
          this.expectWord('WHERE');
          const groundData = this.matchWord('DATA');
          this.expectValue('{');
          const body = this.parseRuleBodyWithBlankNodeScope();
          return { name, head, body, groundData, runOnce: ruleNeedsRunOnce(head, body, this.options) };
        }
      
        parseRuleBodyWithBlankNodeScope() {
          const previous = this.bodyBnodeLabels;
          this.bodyBnodeLabels = new Map();
          try {
            return this.parseBodyBlockAlreadyOpen();
          } finally {
            this.bodyBnodeLabels = previous;
          }
        }
      
        bodyBlankNodeVariable(label) {
          if (!this.bodyBnodeLabels) this.bodyBnodeLabels = new Map();
          if (!this.bodyBnodeLabels.has(label)) {
            this.bnodeCounter += 1;
            this.bodyBnodeLabels.set(label, variable(`__b${this.bnodeCounter}`));
          }
          return this.bodyBnodeLabels.get(label);
        }
      
        parseIRIValue() {
          const token = this.advance();
          if (token.type === 'iri') return { value: this.resolveIRI(token.value, token), lexical: `<${token.value}>` };
          if (token.type === 'word') {
            if (token.value === 'a') return { value: RDF_TYPE, lexical: 'a' };
            if (!token.value.includes(':')) throw this.error(`Expected IRI or prefixed name, got ${token.value}`, token);
            return { value: this.expandPrefixedName(token.value, token), lexical: token.value };
          }
          throw this.error(`Expected IRI or prefixed name, got ${token.value}`, token);
        }
      
        parseTriplesBlock(options = {}) {
          const triples = [];
          while (!this.matchValue('}')) {
            triples.push(...this.parseTripleStatement(options));
            this.consumeOptionalDot();
          }
          return triples;
        }
      
        parseTripleStatement(options = {}) {
          const subjectNode = this.parseGraphNode({ ...options, position: 'subject' });
          const triples = [...subjectNode.triples];
          triples.push(...this.parsePropertyListForSubject(subjectNode.term, options));
          return triples;
        }
      
        parsePropertyListForSubject(subject, options = {}, terminators = ['}', '|}', ']']) {
          const triples = [];
          let keepParsingPredicates = true;
      
          while (keepParsingPredicates) {
            if (terminators.some((value) => this.checkValue(value)) || this.checkValue('.')) break;
            const predicate = options.allowPath ? this.parseVerbPathOrSimple(options) : this.parseVerbTerm(options);
            do {
              const objectNode = this.parseGraphNode({ ...options, position: 'object' });
              triples.push(...objectNode.triples);
              const baseTriple = { s: subject, p: predicate, o: objectNode.term };
              triples.push(baseTriple);
              triples.push(...this.parseAnnotationsForTriple(baseTriple, options));
            } while (this.matchValue(','));
      
            if (this.matchValue(';')) {
              keepParsingPredicates = !(this.checkValue('.') || terminators.some((value) => this.checkValue(value)));
            } else {
              keepParsingPredicates = false;
            }
          }
      
          return triples;
        }
      
        parseGraphNode(options = {}) {
          if (this.checkValue('[')) return this.parseBlankNodePropertyList(options);
          if (this.checkValue('(')) return this.parseCollection(options);
          if (this.checkValue('<<')) return this.parseReifiedTripleNode(options);
          return { term: this.parseTerm(options), triples: [] };
        }
      
        parseBlankNodePropertyList(options = {}) {
          this.expectValue('[');
          const node = this.freshGraphNode(options);
          if (this.matchValue(']')) return { term: node, triples: [] };
          const triples = this.parsePropertyListForSubject(node, options, [']']);
          this.expectValue(']');
          return { term: node, triples };
        }
      
        parseCollection(options = {}) {
          this.expectValue('(');
          if (this.matchValue(')')) return { term: iri(RDF_NIL), triples: [] };
      
          const head = this.freshGraphNode(options);
          let current = head;
          const triples = [];
          while (true) {
            const item = this.parseGraphNode(options);
            triples.push(...item.triples);
            triples.push({ s: current, p: iri(RDF_FIRST), o: item.term });
            if (this.matchValue(')')) {
              triples.push({ s: current, p: iri(RDF_REST), o: iri(RDF_NIL) });
              break;
            }
            const rest = this.freshGraphNode(options);
            triples.push({ s: current, p: iri(RDF_REST), o: rest });
            current = rest;
          }
          return { term: head, triples };
        }
      
        freshGraphNode(options = {}) {
          this.bnodeCounter += 1;
          const id = `b${this.bnodeCounter}`;
          return options.context === 'body' ? variable(`__${id}`) : blankNode(id);
        }
      
        parseAnnotationsForTriple(baseTriple, options = {}) {
          const triples = [];
          const reified = tripleTerm(baseTriple.s, baseTriple.p, baseTriple.o);
          let currentReifier = null;
      
          while (this.checkValue('~') || this.checkValue('{|')) {
            if (this.matchValue('~')) {
              currentReifier = this.parseOptionalReifier(options);
              triples.push({ s: currentReifier, p: iri(RDF_REIFIES), o: reified });
            } else if (this.matchValue('{|')) {
              if (this.checkValue('|}')) throw this.error('Annotation blocks may not be empty');
              const annotationSubject = currentReifier || this.freshGraphNode(options);
              triples.push({ s: annotationSubject, p: iri(RDF_REIFIES), o: reified });
              triples.push(...this.parsePropertyListForSubject(annotationSubject, options, ['|}']));
              this.expectValue('|}');
            }
          }
          return triples;
        }
      
        parseOptionalReifier(options = {}) {
          if (this.checkValue('{|') || this.checkValue('.') || this.checkValue(';') || this.checkValue(',') || this.checkValue('}') || this.checkValue('|}') || this.checkValue('>>')) {
            return this.freshGraphNode(options);
          }
          return this.parseVarOrReifierId(options);
        }
      
        parseVarOrReifierId(options = {}) {
          const token = this.peek();
          if (token.type === 'variable') return this.parseTerm(options);
          if (token.type === 'iri') return this.parseTerm(options);
          if (token.type === 'word' && (token.value.startsWith('_:') || token.value.includes(':'))) return this.parseTerm(options);
          throw this.error(`Expected variable, IRI, or blank node after ~; got ${token.value}`, token);
        }
      
        parseReifiedTripleNode(options = {}) {
          this.expectValue('<<');
          const subjectNode = this.parseReifiedTripleComponent(options);
          const p = this.parseVerbTerm(options);
          const objectNode = this.parseReifiedTripleComponent(options);
          let reifier = null;
          if (this.matchValue('~')) reifier = this.parseOptionalReifier(options);
          this.expectValue('>>');
          reifier = reifier || this.freshGraphNode(options);
          return {
            term: reifier,
            triples: [
              ...subjectNode.triples,
              ...objectNode.triples,
              { s: reifier, p: iri(RDF_REIFIES), o: tripleTerm(subjectNode.term, p, objectNode.term) },
            ],
          };
        }
      
        parseReifiedTripleComponent(options = {}) {
          if (this.checkValue('<<')) return this.parseReifiedTripleNode(options);
          return { term: this.parseTerm(options), triples: [] };
        }
      
        parseVerbTerm(options = {}) {
          const term = this.parseTerm({ ...options, position: 'predicate' });
          if (term.type !== 'iri' && term.type !== 'var') throw this.error('Expected IRI or variable as predicate');
          return term;
        }
      
        parseVerbPathOrSimple(options = {}) {
          if (this.checkType('variable')) return this.parseTerm(options);
          return this.parsePathSequence();
        }
      
        parsePathSequence() {
          const parts = [this.parsePathEltOrInverse()];
          while (this.matchValue('/')) parts.push(this.parsePathEltOrInverse());
          return parts.length === 1 ? parts[0] : { type: 'path', kind: 'sequence', parts };
        }
      
        parsePathEltOrInverse() {
          if (this.matchValue('^')) return { type: 'path', kind: 'inverse', path: this.parsePathPrimary() };
          return this.parsePathPrimary();
        }
      
        parsePathPrimary() {
          if (this.matchValue('(')) {
            const path = this.parsePathSequence();
            this.expectValue(')');
            return path;
          }
          const token = this.peek();
          if (token.type === 'iri' || token.type === 'word') {
            const value = this.parseIRIValue();
            return iri(value.value);
          }
          throw this.error(`Expected path IRI, a, ^, or (, got ${token.value}`, token);
        }
      
        parseFilterClause() {
          // SRL FILTER accepts a bracketted expression, a built-in call, or an IRI-named function call.
          // The bracketted-expression form is the familiar FILTER(?x > 10).
          const expr = this.parseExpression();
          return { type: 'filter', expr };
        }
      
        parseSetClause() {
          this.expectValue('(');
          const variableToken = this.expectType('variable');
          this.expectValue(':=');
          const expr = this.parseExpression();
          this.expectValue(')');
          return { type: 'set', variable: variableToken.value, expr };
        }
      
        parseBindClause() {
          this.expectValue('(');
          const expr = this.parseExpression();
          this.expectWord('AS');
          const variableToken = this.expectType('variable');
          this.expectValue(')');
          return { type: 'bind', variable: variableToken.value, expr };
        }
      
        parseBodyBlockAlreadyOpen() {
          const clauses = [];
          while (!this.matchValue('}')) {
            if (this.matchWord('FILTER')) {
              clauses.push(this.parseFilterClause());
            } else if (this.matchWord('SET')) {
              clauses.push(this.parseSetClause());
            } else if (this.matchWord('BIND')) {
              throw this.error('BIND is not part of the SPARQL 1.2 RL grammar; use SET');
            } else if (this.matchWord('NOT')) {
              const groundData = this.matchWord('DATA');
              this.expectValue('{');
              const body = this.parseBodyBasicAlreadyOpen();
              clauses.push({ type: 'not', body, groundData });
            } else {
              for (const triple of this.parseTripleStatement({ allowPath: true, context: 'body' })) {
                if (triple.p && triple.p.type === 'path') clauses.push({ type: 'path', triple });
                else clauses.push({ type: 'triple', triple });
              }
            }
            this.consumeOptionalDot();
          }
          return clauses;
        }
      
        parseBodyBasicAlreadyOpen() {
          const clauses = [];
          while (!this.matchValue('}')) {
            if (this.matchWord('FILTER')) {
              clauses.push(this.parseFilterClause());
            } else if (this.matchWord('SET')) {
              throw this.error('SET is not allowed inside NOT blocks by the SRL grammar');
            } else if (this.matchWord('BIND')) {
              throw this.error('BIND is not allowed inside NOT blocks by the SRL grammar');
            } else if (this.matchWord('NOT')) {
              throw this.error('Nested NOT is not allowed inside NOT blocks by the SRL grammar');
            } else {
              for (const triple of this.parseTripleStatement({ allowPath: true, context: 'body' })) {
                if (triple.p && triple.p.type === 'path') clauses.push({ type: 'path', triple });
                else clauses.push({ type: 'triple', triple });
              }
            }
            this.consumeOptionalDot();
          }
          return clauses;
        }
      
        parseTerm(options = {}) {
          const token = this.advance();
          if (token.type === 'operator' && (token.value === '+' || token.value === '-') && this.peek().type === 'number') {
            const numberToken = this.advance();
            return numericLiteral(token.value === '-' ? -numberToken.value : numberToken.value);
          }
          if (token.type === 'variable') {
            if (options.context === 'data') throw this.error('DATA blocks may not contain variables', token);
            return variable(token.value);
          }
          if (token.type === 'iri') return iri(this.resolveIRI(token.value, token));
          if (token.type === 'string') return this.parseLiteralAfterToken(token);
          if (token.type === 'number') return numericLiteral(token.value);
          if (token.value === '<<(') return this.parseTripleTermAfterOpen(options);
          if (token.value === '<<') throw this.error('Use << s p o >> as a graph node reifier; use <<( s p o )>> for a triple term', token);
          if (token.type === 'word') {
            if (token.value === 'a') {
              if (options.position !== 'predicate') throw this.error('a is only allowed as a predicate', token);
              return iri(RDF_TYPE);
            }
            if (token.value === 'true') return literal(true, XSD_BOOLEAN);
            if (token.value === 'false') return literal(false, XSD_BOOLEAN);
            if (token.value.startsWith('_:')) {
              const label = token.value.slice(2);
              return options.context === 'body' ? this.bodyBlankNodeVariable(label) : blankNode(label);
            }
            return iri(this.expandPrefixedName(token.value, token));
          }
          throw this.error(`Expected term, got ${token.value}`, token);
        }
      
        parseTripleTermAfterOpen(options = {}) {
          const s = this.parseTerm(options);
          const p = this.parseVerbTerm(options);
          const o = this.parseTerm(options);
          this.expectValue(')>>');
          return tripleTerm(s, p, o);
        }
      
        parseReifiedTripleAfterOpen(options = {}) {
          const s = this.parseTerm(options);
          const p = this.parseVerbTerm(options);
          const o = this.parseTerm(options);
          if (this.matchValue('~')) {
            if (!this.checkValue('>>')) this.parseVarOrReifierId(options);
          }
          this.expectValue('>>');
          return tripleTerm(s, p, o);
        }
      
        parseLiteralAfterToken(token) {
          if (this.matchValue('^^')) {
            const datatype = this.parseDatatypeIRI();
            return literal(coerceLexicalLiteral(token.value, datatype), datatype, null);
          }
          if (this.checkType('word') && /^@[A-Za-z]+(?:-[A-Za-z0-9]+)*(?:--[A-Za-z]+)?$/.test(this.peek().value)) {
            const tagToken = this.advance();
            const rawTag = tagToken.value.slice(1);
            const direction = rawTag.includes('--') ? rawTag.slice(rawTag.lastIndexOf('--') + 2) : null;
            if (direction && direction !== 'ltr' && direction !== 'rtl') {
              throw this.error(`Invalid base direction --${direction}; expected --ltr or --rtl`, tagToken);
            }
            const tag = rawTag.toLowerCase();
            const [lang, langDir = null] = tag.split('--');
            return literal(token.value, null, lang, langDir);
          }
          return literal(token.value);
        }
      
        parseDatatypeIRI() {
          const token = this.advance();
          if (token.type === 'iri') return this.resolveIRI(token.value, token);
          if (token.type === 'word') return this.expandPrefixedName(token.value, token);
          throw this.error(`Expected datatype IRI, got ${token.value}`, token);
        }
      
        expandPrefixedName(value, token) {
          const colon = value.indexOf(':');
          if (colon < 0) throw this.error(`Expected IRI, prefixed name, literal, blank node, or variable; got ${value}`, token);
          const prefix = value.slice(0, colon);
          const local = value.slice(colon + 1);
          if (this.strictGrammar()) validatePrefixedName(prefix, local, value, token, (message, errToken) => this.error(message, errToken));
          if (!(prefix in this.prefixes)) throw this.error(`Unknown prefix ${prefix}:`, token);
          return this.prefixes[prefix] + decodePNLocalEscapes(local);
        }
      
        resolveIRI(value, token = null) {
          if (!this.baseIRI || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return value;
          try {
            return new URL(value, this.baseIRI).href;
          } catch (_) {
            if (token) throw this.error(`Could not resolve IRI ${value} against BASE ${this.baseIRI}`, token);
            return value;
          }
        }
      
        parseExpression(minPrec = 0) {
          let left = this.parseUnaryExpression();
          while (true) {
            const info = this.peekBinaryOperator();
            if (!info || info.prec < minPrec) break;
            this.consumeBinaryOperator(info.op);
            if (info.op === 'IN' || info.op === 'NOT IN') {
              const items = this.parseExpressionListItems();
              left = { type: 'binary', op: info.op, left, right: { type: 'list', items } };
            } else {
              const right = this.parseExpression(info.prec + 1);
              left = { type: 'binary', op: info.op, left, right };
            }
          }
          return left;
        }
      
        parseExpressionListItems() {
          this.expectValue('(');
          const items = [];
          if (!this.checkValue(')')) {
            do { items.push(this.parseExpression()); }
            while (this.matchValue(','));
          }
          this.expectValue(')');
          return items;
        }
      
        peekBinaryOperator() {
          const token = this.peek();
          if (token.type === 'operator') {
            const prec = binaryPrecedence(token.value);
            return prec >= 0 ? { op: token.value, prec } : null;
          }
          if (token.type === 'word' && token.value.toUpperCase() === 'IN') return { op: 'IN', prec: 3 };
          if (token.type === 'word' && token.value.toUpperCase() === 'NOT' && this.peekN(1).type === 'word' && this.peekN(1).value.toUpperCase() === 'IN') return { op: 'NOT IN', prec: 3 };
          return null;
        }
      
        consumeBinaryOperator(op) {
          if (op === 'NOT IN') { this.expectWord('NOT'); this.expectWord('IN'); return; }
          if (op === 'IN') { this.expectWord('IN'); return; }
          this.expectValue(op);
        }
      
        parseUnaryExpression() {
          if (this.peek().type === 'operator' && (this.peek().value === '!' || this.peek().value === '-' || this.peek().value === '+')) {
            const op = this.advance().value;
            return { type: 'unary', op, expr: this.parseUnaryExpression() };
          }
          return this.parsePrimaryExpression();
        }
      
        parsePrimaryExpression() {
          const token = this.advance();
          if (token.type === 'variable') return { type: 'var', name: token.value };
          if (token.type === 'string') return this.parseLiteralExpressionAfterToken(token);
          if (token.type === 'number') return { type: 'literal', value: token.value };
          if (token.type === 'iri') {
            const name = this.resolveIRI(token.value, token);
            if (this.checkValue('(')) return this.parseFunctionCallAfterName(name);
            return { type: 'term', value: iri(name) };
          }
          if (token.value === '<<(') return { type: 'term', value: this.parseTripleTermAfterOpen() };
          if (token.value === '<<') throw this.error('Use <<( s p o )>> for triple terms inside expressions', token);
          if (token.type === 'word') {
            if (token.value === 'true') return { type: 'literal', value: true };
            if (token.value === 'false') return { type: 'literal', value: false };
            if (token.value.startsWith('_:')) return { type: 'term', value: blankNode(token.value.slice(2)) };
            if (this.checkValue('(')) {
              if (token.value.includes(':') && token.value !== 'a') {
                const name = this.expandPrefixedName(token.value, token);
                return this.parseFunctionCallAfterName(name);
              }
              if (isBuiltinName(token.value)) return this.parseFunctionCallAfterName(token.value);
              throw this.error(`Unknown built-in or unprefixed function call ${token.value}; use an IRI such as :${token.value} for custom functions`, token);
            }
            if (token.value.includes(':') || token.value === 'a') {
              const value = token.value === 'a' ? RDF_TYPE : this.expandPrefixedName(token.value, token);
              return { type: 'term', value: iri(value) };
            }
          }
          if (token.value === '(') {
            const expr = this.parseExpression();
            this.expectValue(')');
            return expr;
          }
          throw this.error(`Expected expression, got ${token.value}`, token);
        }
      
        parseFunctionCallAfterName(name) {
          this.expectValue('(');
          const args = [];
          if (!this.checkValue(')')) {
            do { args.push(this.parseExpression()); }
            while (this.matchValue(','));
          }
          this.expectValue(')');
          return { type: 'call', name, args };
        }
      
        parseLiteralExpressionAfterToken(token) {
          const term = this.parseLiteralAfterToken(token);
          if (term.datatype || term.lang) return { type: 'term', value: term };
          return { type: 'literal', value: term.value };
        }
      
        consumeOptionalDot() { this.matchValue('.'); }
      
        checkWord(value) {
          return this.checkType('word') && this.peek().value.toUpperCase() === value.toUpperCase();
        }
      
        matchWord(value) {
          if (this.checkType('word') && this.peek().value.toUpperCase() === value.toUpperCase()) {
            this.advance();
            return true;
          }
          return false;
        }
      
        expectWord(value) {
          if (this.matchWord(value)) return this.previous();
          throw this.error(`Expected ${value}, got ${this.peek().value}`);
        }
      
        matchValue(value) {
          const token = this.peek();
          if ((token.type === 'punct' || token.type === 'operator') && token.value === value) { this.advance(); return true; }
          return false;
        }
      
        expectValue(value) {
          if (this.matchValue(value)) return this.previous();
          throw this.error(`Expected ${value}, got ${this.peek().value}`);
        }
      
        checkValue(value) { const token = this.peek(); return (token.type === 'punct' || token.type === 'operator') && token.value === value; }
        checkType(type) { return this.peek().type === type; }
        is(type) { return this.peek().type === type; }
      
        expectType(type) {
          if (this.peek().type === type) return this.advance();
          throw this.error(`Expected ${type}, got ${this.peek().value}`);
        }
      
        advance() { if (!this.is('eof')) this.pos += 1; return this.previous(); }
        peek() { return this.tokens[this.pos]; }
        peekN(n) { return this.tokens[this.pos + n] || this.tokens[this.tokens.length - 1]; }
        previous() { return this.tokens[this.pos - 1]; }
        strictGrammar() { return this.options.strictGrammar !== false; }
        error(message, token = this.peek()) { return new SyntaxErrorWithLocation(message, token && token.filename ? token : { ...token, filename: this.options.filename || '<input>' }); }
      }
      
      
      function isPnCharsBase(ch) {
        if (!ch) return false;
        return /[A-Za-z]/.test(ch) || ch.codePointAt(0) >= 0x00C0;
      }
      
      function isPnCharsU(ch) {
        return isPnCharsBase(ch) || ch === '_';
      }
      
      function isPnChars(ch) {
        return isPnCharsU(ch) || /[0-9-]/.test(ch) || ch === '\u00B7' || /[\u0300-\u036F\u203F-\u2040]/u.test(ch);
      }
      
      function isValidPNPrefix(prefix) {
        if (prefix === '') return true;
        const chars = Array.from(prefix);
        if (!isPnCharsBase(chars[0])) return false;
        if (chars.length > 1 && chars.at(-1) === '.') return false;
        return chars.slice(1).every((ch) => isPnChars(ch) || ch === '.');
      }
      
      function plxLength(text, index) {
        const ch = text[index];
        if (ch === '%' && /[0-9A-Fa-f]/.test(text[index + 1] || '') && /[0-9A-Fa-f]/.test(text[index + 2] || '')) return 3;
        if (ch === '\\' && /[_~.!$&'()*+,;=/?#@%-]/.test(text[index + 1] || '')) return 2;
        return 0;
      }
      
      function isPNLocalStartAt(text, index) {
        const ch = text[index];
        return isPnCharsU(ch) || /[0-9:]/.test(ch || '') || plxLength(text, index) > 0;
      }
      
      function isPNLocalBodyAt(text, index) {
        const ch = text[index];
        return isPnChars(ch) || ch === '.' || ch === ':' || plxLength(text, index) > 0;
      }
      
      function isPNLocalEndAt(text, index) {
        const ch = text[index];
        return isPnChars(ch) || ch === ':' || plxLength(text, index) > 0;
      }
      
      function validatePNLocal(local) {
        if (local === '') return true;
        if (!isPNLocalStartAt(local, 0)) return false;
        let lastStart = 0;
        for (let i = 0; i < local.length;) {
          const len = plxLength(local, i) || 1;
          if (i > 0 && !isPNLocalBodyAt(local, i)) return false;
          lastStart = i;
          i += len;
        }
        return isPNLocalEndAt(local, lastStart);
      }
      
      function validatePrefixedName(prefix, local, value, token, makeError) {
        if (!isValidPNPrefix(prefix)) throw makeError(`Invalid prefixed name ${value}: invalid prefix`, token);
        if (!validatePNLocal(local)) throw makeError(`Invalid prefixed name ${value}: invalid local name`, token);
      }
      
      function decodePNLocalEscapes(local) {
        return String(local).replace(/\\([_~.!$&'()*+,;=/?#@%-])/g, '$1');
      }
      
      function numericLiteral(value) {
        if (Number.isInteger(value)) return literal(value, XSD_INTEGER);
        return literal(value, XSD_DECIMAL);
      }
      
      function parseIntegerLiteral(value) {
        const text = String(value);
        const asNumber = Number.parseInt(text, 10);
        return Number.isSafeInteger(asNumber) && String(asNumber) === text.replace(/^\+/, '') ? asNumber : BigInt(text);
      }
      
      function coerceLexicalLiteral(value, datatype) {
        if (datatype === XSD_INTEGER) return parseIntegerLiteral(value);
        if (datatype === XSD_DECIMAL || datatype === XSD_DOUBLE) return Number.parseFloat(value);
        if (datatype === XSD_BOOLEAN) return value === 'true' || value === '1';
        return value;
      }
      
      function binaryPrecedence(op) {
        return {
          '||': 1,
          '&&': 2,
          '=': 3,
          '!=': 3,
          'IN': 3,
          'NOT IN': 3,
          '<': 4,
          '<=': 4,
          '>': 4,
          '>=': 4,
          '+': 5,
          '-': 5,
          '*': 6,
          '/': 6,
        }[op] ?? -1;
      }
      
      function parse(source, options = {}) {
        return new Parser(source, options).parseProgram();
      }
      
      function parseQuery(source, options = {}) {
        if (/^\s*(QUERY|SELECT)\b/i.test(source)) {
          throw new Error('QUERY/SELECT concrete syntax is not part of the SPARQL-RL rule-set grammar; pass a raw body pattern instead');
        }
        const trimmed = String(source).trim();
        const text = trimmed.startsWith('{') ? `RULE { } WHERE ${trimmed}` : `RULE { } WHERE { ${source} }`;
        const program = new Parser(text, options).parseProgram();
        if (program.rules.length !== 1 || program.data.length !== 0) {
          throw new Error('Expected exactly one raw body pattern');
        }
        return { select: null, body: program.rules[0].body, prefixes: program.prefixes, baseIRI: program.baseIRI };
      }
      
      module.exports = { Parser, parse, parseQuery };
      
    },
    "src/tokenizer.js": function (require, module, exports) {
      'use strict';
      
      class SyntaxErrorWithLocation extends Error {
        constructor(message, token) {
          const suffix = token && token.line ? ` at ${token.filename || '<input>'}:${token.line}:${token.column}` : '';
          super(`${message}${suffix}`);
          this.name = 'SyntaxError';
          this.token = token;
        }
      }
      
      function tokenize(source, filenameOrOptions = '<input>') {
        const options = typeof filenameOrOptions === 'object' && filenameOrOptions !== null ? filenameOrOptions : { filename: filenameOrOptions };
        const filename = options.filename || '<input>';
        const strictGrammar = !!options.strictGrammar;
        const tokens = [];
        let i = 0;
        let line = 1;
        let column = 1;
      
        function current() { return source[i]; }
        function peek(n = 1) { return source[i + n]; }
        function startsWith(text) { return source.startsWith(text, i); }
        function advance() {
          const ch = source[i++];
          if (ch === '\n') { line += 1; column = 1; }
          else column += 1;
          return ch;
        }
        function token(type, value, startLine, startColumn, extra = {}) {
          tokens.push({ type, value, line: startLine, column: startColumn, ...extra });
        }
        function syntax(message, startLine, startColumn) {
          throw new SyntaxErrorWithLocation(message, { line: startLine, column: startColumn, filename });
        }
      
        function readNumericLiteral() {
          let value = '';
          const start = i;
          while (i < source.length && isDigitCode(source.charCodeAt(i))) { i += 1; column += 1; }
          if (source[i] === '.' && isDigitCode(source.charCodeAt(i + 1))) {
            i += 1; column += 1;
            while (i < source.length && isDigitCode(source.charCodeAt(i))) { i += 1; column += 1; }
          }
          value = source.slice(start, i);
          if (current() === 'e' || current() === 'E') {
            const saveI = i;
            const saveLine = line;
            const saveColumn = column;
            let exponent = advance();
            if (current() === '+' || current() === '-') exponent += advance();
            if (isDigitCode(source.charCodeAt(i))) {
              while (i < source.length && isDigitCode(source.charCodeAt(i))) exponent += advance();
              value += exponent;
            } else {
              i = saveI;
              line = saveLine;
              column = saveColumn;
            }
          }
          return value;
        }
      
        function readEscape(startLine, startColumn) {
          advance(); // consume backslash
          const esc = advance();
          if (esc === 'u' || esc === 'U') {
            const length = esc === 'u' ? 4 : 8;
            let hex = '';
            for (let j = 0; j < length; j += 1) {
              if (!isHexCode(source.charCodeAt(i))) syntax(`Invalid \\${esc} escape`, startLine, startColumn);
              hex += advance();
            }
            const codePoint = Number.parseInt(hex, 16);
            try { return String.fromCodePoint(codePoint); }
            catch { syntax(`Invalid \\${esc} escape`, startLine, startColumn); }
          }
          if (strictGrammar && !Object.hasOwn(escapeMap, esc)) syntax(`Invalid escape \\${esc}`, startLine, startColumn);
          return escapeValue(esc);
        }
      
        function readIriChar(startLine, startColumn) {
          if (current() === '\\') {
            advance();
            const esc = advance();
            if (esc !== 'u' && esc !== 'U') syntax(`Invalid IRI escape \\${esc}`, startLine, startColumn);
            const length = esc === 'u' ? 4 : 8;
            let hex = '';
            for (let j = 0; j < length; j += 1) {
              if (!isHexCode(source.charCodeAt(i))) syntax(`Invalid \\${esc} escape`, startLine, startColumn);
              hex += advance();
            }
            const codePoint = Number.parseInt(hex, 16);
            try { return String.fromCodePoint(codePoint); }
            catch { syntax(`Invalid \\${esc} escape`, startLine, startColumn); }
          }
          const c = current();
          if (strictGrammar && (/[\u0000-\u0020]/.test(c) || /[<>"{}|^`]/.test(c))) syntax(`Invalid character in IRI reference ${JSON.stringify(c)}`, startLine, startColumn);
          return advance();
        }
      
        while (i < source.length) {
          const ch = current();
          if (isWhitespaceCode(source.charCodeAt(i))) { advance(); continue; }
          if (ch === '#') {
            while (i < source.length && current() !== '\n') advance();
            continue;
          }
      
          const startLine = line;
          const startColumn = column;
      
          if (startsWith('<<(')) {
            advance(); advance(); advance();
            token('punct', '<<(', startLine, startColumn);
            continue;
          }
          if (startsWith(')>>')) {
            advance(); advance(); advance();
            token('punct', ')>>', startLine, startColumn);
            continue;
          }
          if (startsWith('<<')) {
            advance(); advance();
            token('punct', '<<', startLine, startColumn);
            continue;
          }
          if (startsWith('>>')) {
            advance(); advance();
            token('punct', '>>', startLine, startColumn);
            continue;
          }
          if (startsWith('{|')) {
            advance(); advance();
            token('punct', '{|', startLine, startColumn);
            continue;
          }
          if (startsWith('|}')) {
            advance(); advance();
            token('punct', '|}', startLine, startColumn);
            continue;
          }
      
          if (ch === '<' && looksLikeIRI(source, i)) {
            let value = '';
            advance();
            while (i < source.length && current() !== '>') value += readIriChar(startLine, startColumn);
            if (current() !== '>') syntax('Unterminated IRI', startLine, startColumn);
            advance();
            token('iri', value, startLine, startColumn);
            continue;
          }
      
          if ((ch === '"' && startsWith('"""')) || (ch === "'" && startsWith("'''"))) {
            const quote = ch;
            advance(); advance(); advance();
            let value = '';
            while (i < source.length && !startsWith(quote.repeat(3))) {
              if (current() === '\\') {
                value += readEscape(startLine, startColumn);
              } else {
                value += advance();
              }
            }
            if (!startsWith(quote.repeat(3))) syntax('Unterminated long string literal', startLine, startColumn);
            advance(); advance(); advance();
            token('string', value, startLine, startColumn, { long: true, quote });
            continue;
          }
      
          if (ch === '"' || ch === "'") {
            const quote = ch;
            let value = '';
            advance();
            while (i < source.length && current() !== quote) {
              if (current() === '\n' || current() === '\r') syntax('Unterminated string literal', startLine, startColumn);
              if (current() === '\\') {
                value += readEscape(startLine, startColumn);
              } else {
                value += advance();
              }
            }
            if (current() !== quote) syntax('Unterminated string literal', startLine, startColumn);
            advance();
            token('string', value, startLine, startColumn, { long: false, quote });
            continue;
          }
      
          if (ch === '@') {
            const wordStart = i;
            advance();
            while (i < source.length && isLangTagCode(source.charCodeAt(i))) { i += 1; column += 1; }
            const value = source.slice(wordStart, i);
            if (!/^@[A-Za-z]+(?:-[A-Za-z0-9]+)*(?:--[A-Za-z]+)?$/.test(value)) syntax(`Invalid language tag ${value}`, startLine, startColumn);
            token('word', value, startLine, startColumn);
            continue;
          }
      
          if (ch === '?' || ch === '$') {
            const varStart = i;
            advance();
            while (i < source.length && isVarNameCode(source.charCodeAt(i))) { i += 1; column += 1; }
            if (i - varStart === 1) syntax('Expected variable name', startLine, startColumn);
            token('variable', source.slice(varStart + 1, i), startLine, startColumn);
            continue;
          }
      
          if (startsNumericLiteral(source, i)) {
            const value = readNumericLiteral();
            token('number', Number(value), startLine, startColumn);
            continue;
          }
      
          const two = ch + peek();
          if ([':=', '!=', '<=', '>=', '&&', '||', '=>', '^^'].includes(two)) {
            advance(); advance();
            token('operator', two, startLine, startColumn);
            continue;
          }
      
          if ('{}()[].,;|'.includes(ch)) {
            token('punct', advance(), startLine, startColumn);
            continue;
          }
      
          if ('=<>+-*/!^~'.includes(ch)) {
            token('operator', advance(), startLine, startColumn);
            continue;
          }
      
          const wordStart = i;
          while (i < source.length) {
            const c = source[i];
            if (c === '\\' && source[i + 1] !== undefined) {
              i += 2;
              column += 2;
              continue;
            }
            const code = source.charCodeAt(i);
            if (isWhitespaceCode(code) || '{}()[],;|'.includes(c) || '=<>+-*/!^~'.includes(c)) break;
            if (c === '.') {
              const n = source[i + 1];
              if (n === undefined || isWhitespaceCode(n.charCodeAt(0)) || '{}()[],;|'.includes(n) || '=<>+-*/!^~'.includes(n)) break;
            }
            if (c === '#') break;
            i += 1;
            column += 1;
          }
          if (i === wordStart) syntax(`Unexpected character ${JSON.stringify(ch)}`, startLine, startColumn);
      
          const value = source.slice(wordStart, i);
          if (/^[+-]?(?:(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+|\d+)$/.test(value)) token('number', Number(value), startLine, startColumn);
          else token('word', value, startLine, startColumn);
        }
      
        tokens.push({ type: 'eof', value: '<eof>', line, column, filename });
        return tokens;
      }
      
      
      function isDigitCode(code) {
        return code >= 48 && code <= 57;
      }
      
      function isHexCode(code) {
        return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
      }
      
      function isWhitespaceCode(code) {
        return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
      }
      
      function isLangTagCode(code) {
        return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 45;
      }
      
      function isVarNameCode(code) {
        return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 || code === 45;
      }
      
      function startsNumericLiteral(source, i) {
        const ch = source[i];
        const next = source[i + 1];
        if (isDigitCode(ch.charCodeAt(0))) return true;
        if (ch === '.' && next !== undefined && isDigitCode(next.charCodeAt(0))) return true;
        return false;
      }
      
      function looksLikeIRI(source, i) {
        const next = source[i + 1];
        if (next === undefined || /[\s=]/.test(next)) return false;
        for (let j = i + 1; j < source.length; j += 1) {
          const c = source[j];
          if (c === '>') return true;
          if (/\s/.test(c)) return false;
        }
        return false;
      }
      
      const escapeMap = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', "'": "'", '\\': '\\' };
      
      function escapeValue(esc) {
        return escapeMap[esc] ?? esc;
      }
      
      module.exports = { tokenize, SyntaxErrorWithLocation };
      
    },
    "src/builtins.js": function (require, module, exports) {
      'use strict';
      
      const {
        iri,
        blankNode,
        literal,
        tripleTerm,
        termEquals,
        termToPrimitive,
        termToString,
        booleanValue,
        comparePrimitives,
        isIRI,
        isBlank,
        isLiteral,
        isTripleTerm,
        valueToTerm,
        inferDatatype,
        XSD_STRING,
        XSD_BOOLEAN,
        RDF_NS,
        XSD_INTEGER,
        XSD_DECIMAL,
        XSD_DOUBLE,
      } = require('./term.js');
      
      const XSD_NS = 'http://www.w3.org/2001/XMLSchema#';
      const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
      const XSD_DAYTIME_DURATION = 'http://www.w3.org/2001/XMLSchema#dayTimeDuration';
      const RDF_LANGSTRING = `${RDF_NS}langString`;
      const RDF_DIRLANGSTRING = `${RDF_NS}dirLangString`;
      const NUMERIC_DATATYPES = new Set([XSD_INTEGER, XSD_DECIMAL, XSD_DOUBLE]);
      const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
      const MIN_SAFE_INTEGER_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
      
      // This table is intentionally shaped by the SPARQL 1.2 RL grammar production BuiltInCall.
      // Keys are the canonical spellings used by the draft; lookup is case-insensitive so examples
      // may use SPARQL-style uppercase or lowercase spellings while still being checked against the
      // grammar's finite set of built-ins.
      const BUILTIN_SIGNATURES = Object.freeze({
        STR: { min: 1, max: 1 },
        LANG: { min: 1, max: 1 },
        LANGMATCHES: { min: 2, max: 2 },
        LANGDIR: { min: 1, max: 1 },
        DATATYPE: { min: 1, max: 1 },
        IRI: { min: 1, max: 1 },
        URI: { min: 1, max: 1 },
        BNODE: { min: 0, max: 1 },
        ABS: { min: 1, max: 1 },
        CEIL: { min: 1, max: 1 },
        FLOOR: { min: 1, max: 1 },
        ROUND: { min: 1, max: 1 },
        CONCAT: { min: 0, max: Infinity },
        SUBSTR: { min: 2, max: 3 },
        STRLEN: { min: 1, max: 1 },
        REPLACE: { min: 3, max: 4 },
        UCASE: { min: 1, max: 1 },
        LCASE: { min: 1, max: 1 },
        ENCODE_FOR_URI: { min: 1, max: 1 },
        CONTAINS: { min: 2, max: 2 },
        STRSTARTS: { min: 2, max: 2 },
        STRENDS: { min: 2, max: 2 },
        STRBEFORE: { min: 2, max: 2 },
        STRAFTER: { min: 2, max: 2 },
        YEAR: { min: 1, max: 1 },
        MONTH: { min: 1, max: 1 },
        DAY: { min: 1, max: 1 },
        HOURS: { min: 1, max: 1 },
        MINUTES: { min: 1, max: 1 },
        SECONDS: { min: 1, max: 1 },
        TIMEZONE: { min: 1, max: 1 },
        TZ: { min: 1, max: 1 },
        NOW: { min: 0, max: 0 },
        UUID: { min: 0, max: 0 },
        STRUUID: { min: 0, max: 0 },
        IF: { min: 3, max: 3, lazy: true },
        STRLANG: { min: 2, max: 2 },
        STRLANGDIR: { min: 3, max: 3 },
        STRDT: { min: 2, max: 2 },
        sameTerm: { min: 2, max: 2 },
        isIRI: { min: 1, max: 1 },
        isURI: { min: 1, max: 1 },
        isBLANK: { min: 1, max: 1 },
        isLITERAL: { min: 1, max: 1 },
        isNUMERIC: { min: 1, max: 1 },
        hasLANG: { min: 1, max: 1 },
        hasLANGDIR: { min: 1, max: 1 },
        REGEX: { min: 2, max: 3 },
        isTRIPLE: { min: 1, max: 1 },
        TRIPLE: { min: 3, max: 3 },
        SUBJECT: { min: 1, max: 1 },
        PREDICATE: { min: 1, max: 1 },
        OBJECT: { min: 1, max: 1 },
      });
      
      const BUILTIN_BY_LOWER = new Map(Object.keys(BUILTIN_SIGNATURES).map((name) => [name.toLowerCase(), name]));
      
      function canonicalBuiltinName(name) {
        return BUILTIN_BY_LOWER.get(String(name).toLowerCase()) || null;
      }
      
      function isBuiltinName(name) {
        return canonicalBuiltinName(name) !== null;
      }
      
      function builtinNames() {
        return Object.keys(BUILTIN_SIGNATURES);
      }
      
      function evalExpression(expr, binding, options = {}) {
        switch (expr.type) {
          case 'literal':
            return expr.value;
          case 'term':
            return expr.value;
          case 'var':
            return binding[expr.name];
          case 'list':
            return expr.items.map((item) => evalExpression(item, binding, options));
          case 'unary': {
            const value = evalExpression(expr.expr, binding, options);
            if (expr.op === '!') return !booleanValue(value);
            if (expr.op === '-') return negateNumeric(termToPrimitive(valueToTermIfNeeded(value)));
            if (expr.op === '+') return unaryPlusNumeric(termToPrimitive(valueToTermIfNeeded(value)));
            throw new Error(`Unsupported unary operator ${expr.op}`);
          }
          case 'binary': {
            const left = evalExpression(expr.left, binding, options);
            if (expr.op === '&&') return booleanValue(left) && booleanValue(evalExpression(expr.right, binding, options));
            if (expr.op === '||') return booleanValue(left) || booleanValue(evalExpression(expr.right, binding, options));
            const right = evalExpression(expr.right, binding, options);
            return evalBinary(expr.op, left, right);
          }
          case 'call':
            return evalCallExpression(expr, binding, options);
          default:
            throw new Error(`Unsupported expression type ${expr.type}`);
        }
      }
      
      function evalCallExpression(expr, binding, options) {
        const canonical = canonicalBuiltinName(expr.name);
        if (canonical === 'IF') {
          validateArity(canonical, expr.args.length);
          const condition = evalExpression(expr.args[0], binding, options);
          return evalExpression(booleanValue(condition) ? expr.args[1] : expr.args[2], binding, options);
        }
        if (isXsdCast(expr.name)) {
          if (expr.args.length !== 1) throw new Error(`${expr.name} expects 1 argument, got ${expr.args.length}`);
          return castXsd(expr.name, evalExpression(expr.args[0], binding, options));
        }
        return callBuiltin(expr.name, expr.args.map((arg) => evalExpression(arg, binding, options)), binding, options);
      }
      
      function isXsdCast(name) {
        return typeof name === 'string' && name.startsWith(XSD_NS) && new Set([
          XSD_STRING, XSD_BOOLEAN, XSD_INTEGER, XSD_DECIMAL, XSD_DOUBLE,
        ]).has(name);
      }
      
      function castXsd(datatype, value) {
        const primitive = value && value.type ? termToPrimitive(value) : value;
        if (datatype === XSD_STRING) return literal(termToString(valueToTermIfNeeded(value)), XSD_STRING);
        if (datatype === XSD_BOOLEAN) {
          if (typeof primitive === 'boolean') return literal(primitive, XSD_BOOLEAN);
          if (typeof primitive === 'number' || typeof primitive === 'bigint') return literal(Number(primitive) !== 0 && !Number.isNaN(Number(primitive)), XSD_BOOLEAN);
          const lexical = String(primitive).trim();
          if (lexical === 'true' || lexical === '1') return literal(true, XSD_BOOLEAN);
          if (lexical === 'false' || lexical === '0') return literal(false, XSD_BOOLEAN);
          throw new Error(`Cannot cast ${lexical} to xsd:boolean`);
        }
        if (datatype === XSD_INTEGER) {
          if (typeof primitive === 'bigint') return literal(primitive, XSD_INTEGER);
          if (typeof primitive === 'boolean') return literal(primitive ? 1 : 0, XSD_INTEGER);
          const numeric = Number(primitive);
          if (!Number.isFinite(numeric)) throw new Error(`Cannot cast ${primitive} to xsd:integer`);
          const integer = Math.trunc(numeric);
          return literal(integer, XSD_INTEGER);
        }
        if (datatype === XSD_DECIMAL || datatype === XSD_DOUBLE) {
          const numeric = Number(primitive);
          if (Number.isNaN(numeric)) throw new Error(`Cannot cast ${primitive} to ${datatype}`);
          return literal(numeric, datatype);
        }
        throw new Error(`Unsupported XSD cast ${datatype}`);
      }
      
      function evalBinary(op, left, right) {
        if (op === '=') return termishEquals(left, right);
        if (op === '!=') return !termishEquals(left, right);
        if (op === 'IN' || op === 'NOT IN') {
          const list = Array.isArray(right) ? right : [];
          const found = list.some((item) => termishEquals(left, item));
          return op === 'IN' ? found : !found;
        }
        if (['<', '<=', '>', '>='].includes(op)) {
          const cmp = comparePrimitives(left, right);
          if (op === '<') return cmp < 0;
          if (op === '<=') return cmp <= 0;
          if (op === '>') return cmp > 0;
          if (op === '>=') return cmp >= 0;
        }
        const lp = termToPrimitive(valueToTermIfNeeded(left));
        const rp = termToPrimitive(valueToTermIfNeeded(right));
        if (op === '+') {
          if (isNumericPrimitive(lp) && isNumericPrimitive(rp)) return addNumeric(lp, rp);
          return String(lp) + String(rp);
        }
        if (op === '-') return subtractNumeric(lp, rp);
        if (op === '*') return multiplyNumeric(lp, rp);
        if (op === '/') {
          if (!isNumericPrimitive(lp) || !isNumericPrimitive(rp)) throw new Error('Numeric division requires numeric operands');
          if (Number(rp) === 0) throw new Error('Division by zero');
          return Number(lp) / Number(rp);
        }
        throw new Error(`Unsupported binary operator ${op}`);
      }
      
      
      function isNumericPrimitive(value) {
        return typeof value === 'number' || typeof value === 'bigint';
      }
      
      function isIntegerPrimitive(value) {
        return typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value));
      }
      
      function toBigIntInteger(value) {
        if (typeof value === 'bigint') return value;
        if (typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value)) return BigInt(value);
        throw new Error(`Cannot convert ${String(value)} to BigInt safely`);
      }
      
      function fromIntegerResult(value) {
        if (value <= MAX_SAFE_INTEGER_BIGINT && value >= MIN_SAFE_INTEGER_BIGINT) return Number(value);
        return value;
      }
      
      function addNumeric(left, right) {
        if (isIntegerPrimitive(left) && isIntegerPrimitive(right)) {
          if (typeof left === 'bigint' || typeof right === 'bigint') return fromIntegerResult(toBigIntInteger(left) + toBigIntInteger(right));
          const result = left + right;
          if (Number.isSafeInteger(result)) return result;
          return toBigIntInteger(left) + toBigIntInteger(right);
        }
        return Number(left) + Number(right);
      }
      
      function subtractNumeric(left, right) {
        if (isIntegerPrimitive(left) && isIntegerPrimitive(right)) {
          if (typeof left === 'bigint' || typeof right === 'bigint') return fromIntegerResult(toBigIntInteger(left) - toBigIntInteger(right));
          const result = left - right;
          if (Number.isSafeInteger(result)) return result;
          return toBigIntInteger(left) - toBigIntInteger(right);
        }
        return Number(left) - Number(right);
      }
      
      function multiplyNumeric(left, right) {
        if (isIntegerPrimitive(left) && isIntegerPrimitive(right)) {
          if (typeof left === 'bigint' || typeof right === 'bigint') return fromIntegerResult(toBigIntInteger(left) * toBigIntInteger(right));
          const result = left * right;
          if (Number.isSafeInteger(result)) return result;
          return toBigIntInteger(left) * toBigIntInteger(right);
        }
        return Number(left) * Number(right);
      }
      
      function negateNumeric(value) {
        if (typeof value === 'bigint') return -value;
        return -Number(value);
      }
      
      function unaryPlusNumeric(value) {
        if (typeof value === 'bigint') return value;
        return Number(value);
      }
      
      function valueToTermIfNeeded(value) {
        return value && value.type ? value : literal(value, inferDatatype(value));
      }
      
      function termishEquals(left, right) {
        if (left && left.type && right && right.type) return termEquals(left, right);
        const lp = left && left.type ? termToPrimitive(left) : left;
        const rp = right && right.type ? termToPrimitive(right) : right;
        return lp === rp;
      }
      
      function callBuiltin(name, args, binding = {}, options = {}) {
        const injected = options.builtins && (options.builtins[name] || options.builtins[String(name).toLowerCase()]);
        if (injected) return injected(args, { binding, iri, blankNode, literal, tripleTerm, termToString, booleanValue, termToPrimitive });
      
        if (localName(name).toLowerCase() === 'sudoku') {
          if (args.length !== 1) throw new Error(`SUDOKU expects 1 argument, got ${args.length}`);
          return solveSudoku(termToString(args[0]));
        }
      
        const canonical = canonicalBuiltinName(name);
        if (!canonical) throw new Error(`Unknown builtin ${name}`);
        validateArity(canonical, args.length);
        const key = canonical.toLowerCase();
      
        if (key === 'str') return termToString(args[0]);
        if (key === 'iri' || key === 'uri') return makeIRI(termToString(args[0]), options);
        if (key === 'bnode') return makeBlankNode(args, options);
        if (key === 'concat') return args.map(termToString).join('');
        if (key === 'lcase') return termToString(args[0]).toLowerCase();
        if (key === 'ucase') return termToString(args[0]).toUpperCase();
        if (key === 'contains') return termToString(args[0]).includes(termToString(args[1]));
        if (key === 'strstarts') return termToString(args[0]).startsWith(termToString(args[1]));
        if (key === 'strends') return termToString(args[0]).endsWith(termToString(args[1]));
        if (key === 'strbefore') {
          const s = termToString(args[0]);
          const needle = termToString(args[1]);
          const index = s.indexOf(needle);
          return index < 0 ? '' : s.slice(0, index);
        }
        if (key === 'strafter') {
          const s = termToString(args[0]);
          const needle = termToString(args[1]);
          const index = s.indexOf(needle);
          return index < 0 ? '' : s.slice(index + needle.length);
        }
        if (key === 'encode_for_uri') return encodeURIComponent(termToString(args[0]));
        if (key === 'regex') return regex(args);
        if (key === 'replace') return replace(args);
        if (key === 'substr') return substr(args);
        if (key === 'sameterm') return termishEquals(args[0], args[1]);
        if (key === 'isiri' || key === 'isuri') return isIRI(args[0]);
        if (key === 'isblank') return isBlank(args[0]);
        if (key === 'isliteral') return isLiteral(args[0]);
        if (key === 'istriple') return isTripleTerm(args[0]);
        if (key === 'isnumeric') return isNumericValue(args[0]);
        if (key === 'datatype') return datatypeOf(args[0]);
        if (key === 'lang') return args[0] && args[0].type === 'literal' ? (args[0].lang || '') : '';
        if (key === 'langmatches') return langMatches(termToString(args[0]), termToString(args[1]));
        if (key === 'haslang') return !!(args[0] && args[0].type === 'literal' && args[0].lang);
        if (key === 'langdir') return args[0] && args[0].type === 'literal' ? (args[0].langDir || '') : '';
        if (key === 'haslangdir') return !!(args[0] && args[0].type === 'literal' && args[0].langDir);
        if (key === 'strlen') return termToString(args[0]).length;
        if (key === 'abs') return Math.abs(Number(termToPrimitive(valueToTermIfNeeded(args[0]))));
        if (key === 'floor') return Math.floor(Number(termToPrimitive(valueToTermIfNeeded(args[0]))));
        if (key === 'ceil') return Math.ceil(Number(termToPrimitive(valueToTermIfNeeded(args[0]))));
        if (key === 'round') return Math.round(Number(termToPrimitive(valueToTermIfNeeded(args[0]))));
        if (key === 'if') return booleanValue(args[0]) ? args[1] : args[2];
        if (key === 'strdt') return literal(termToString(args[0]), termToString(args[1]));
        if (key === 'strlang') return literal(termToString(args[0]), null, termToString(args[1]).toLowerCase());
        if (key === 'strlangdir') return literal(termToString(args[0]), null, termToString(args[1]).toLowerCase(), termToString(args[2]).toLowerCase());
        if (key === 'triple') return tripleTerm(valueToTermIfNeeded(args[0]), valueToTermIfNeeded(args[1]), valueToTermIfNeeded(args[2]));
        if (key === 'subject') return isTripleTerm(args[0]) ? args[0].s : null;
        if (key === 'predicate') return isTripleTerm(args[0]) ? args[0].p : null;
        if (key === 'object') return isTripleTerm(args[0]) ? args[0].o : null;
        if (key === 'year') return datePart(args[0], 'year');
        if (key === 'month') return datePart(args[0], 'month');
        if (key === 'day') return datePart(args[0], 'day');
        if (key === 'hours') return datePart(args[0], 'hours');
        if (key === 'minutes') return datePart(args[0], 'minutes');
        if (key === 'seconds') return datePart(args[0], 'seconds');
        if (key === 'timezone') return timezoneDuration(args[0]);
        if (key === 'tz') return timezoneLexical(args[0]);
        if (key === 'now') return literal((options.now || new Date()).toISOString(), XSD_DATETIME);
        if (key === 'uuid') return iri(`urn:uuid:${freshUuid(options)}`);
        if (key === 'struuid') return freshUuid(options);
        throw new Error(`Unimplemented builtin ${name}`);
      }
      
      
      function localName(name) {
        const text = String(name || '');
        const hash = text.lastIndexOf('#');
        const slash = text.lastIndexOf('/');
        const colon = text.lastIndexOf(':');
        const index = Math.max(hash, slash, colon);
        return index >= 0 ? text.slice(index + 1) : text;
      }
      
      function solveSudoku(puzzle) {
        const text = String(puzzle || '').trim();
        if (!/^[0-9.]{81}$/.test(text)) throw new Error('SUDOKU expects an 81-character puzzle string containing digits or dots');
        const cells = Array.from(text, (ch) => (ch === '.' ? 0 : Number(ch)));
        const peers = sudokuPeers();
      
        for (let i = 0; i < 81; i += 1) {
          const value = cells[i];
          if (value === 0) continue;
          for (const peer of peers[i]) {
            if (cells[peer] === value) throw new Error('SUDOKU puzzle has conflicting givens');
          }
        }
      
        const solved = solveSudokuCells(cells, peers);
        if (!solved) return '';
        return solved.join('');
      }
      
      function solveSudokuCells(cells, peers) {
        let bestIndex = -1;
        let bestCandidates = null;
      
        for (let i = 0; i < 81; i += 1) {
          if (cells[i] !== 0) continue;
          const candidates = sudokuCandidates(cells, peers[i]);
          if (candidates.length === 0) return null;
          if (!bestCandidates || candidates.length < bestCandidates.length) {
            bestIndex = i;
            bestCandidates = candidates;
            if (candidates.length === 1) break;
          }
        }
      
        if (bestIndex < 0) return cells;
      
        for (const value of bestCandidates) {
          const next = cells.slice();
          next[bestIndex] = value;
          const solved = solveSudokuCells(next, peers);
          if (solved) return solved;
        }
        return null;
      }
      
      function sudokuCandidates(cells, peers) {
        const used = new Set();
        for (const peer of peers) if (cells[peer] !== 0) used.add(cells[peer]);
        const out = [];
        for (let value = 1; value <= 9; value += 1) if (!used.has(value)) out.push(value);
        return out;
      }
      
      let SUDOKU_PEERS = null;
      function sudokuPeers() {
        if (SUDOKU_PEERS) return SUDOKU_PEERS;
        SUDOKU_PEERS = Array.from({ length: 81 }, (_, index) => {
          const row = Math.floor(index / 9);
          const col = index % 9;
          const boxRow = Math.floor(row / 3) * 3;
          const boxCol = Math.floor(col / 3) * 3;
          const peers = new Set();
          for (let c = 0; c < 9; c += 1) peers.add(row * 9 + c);
          for (let r = 0; r < 9; r += 1) peers.add(r * 9 + col);
          for (let r = boxRow; r < boxRow + 3; r += 1) {
            for (let c = boxCol; c < boxCol + 3; c += 1) peers.add(r * 9 + c);
          }
          peers.delete(index);
          return Array.from(peers);
        });
        return SUDOKU_PEERS;
      }
      
      function validateArity(canonical, actual) {
        const sig = BUILTIN_SIGNATURES[canonical];
        if (!sig) throw new Error(`Unknown builtin ${canonical}`);
        const tooFew = actual < sig.min;
        const tooMany = actual > sig.max;
        if (tooFew || tooMany) {
          const expected = sig.min === sig.max ? `${sig.min}` : `${sig.min}${sig.max === Infinity ? '+' : `..${sig.max}`}`;
          throw new Error(`${canonical} expects ${expected} argument${expected === '1' ? '' : 's'}, got ${actual}`);
        }
      }
      
      function makeIRI(value, options) {
        if (options.baseIRI && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
          try { return iri(new URL(value, options.baseIRI).href); } catch (_) { /* fall through */ }
        }
        return iri(value);
      }
      
      function makeBlankNode(args, options) {
        if (args.length === 0) return blankNode(freshId(options));
        const label = termToString(args[0]);
        if (!options.__bnodeLabels) options.__bnodeLabels = new Map();
        if (!options.__bnodeLabels.has(label)) options.__bnodeLabels.set(label, label || freshId(options));
        return blankNode(options.__bnodeLabels.get(label));
      }
      
      function regex(args) {
        const flags = regexFlags(termToString(args[2] || ''));
        return new RegExp(termToString(args[1]), flags).test(termToString(args[0]));
      }
      
      function replace(args) {
        const flags = regexFlags(termToString(args[3] || ''));
        const effectiveFlags = flags.includes('g') ? flags : `${flags}g`;
        return termToString(args[0]).replace(new RegExp(termToString(args[1]), effectiveFlags), termToString(args[2]));
      }
      
      function regexFlags(flags) {
        let out = '';
        for (const ch of String(flags)) {
          // JavaScript RegExp has no direct SPARQL/xpath "x" free-spacing flag, so ignore it.
          if (ch === 'x') continue;
          if ('imsuyg'.includes(ch) && !out.includes(ch)) out += ch;
        }
        return out;
      }
      
      function substr(args) {
        const value = termToString(args[0]);
        const start = Math.max(0, Number(termToPrimitive(valueToTermIfNeeded(args[1]))) - 1);
        if (args.length >= 3) return value.substring(start, start + Number(termToPrimitive(valueToTermIfNeeded(args[2]))));
        return value.substring(start);
      }
      
      function datatypeOf(value) {
        const term = valueToTermIfNeeded(value);
        if (term.type !== 'literal') return null;
        if (term.langDir) return iri(RDF_DIRLANGSTRING);
        if (term.lang) return iri(RDF_LANGSTRING);
        return iri(term.datatype || inferDatatype(term.value) || XSD_STRING);
      }
      
      function isNumericValue(value) {
        const term = valueToTermIfNeeded(value);
        if (typeof termToPrimitive(term) === 'bigint') return true;
        if (typeof termToPrimitive(term) === 'number') return true;
        return term.type === 'literal' && NUMERIC_DATATYPES.has(term.datatype);
      }
      
      function datePart(value, part) {
        const lexical = termToString(value);
        const match = lexical.match(/^(-?\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?)?/);
        if (!match) return null;
        const [, year, month, day, hours = '0', minutes = '0', seconds = '0'] = match;
        if (part === 'year') return Number(year);
        if (part === 'month') return Number(month);
        if (part === 'day') return Number(day);
        if (part === 'hours') return Number(hours);
        if (part === 'minutes') return Number(minutes);
        if (part === 'seconds') return Number(seconds);
        return null;
      }
      
      function timezoneLexical(value) {
        const lexical = termToString(value);
        const match = lexical.match(/(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})$/);
        return match ? match[1] : '';
      }
      
      function timezoneDuration(value) {
        const zone = timezoneLexical(value);
        if (!zone) return null;
        if (zone === 'Z') return literal('PT0S', XSD_DAYTIME_DURATION);
        const match = zone.match(/^([+-])(\d{2}):?(\d{2})$/);
        if (!match) return null;
        const [, sign, hh, mm] = match;
        const hours = Number(hh);
        const minutes = Number(mm);
        const body = `${hours ? `${hours}H` : ''}${minutes ? `${minutes}M` : ''}` || '0S';
        return literal(`${sign === '-' ? '-' : ''}PT${body}`, XSD_DAYTIME_DURATION);
      }
      
      function langMatches(lang, range) {
        if (range === '*') return lang.length > 0;
        return lang.toLowerCase() === range.toLowerCase() || lang.toLowerCase().startsWith(`${range.toLowerCase()}-`);
      }
      
      function freshUuid(options) {
        if (typeof options.uuidGenerator === 'function') return String(options.uuidGenerator());
        options.__eyelengUuidCounter = (options.__eyelengUuidCounter || 0) + 1;
        return `00000000-0000-4000-8000-${String(options.__eyelengUuidCounter).padStart(12, '0')}`;
      }
      
      function freshId(options) {
        options.__eyelengCounter = (options.__eyelengCounter || 0) + 1;
        return `eyeleng-${options.__eyelengCounter}`;
      }
      
      function asTerm(value) {
        return valueToTerm(value);
      }
      
      module.exports = {
        BUILTIN_SIGNATURES,
        builtinNames,
        canonicalBuiltinName,
        isBuiltinName,
        validateArity,
        evalExpression,
        booleanValue,
        asTerm,
        callBuiltin,
        evalBinary,
      };
      
    },
    "src/term.js": function (require, module, exports) {
      'use strict';
      
      const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
      const RDF_TYPE = `${RDF_NS}type`;
      const RDF_FIRST = `${RDF_NS}first`;
      const RDF_REST = `${RDF_NS}rest`;
      const RDF_NIL = `${RDF_NS}nil`;
      const RDF_REIFIES = `${RDF_NS}reifies`;
      const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
      const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';
      const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
      const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';
      const XSD_DOUBLE = 'http://www.w3.org/2001/XMLSchema#double';
      
      function iri(value) {
        return { type: 'iri', value: String(value) };
      }
      
      function variable(name) {
        const value = String(name);
        return { type: 'var', value: value[0] === '?' || value[0] === '$' ? value.slice(1) : value };
      }
      
      function blankNode(value) {
        const label = String(value);
        return { type: 'blank', value: label.startsWith('_:') ? label.slice(2) : label };
      }
      
      function literal(value, datatype = null, lang = null, langDir = null) {
        return { type: 'literal', value, datatype, lang, langDir };
      }
      
      function tripleTerm(s, p, o) {
        return { type: 'triple', s, p, o };
      }
      
      function isVariable(term) {
        return term && term.type === 'var';
      }
      
      function isIRI(term) {
        return term && term.type === 'iri';
      }
      
      function isBlank(term) {
        return term && term.type === 'blank';
      }
      
      function isLiteral(term) {
        return term && term.type === 'literal';
      }
      
      function isTripleTerm(term) {
        return term && term.type === 'triple';
      }
      
      function termEquals(a, b) {
        return termKey(a) === termKey(b);
      }
      
      function literalKeyValue(value) {
        if (typeof value === 'bigint') return `${value.toString()}n`;
        return JSON.stringify(value);
      }
      
      function isNumericPrimitive(value) {
        return typeof value === 'number' || typeof value === 'bigint';
      }
      
      function compareNumericPrimitives(a, b) {
        if (typeof a === 'bigint' && typeof b === 'bigint') {
          if (a < b) return -1;
          if (a > b) return 1;
          return 0;
        }
        if (typeof a === 'bigint' && typeof b === 'number' && Number.isInteger(b) && Number.isSafeInteger(b)) {
          const bi = BigInt(b);
          if (a < bi) return -1;
          if (a > bi) return 1;
          return 0;
        }
        if (typeof a === 'number' && typeof b === 'bigint' && Number.isInteger(a) && Number.isSafeInteger(a)) {
          const ai = BigInt(a);
          if (ai < b) return -1;
          if (ai > b) return 1;
          return 0;
        }
        const diff = Number(a) - Number(b);
        if (diff < 0) return -1;
        if (diff > 0) return 1;
        return 0;
      }
      
      function termKey(term) {
        if (!term) return 'null';
        if (term.type === 'iri') return `I:${term.value}`;
        if (term.type === 'blank') return `B:${term.value}`;
        if (term.type === 'var') return `V:${term.value}`;
        if (term.type === 'literal') return `L:${literalKeyValue(term.value)}^^${term.datatype || ''}@${term.lang || ''}--${term.langDir || ''}`;
        if (term.type === 'triple') return `T:${termKey(term.s)} ${termKey(term.p)} ${termKey(term.o)}`;
        return JSON.stringify(term);
      }
      
      function tripleKey(triple) {
        return `${termKey(triple.s)} ${termKey(triple.p)} ${termKey(triple.o)}`;
      }
      
      function cloneTerm(term) {
        if (!term) return term;
        if (term.type === 'triple') return tripleTerm(cloneTerm(term.s), cloneTerm(term.p), cloneTerm(term.o));
        return { ...term };
      }
      
      function valueToTerm(value) {
        if (value && typeof value === 'object' && value.type) return value;
        return literal(value, inferDatatype(value));
      }
      
      function inferDatatype(value) {
        if (typeof value === 'boolean') return XSD_BOOLEAN;
        if (typeof value === 'bigint') return XSD_INTEGER;
        if (typeof value === 'number' && Number.isInteger(value)) return XSD_INTEGER;
        if (typeof value === 'number') return XSD_DECIMAL;
        if (typeof value === 'string') return XSD_STRING;
        return null;
      }
      
      function termToPrimitive(term) {
        if (!term) return undefined;
        if (term.type === 'literal') return term.value;
        if (term.type === 'iri') return term.value;
        if (term.type === 'blank') return `_:${term.value}`;
        if (term.type === 'var') return undefined;
        if (term.type === 'triple') return term;
        return term;
      }
      
      function termToString(term) {
        const value = termToPrimitive(term);
        if (value === undefined || value === null) return '';
        if (value && value.type === 'triple') return formatTerm(value);
        return String(value);
      }
      
      function booleanValue(value) {
        const primitive = value && value.type ? termToPrimitive(value) : value;
        if (primitive === undefined || primitive === null) return false;
        if (typeof primitive === 'boolean') return primitive;
        if (typeof primitive === 'bigint') return primitive !== 0n;
        if (typeof primitive === 'number') return primitive !== 0 && !Number.isNaN(primitive);
        if (typeof primitive === 'string') return primitive.length > 0 && primitive !== 'false';
        return Boolean(primitive);
      }
      
      function comparePrimitives(a, b) {
        const av = a && a.type ? termToPrimitive(a) : a;
        const bv = b && b.type ? termToPrimitive(b) : b;
        if (isNumericPrimitive(av) && isNumericPrimitive(bv)) return compareNumericPrimitives(av, bv);
        const as = String(av);
        const bs = String(bv);
        if (as < bs) return -1;
        if (as > bs) return 1;
        return 0;
      }
      
      function escapeString(value) {
        return String(value)
          .replace(/\\/g, '\\\\')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t')
          .replace(/"/g, '\\"');
      }
      
      function compactIRI(value, prefixes = {}) {
        if (value === RDF_TYPE) return 'a';
        const entries = Object.entries(prefixes)
          .filter(([, iriPrefix]) => iriPrefix && value.startsWith(iriPrefix))
          .sort((a, b) => b[1].length - a[1].length);
        if (entries.length > 0) {
          const [prefix, iriPrefix] = entries[0];
          const local = value.slice(iriPrefix.length);
          if (/^[A-Za-z_][A-Za-z0-9_\-]*$/.test(local) || /^[A-Za-z0-9_\-]+$/.test(local)) {
            return `${prefix}:${local}`;
          }
        }
        return `<${value}>`;
      }
      
      function formatTerm(term, prefixes = {}) {
        if (term.type === 'iri') return compactIRI(term.value, prefixes);
        if (term.type === 'blank') return `_:${term.value}`;
        if (term.type === 'var') return `?${term.value}`;
        if (term.type === 'triple') return `<<(${formatTerm(term.s, prefixes)} ${formatTerm(term.p, prefixes)} ${formatTerm(term.o, prefixes)})>>`;
        if (term.type === 'literal') {
          const v = term.value;
          if (typeof v === 'bigint' && !term.lang && (!term.datatype || term.datatype === XSD_INTEGER)) return String(v);
          if (typeof v === 'number' && Number.isFinite(v) && !term.lang && (!term.datatype || term.datatype === XSD_INTEGER || term.datatype === XSD_DECIMAL || term.datatype === XSD_DOUBLE)) return String(v);
          if (typeof v === 'boolean' && !term.lang && (!term.datatype || term.datatype === XSD_BOOLEAN)) return v ? 'true' : 'false';
          const lexical = `"${escapeString(v)}"`;
          if (term.lang) return `${lexical}@${term.lang}${term.langDir ? `--${term.langDir}` : ''}`;
          if (term.datatype && term.datatype !== XSD_STRING) return `${lexical}^^${compactIRI(term.datatype, prefixes)}`;
          return lexical;
        }
        return String(term.value ?? term);
      }
      
      function formatTriple(triple, prefixes = {}) {
        return `${formatTerm(triple.s, prefixes)} ${formatTerm(triple.p, prefixes)} ${formatTerm(triple.o, prefixes)} .`;
      }
      
      module.exports = {
        RDF_NS,
        RDF_TYPE,
        RDF_FIRST,
        RDF_REST,
        RDF_NIL,
        RDF_REIFIES,
        XSD_STRING,
        XSD_BOOLEAN,
        XSD_INTEGER,
        XSD_DECIMAL,
        XSD_DOUBLE,
        iri,
        variable,
        blankNode,
        literal,
        tripleTerm,
        isVariable,
        isIRI,
        isBlank,
        isLiteral,
        isTripleTerm,
        termEquals,
        termKey,
        tripleKey,
        cloneTerm,
        valueToTerm,
        inferDatatype,
        termToPrimitive,
        termToString,
        booleanValue,
        comparePrimitives,
        compactIRI,
        formatTerm,
        formatTriple,
      };
      
    },
    "src/assignments.js": function (require, module, exports) {
      'use strict';
      
      // SPARQL 1.2 RL run-once rules are exactly rules with an assignment element
      // or a blank node in the rule head. See SPARQL-RL §4.4.
      function assignmentsNeedRunOnce(clauses = []) {
        return clauses.some((clause) => clause.type === 'set' || clause.type === 'bind');
      }
      
      function ruleNeedsRunOnce(head = [], body = []) {
        return assignmentsNeedRunOnce(body) || head.some(tripleHasBlankNode);
      }
      
      function tripleHasBlankNode(triple) {
        return termHasBlankNode(triple && triple.s)
          || termHasBlankNode(triple && triple.p)
          || termHasBlankNode(triple && triple.o);
      }
      
      function termHasBlankNode(term) {
        if (!term) return false;
        if (term.type === 'blank') return true;
        if (term.type === 'triple') return termHasBlankNode(term.s) || termHasBlankNode(term.p) || termHasBlankNode(term.o);
        return false;
      }
      
      module.exports = { assignmentsNeedRunOnce, ruleNeedsRunOnce, tripleHasBlankNode, termHasBlankNode };
      
    },
    "src/rdf.js": function (require, module, exports) {
      'use strict';
      
      const { iri, variable, blankNode, literal, tripleTerm, XSD_STRING, XSD_BOOLEAN, XSD_INTEGER, XSD_DECIMAL, XSD_DOUBLE } = require('./term.js');
      
      const CONTENT_TYPES = Object.freeze({
        turtle: 'text/turtle',
        trig: 'application/trig',
        ntriples: 'application/n-triples',
        nquads: 'application/n-quads',
        n3: 'text/n3',
        jsonld: 'application/ld+json',
        rdfxml: 'application/rdf+xml',
      });
      
      /**
       * Parse an RDF 1.2 document through rdf-parse.js.
       *
       * Eyeleng deliberately does not maintain a second RDF parser. rdf-parse 5.x
       * selects the concrete RDF parser and exposes RDF/JS quads, including RDF 1.2
       * triple terms where the selected syntax supports them.
       */
      async function parseRdfDocument(source, options = {}) {
        const { Readable } = require('readable-stream');
        const { rdfParser } = require('rdf-parse');
        const { default: dataFactory } = await import('@rdfjs/data-model');
        const prefixes = { ...(options.prefixes || {}) };
        const parseOptions = rdfParseOptions(options);
        parseOptions.dataFactory = dataFactory;
      
        const stream = rdfParser.parse(Readable.from([String(source ?? '')]), parseOptions);
        stream.on('prefix', (prefix, value) => {
          prefixes[String(prefix)] = value && value.value ? value.value : String(value);
        });
      
        const quads = [];
        for await (const quad of stream) quads.push(quad);
        const triples = quads.map((quad) => {
          const triple = {
            s: rdfJsTermToTerm(quad.subject),
            p: rdfJsTermToTerm(quad.predicate),
            o: rdfJsTermToTerm(quad.object),
          };
          if (quad.graph && quad.graph.termType !== 'DefaultGraph') triple.graph = rdfJsTermToTerm(quad.graph);
          return triple;
        });
      
        return {
          baseIRI: options.baseIRI || options.base || null,
          prefixes,
          triples,
          quads,
        };
      }
      
      function rdfParseOptions(options = {}) {
        const out = {};
        const contentType = options.contentType || CONTENT_TYPES[options.profile] || CONTENT_TYPES[options.format];
        if (contentType) out.contentType = contentType;
        else if (options.filename && !/^<.*>$/.test(options.filename)) {
          const cleanFilename = String(options.filename).replace(/[?#].*$/, '');
          if (/\.[A-Za-z0-9]+$/.test(cleanFilename)) out.path = cleanFilename;
          else out.contentType = 'text/turtle';
        } else out.contentType = 'text/turtle';
        if (options.baseIRI || options.base) out.baseIRI = options.baseIRI || options.base;
        // rdf-parse 5.x supports RDF 1.2 parser selection/version announcements.
        out.version = options.version || '1.2';
        if (options.parseUnsupportedVersions) out.parseUnsupportedVersions = true;
        return out;
      }
      
      function rdfJsTermToTerm(term) {
        if (!term) return null;
        if (term.termType === 'NamedNode') return iri(term.value);
        if (term.termType === 'BlankNode') return blankNode(term.value);
        if (term.termType === 'Variable') return variable(term.value);
        if (term.termType === 'Literal') {
          const datatype = term.datatype && term.datatype.value ? term.datatype.value : null;
          const lang = term.language || null;
          const direction = term.direction || null;
          const value = coerceLexicalLiteral(term.value, datatype);
          return literal(value, datatype === XSD_STRING ? null : datatype, lang, direction);
        }
        // RDF/JS represents an RDF 1.2 triple term as a Quad in term position.
        if (term.termType === 'Quad') {
          return tripleTerm(rdfJsTermToTerm(term.subject), rdfJsTermToTerm(term.predicate), rdfJsTermToTerm(term.object));
        }
        if (term.termType === 'DefaultGraph') return null;
        throw new Error(`Unsupported RDF/JS term type ${term.termType || typeof term}`);
      }
      
      function parseIntegerLiteral(value) {
        const text = String(value);
        const asNumber = Number.parseInt(text, 10);
        return Number.isSafeInteger(asNumber) && String(asNumber) === text.replace(/^\+/, '') ? asNumber : BigInt(text);
      }
      
      function coerceLexicalLiteral(value, datatype) {
        if (datatype === XSD_INTEGER) return parseIntegerLiteral(value);
        if (datatype === XSD_DECIMAL || datatype === XSD_DOUBLE) return Number(value);
        if (datatype === XSD_BOOLEAN) return value === true || value === 'true' || value === '1';
        return value;
      }
      
      module.exports = { parseRdfDocument, rdfParseOptions, rdfJsTermToTerm, CONTENT_TYPES };
      
    },
    "src/rdfMessages.js": function (require, module, exports) {
      'use strict';
      
      const { parseRdfDocument } = require('./rdf.js');
      const {
        iri,
        blankNode,
        literal,
        tripleTerm,
        RDF_TYPE,
        RDF_FIRST,
        RDF_REST,
        RDF_NIL,
        XSD_INTEGER,
      } = require('./term.js');
      
      const RDF_MESSAGE_VERSION_RE = /^\s*(?:@version|VERSION)\s+(["'])(?:1\.1|1\.2|1\.2-basic)-messages\1\s*\.?\s*(?:#.*)?$/im;
      const RDF_MESSAGE_VERSION_LINE_RE = /^\s*(?:@version|VERSION)\s+(["'])(?:1\.1|1\.2|1\.2-basic)-messages\1\s*\.?\s*(?:#.*)?$/i;
      const RDF_DIRECTIVE_LINE_RE = /^\s*(?:@?(?:prefix|base)\b|PREFIX\b|BASE\b)/i;
      const RDF_MESSAGE_DELIMITER_LINE_RE = /^\s*(?:MESSAGE\b|@message\s*\.?)\s*(?:#.*)?$/i;
      
      const EYMSG_NS = 'https://eyereasoner.github.io/eyeling/vocab/message#';
      const LOG_NS = 'http://www.w3.org/2000/10/swap/log#';
      const EYMSG = Object.freeze({
        RDFMessageStream: `${EYMSG_NS}RDFMessageStream`,
        MessageEnvelope: `${EYMSG_NS}MessageEnvelope`,
        envelope: `${EYMSG_NS}envelope`,
        firstEnvelope: `${EYMSG_NS}firstEnvelope`,
        lastEnvelope: `${EYMSG_NS}lastEnvelope`,
        orderedEnvelopes: `${EYMSG_NS}orderedEnvelopes`,
        messageCount: `${EYMSG_NS}messageCount`,
        offset: `${EYMSG_NS}offset`,
        nextEnvelope: `${EYMSG_NS}nextEnvelope`,
        payloadGraph: `${EYMSG_NS}payloadGraph`,
        payloadKind: `${EYMSG_NS}payloadKind`,
        payloadTriple: `${EYMSG_NS}payloadTriple`,
        tripleCount: `${EYMSG_NS}tripleCount`,
        empty: `${EYMSG_NS}empty`,
        nonEmpty: `${EYMSG_NS}nonEmpty`,
      });
      const LOG_NAME_OF = `${LOG_NS}nameOf`;
      
      function simpleHashText(value) {
        let h = 0x811c9dc5;
        const text = String(value || '');
        for (let i = 0; i < text.length; i += 1) {
          h ^= text.charCodeAt(i);
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(16).padStart(8, '0');
      }
      
      function looksLikeRdfMessageLog(source, options = {}) {
        return !!options.rdfMessages || RDF_MESSAGE_VERSION_RE.test(String(source || ''));
      }
      
      function splitPreservingLineEndings(text) {
        return String(text || '').match(/.*(?:\r\n|\n|\r)|.+$/g) || [];
      }
      
      function isOnlyWhitespaceAndComments(text) {
        return splitPreservingLineEndings(text).every((line) => {
          const hash = line.indexOf('#');
          const body = hash >= 0 ? line.slice(0, hash) : line;
          return body.trim() === '';
        });
      }
      
      function stripMessageVersionLines(text) {
        return splitPreservingLineEndings(text).filter((line) => !RDF_MESSAGE_VERSION_LINE_RE.test(line)).join('');
      }
      
      function stripDirectiveLines(text) {
        return splitPreservingLineEndings(text).filter((line) => !RDF_DIRECTIVE_LINE_RE.test(line) && !RDF_MESSAGE_VERSION_LINE_RE.test(line)).join('');
      }
      
      function collectDirectiveLines(text) {
        const seen = new Set();
        const out = [];
        for (const line of splitPreservingLineEndings(text)) {
          if (!RDF_DIRECTIVE_LINE_RE.test(line)) continue;
          const key = line.trim();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push(line.endsWith('\n') || line.endsWith('\r') ? line : `${line}\n`);
        }
        return out;
      }
      
      function readStringAt(source, index) {
        const quote = source[index];
        const long = source.startsWith(quote.repeat(3), index);
        let i = index + (long ? 3 : 1);
        while (i < source.length) {
          if (source[i] === '\\') { i += 2; continue; }
          if (long && source.startsWith(quote.repeat(3), i)) return { end: i + 3 };
          if (!long && source[i] === quote) return { end: i + 1 };
          i += 1;
        }
        return { end: source.length };
      }
      
      function readIriAt(source, index) {
        let i = index + 1;
        while (i < source.length) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '>') return { end: i + 1 };
          i += 1;
        }
        return { end: source.length };
      }
      
      function skipWsAndComments(source, index) {
        let i = index;
        while (i < source.length) {
          if (/\s/.test(source[i])) { i += 1; continue; }
          if (source[i] === '#') {
            while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i += 1;
            continue;
          }
          break;
        }
        return i;
      }
      
      function isWordChar(ch) { return !!ch && /[A-Za-z0-9_\-]/.test(ch); }
      function startsWordAt(source, word, index) {
        return source.slice(index, index + word.length).toUpperCase() === word && !isWordChar(source[index - 1]) && !isWordChar(source[index + word.length]);
      }
      
      function findMessageDirectiveAt(source, index) {
        if (startsWordAt(source, 'MESSAGE', index)) return { start: index, end: index + 'MESSAGE'.length };
        if (source.slice(index, index + 8).toLowerCase() === '@message' && !isWordChar(source[index + 8])) {
          let end = index + 8;
          end = skipWsAndComments(source, end);
          if (source[end] === '.') end += 1;
          return { start: index, end };
        }
        return null;
      }
      
      function splitRdfMessageLog(source) {
        const text = stripMessageVersionLines(source);
        const chunks = [];
        let i = 0;
        let start = 0;
        let braceDepth = 0;
        let bracketDepth = 0;
        let parenDepth = 0;
        let statementStart = true;
        let sawDelimiter = false;
      
        while (i < text.length) {
          const ch = text[i];
          if (ch === '"' || ch === "'") { i = readStringAt(text, i).end; statementStart = false; continue; }
          if (ch === '<' && !text.startsWith('<<', i)) { i = readIriAt(text, i).end; statementStart = false; continue; }
          if (ch === '#') { while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1; statementStart = true; continue; }
      
          if (statementStart && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
            const termStart = skipWsAndComments(text, i);
            const directive = findMessageDirectiveAt(text, termStart);
            if (directive) {
              chunks.push(text.slice(start, termStart));
              start = directive.end;
              i = directive.end;
              statementStart = true;
              sawDelimiter = true;
              continue;
            }
            if (termStart !== i) { i = termStart; continue; }
          }
      
          if (ch === '{') braceDepth += 1;
          else if (ch === '}' && braceDepth > 0) braceDepth -= 1;
          else if (ch === '[') bracketDepth += 1;
          else if (ch === ']' && bracketDepth > 0) bracketDepth -= 1;
          else if (ch === '(') parenDepth += 1;
          else if (ch === ')' && parenDepth > 0) parenDepth -= 1;
      
          if (ch === '.' && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) statementStart = true;
          else if (ch === '\n' || ch === '\r') statementStart = true;
          else if (!/\s/.test(ch)) statementStart = false;
          i += 1;
        }
      
        const tail = text.slice(start);
        if (!sawDelimiter || !isOnlyWhitespaceAndComments(tail)) chunks.push(tail);
        return chunks;
      }
      
      function rewriteMessageBlankLabels(source, messageIndex) {
        const prefix = `msg${String(messageIndex).padStart(3, '0')}_`;
        let out = '';
        let i = 0;
        while (i < source.length) {
          const ch = source[i];
          if (ch === '"' || ch === "'") {
            const end = readStringAt(source, i).end;
            out += source.slice(i, end);
            i = end;
            continue;
          }
          if (ch === '<' && !source.startsWith('<<', i)) {
            const end = readIriAt(source, i).end;
            out += source.slice(i, end);
            i = end;
            continue;
          }
          if (ch === '#') {
            while (i < source.length) {
              const c = source[i++]; out += c;
              if (c === '\n' || c === '\r') break;
            }
            continue;
          }
          if (source.startsWith('_:', i)) {
            let j = i + 2;
            while (j < source.length && !/\s/.test(source[j]) && !'{}[](),;.<>'.includes(source[j])) j += 1;
            const label = source.slice(i + 2, j);
            if (label) {
              out += `_:${prefix}${label.replace(/[^A-Za-z0-9_\-]/g, '_')}`;
              i = j;
              continue;
            }
          }
          out += ch;
          i += 1;
        }
        return out;
      }
      
      function messageChunkHasRdf(chunk) {
        return !isOnlyWhitespaceAndComments(stripDirectiveLines(chunk));
      }
      
      function listTriples(headTerm, items, data, makeBlank) {
        if (items.length === 0) return iri(RDF_NIL);
        const cells = items.map(() => makeBlank());
        for (let i = 0; i < cells.length; i += 1) {
          data.push({ s: cells[i], p: iri(RDF_FIRST), o: items[i] });
          data.push({ s: cells[i], p: iri(RDF_REST), o: i + 1 < cells.length ? cells[i + 1] : iri(RDF_NIL) });
        }
        return headTerm || cells[0];
      }
      
      async function parseRdfMessageLog(source, options = {}) {
        const text = String(source || '');
        const directives = collectDirectiveLines(text);
        const chunks = splitRdfMessageLog(text);
        // Keep generated message-log IRIs stable across machines and checkout paths.
        // The previous seed used baseIRI/filename, which made golden outputs depend on
        // absolute local paths such as file:///home/.../examples/rdf-messages.trig.
        // A caller that needs a location-specific identity can still pass
        // options.messageBaseIRI explicitly.
        const hash = simpleHashText(text);
        const base = options.messageBaseIRI || `urn:eyeleng:message-log:${hash}`;
        const stream = iri(`${base}#stream`);
        const envelopes = chunks.map((unused, index) => iri(`${base}#m${String(index + 1).padStart(3, '0')}`));
        const payloads = chunks.map((unused, index) => iri(`${base}#m${String(index + 1).padStart(3, '0')}/payload`));
        const data = [];
        let bnodeCounter = 0;
        const makeBlank = () => blankNode(`msg${++bnodeCounter}`);
        const prefixes = {
          rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
          xsd: 'http://www.w3.org/2001/XMLSchema#',
          eymsg: EYMSG_NS,
          log: LOG_NS,
        };
      
        data.push({ s: stream, p: iri(RDF_TYPE), o: iri(EYMSG.RDFMessageStream) });
        data.push({ s: stream, p: iri(EYMSG.messageCount), o: literal(chunks.length, XSD_INTEGER) });
        if (envelopes.length > 0) {
          data.push({ s: stream, p: iri(EYMSG.orderedEnvelopes), o: listTriples(null, envelopes, data, makeBlank) });
          data.push({ s: stream, p: iri(EYMSG.firstEnvelope), o: envelopes[0] });
          data.push({ s: stream, p: iri(EYMSG.lastEnvelope), o: envelopes[envelopes.length - 1] });
        }
      
        for (let i = 0; i < chunks.length; i += 1) {
          const envelope = envelopes[i];
          const payload = payloads[i];
          const rawChunk = chunks[i];
          const chunk = rewriteMessageBlankLabels(rawChunk, i + 1);
          const hasBody = messageChunkHasRdf(chunk);
          const bodySource = `${directives.join('')}\n${stripDirectiveLines(chunk)}`;
          const parsed = hasBody ? await parseRdfDocument(bodySource, { ...options, filename: `${options.filename || '<message>'}#m${i + 1}`, baseIRI: options.baseIRI }) : { triples: [], prefixes: {} };
          Object.assign(prefixes, parsed.prefixes || {});
          const payloadTriples = parsed.triples || [];
          const tripleTerms = payloadTriples.map((t) => tripleTerm(t.s, t.p, t.o));
      
          data.push({ s: stream, p: iri(EYMSG.envelope), o: envelope });
          data.push({ s: envelope, p: iri(RDF_TYPE), o: iri(EYMSG.MessageEnvelope) });
          data.push({ s: envelope, p: iri(EYMSG.offset), o: literal(i + 1, XSD_INTEGER) });
          data.push({ s: envelope, p: iri(EYMSG.payloadKind), o: iri(hasBody ? EYMSG.nonEmpty : EYMSG.empty) });
          data.push({ s: envelope, p: iri(EYMSG.tripleCount), o: literal(payloadTriples.length, XSD_INTEGER) });
          if (i + 1 < envelopes.length) data.push({ s: envelope, p: iri(EYMSG.nextEnvelope), o: envelopes[i + 1] });
          if (hasBody) {
            data.push({ s: envelope, p: iri(EYMSG.payloadGraph), o: payload });
            data.push({ s: payload, p: iri(LOG_NAME_OF), o: listTriples(null, tripleTerms, data, makeBlank) });
            for (const term of tripleTerms) data.push({ s: payload, p: iri(EYMSG.payloadTriple), o: term });
            if (options.includeMessageFacts) data.push(...payloadTriples);
          }
        }
      
        return {
          baseIRI: options.baseIRI || null,
          version: '1.2-messages',
          imports: [],
          prefixes,
          // RDF Message Logs are an ancillary RDF input format. Their envelope
          // graph is base data, not a SPARQL-RL DATA block / inference graph.
          baseData: data,
          data: [],
          rules: [],
        };
      }
      
      module.exports = {
        EYMSG_NS,
        EYMSG,
        LOG_NS,
        LOG_NAME_OF,
        looksLikeRdfMessageLog,
        splitRdfMessageLog,
        parseRdfMessageLog,
      };
      
    },
    "src/engine.js": function (require, module, exports) {
      'use strict';
      
      const { TripleStore, bindingKey, instantiateTerm } = require('./store.js');
      const { tripleKey, termKey, termEquals, iri, blankNode, literal, tripleTerm } = require('./term.js');
      const { evalExpression, booleanValue, asTerm } = require('./builtins.js');
      const { analyze } = require('./analyze.js');
      
      function evaluate(program, options = {}) {
        const maxIterations = options.maxIterations ?? 10000;
        const evalOptions = { ...options, baseIRI: options.baseIRI || program.baseIRI || null, now: options.now || new Date(), __bnodeLabels: options.__bnodeLabels || new Map() };
        const baseData = (program.baseData || []).slice();
        const ruleData = (program.data || []).slice();
        const store = new TripleStore([...baseData, ...ruleData]);
        // SPARQL-RL ground data is the external base graph only. DATA blocks are
        // rule-set facts and therefore belong to the inference graph.
        const groundStore = new TripleStore(baseData);
        const inputKeys = new Set(baseData.map(tripleKey));
        const inferred = [];
        const inferredKeys = new Set();
        for (const triple of ruleData) {
          const key = tripleKey(triple);
          if (!inputKeys.has(key) && !inferredKeys.has(key)) { inferred.push(triple); inferredKeys.add(key); }
        }
        const trace = options.trace || options.prove ? [] : null;
        let iterations = 0;
        let ruleApplications = 0;
        const perRule = program.rules.map((rule, index) => ({
          name: rule.name || `rule#${index + 1}`,
          applications: 0,
          added: 0,
          runOnce: !!rule.runOnce,
        }));
      
        const analysis = options.analysis || analyze(program, options);
        if (analysis.errors && analysis.errors.length > 0 && !options.ignoreAnalysisErrors) {
          throw new Error(`Analysis failed: ${analysis.errors.map((error) => error.message).join('; ')}`);
        }
        const layerIndexes = analysis.dependency && analysis.dependency.layerIndexes
          ? analysis.dependency.layerIndexes
          : [program.rules.map((_, index) => index)];
        const recursiveLayerFlags = computeRecursiveLayerFlags(
          layerIndexes,
          analysis.dependency ? analysis.dependency.edges : [],
        );
        const baseContext = {
          ...evalOptions,
          maxIterations,
          inputKeys,
          inferred,
          trace,
          perRule,
          layer: 0,
          iteration: 0,
          startingIterations: 0,
          recursiveLayer: false,
          groundStore,
        };
      
        for (let layerIndex = 0; layerIndex < layerIndexes.length; layerIndex += 1) {
          const layer = layerIndexes[layerIndex];
          baseContext.layer = layerIndex + 1;
          const ordinary = layer.filter((ruleIndex) => !program.rules[ruleIndex].runOnce);
          const runOnce = layer.filter((ruleIndex) => program.rules[ruleIndex].runOnce);
      
          if (runOnce.length > 0) {
            iterations += 1;
            for (const ruleIndex of runOnce) {
              baseContext.iteration = iterations;
              const added = applyRuleOnce(program, store, ruleIndex, baseContext);
              ruleApplications += added.applications;
            }
          }
      
          baseContext.startingIterations = iterations;
          baseContext.recursiveLayer = recursiveLayerFlags[layerIndex];
          const ordinaryResult = runRulesToFixpoint(program, store, ordinary, baseContext);
          iterations = ordinaryResult.iterations;
          ruleApplications += ordinaryResult.ruleApplications;
        }
      
        return {
          baseIRI: program.baseIRI,
          version: program.version || null,
          imports: program.imports || [],
          prefixes: program.prefixes,
          input: baseData,
          data: ruleData,
          inferred,
          closure: store.values(),
          iterations,
          layers: layerIndexes.map((layer) => layer.map((ruleIndex) => perRule[ruleIndex].name)),
          ruleApplications,
          perRule,
          trace: trace || [],
          groundStore,
        };
      }
      
      
      async function evaluateAsync(program, options = {}) {
        const maxIterations = options.maxIterations ?? 10000;
        const evalOptions = { ...options, baseIRI: options.baseIRI || program.baseIRI || null, now: options.now || new Date(), __bnodeLabels: options.__bnodeLabels || new Map() };
        const baseData = (program.baseData || []).slice();
        const ruleData = (program.data || []).slice();
        const store = new TripleStore([...baseData, ...ruleData]);
        // SPARQL-RL ground data is the external base graph only. DATA blocks are
        // rule-set facts and therefore belong to the inference graph.
        const groundStore = new TripleStore(baseData);
        const inputKeys = new Set(baseData.map(tripleKey));
        const inferred = [];
        const inferredKeys = new Set();
        for (const triple of ruleData) {
          const key = tripleKey(triple);
          if (!inputKeys.has(key) && !inferredKeys.has(key)) { inferred.push(triple); inferredKeys.add(key); }
        }
        const trace = options.trace || options.prove ? [] : null;
        let iterations = 0;
        let ruleApplications = 0;
        const perRule = program.rules.map((rule, index) => ({
          name: rule.name || `rule#${index + 1}`,
          applications: 0,
          added: 0,
          runOnce: !!rule.runOnce,
        }));
      
        const analysis = options.analysis || analyze(program, options);
        if (analysis.errors && analysis.errors.length > 0 && !options.ignoreAnalysisErrors) {
          throw new Error(`Analysis failed: ${analysis.errors.map((error) => error.message).join('; ')}`);
        }
        const layerIndexes = analysis.dependency && analysis.dependency.layerIndexes
          ? analysis.dependency.layerIndexes
          : [program.rules.map((_, index) => index)];
        const recursiveLayerFlags = computeRecursiveLayerFlags(
          layerIndexes,
          analysis.dependency ? analysis.dependency.edges : [],
        );
        const baseContext = {
          ...evalOptions,
          maxIterations,
          inputKeys,
          inferred,
          trace,
          perRule,
          layer: 0,
          iteration: 0,
          startingIterations: 0,
          recursiveLayer: false,
          groundStore,
        };
      
        for (let layerIndex = 0; layerIndex < layerIndexes.length; layerIndex += 1) {
          const layer = layerIndexes[layerIndex];
          baseContext.layer = layerIndex + 1;
          const ordinary = layer.filter((ruleIndex) => !program.rules[ruleIndex].runOnce);
          const runOnce = layer.filter((ruleIndex) => program.rules[ruleIndex].runOnce);
      
          if (runOnce.length > 0) {
            iterations += 1;
            for (const ruleIndex of runOnce) {
              baseContext.iteration = iterations;
              const added = applyRuleOnce(program, store, ruleIndex, baseContext);
              ruleApplications += added.applications;
            }
          }
      
          baseContext.startingIterations = iterations;
          baseContext.recursiveLayer = recursiveLayerFlags[layerIndex];
          const ordinaryResult = runRulesToFixpoint(program, store, ordinary, baseContext);
          iterations = ordinaryResult.iterations;
          ruleApplications += ordinaryResult.ruleApplications;
        }
      
        return {
          baseIRI: program.baseIRI,
          version: program.version || null,
          imports: program.imports || [],
          prefixes: program.prefixes,
          input: baseData,
          data: ruleData,
          inferred,
          closure: store.values(),
          iterations,
          layers: layerIndexes.map((layer) => layer.map((ruleIndex) => perRule[ruleIndex].name)),
          ruleApplications,
          perRule,
          trace: trace || [],
          groundStore,
        };
      }
      
      function runRulesToFixpoint(program, store, ruleIndexes, context) {
        if (ruleIndexes.length === 0) return { iterations: context.startingIterations, ruleApplications: 0 };
      
        // A stratum may contain only acyclic rule components. Such rules only need a
        // single pass after lower strata have reached their fixpoints; spending an
        // extra no-change pass per layer makes deep taxonomies look non-terminating.
        if (!context.recursiveLayer) {
          const iteration = context.startingIterations + 1;
          let ruleApplications = 0;
          for (const ruleIndex of ruleIndexes) {
            context.iteration = iteration;
            const applied = applyRuleOnce(program, store, ruleIndex, context);
            ruleApplications += applied.applications;
          }
          return { iterations: iteration, ruleApplications };
        }
      
        let iterations = context.startingIterations;
        let localIterations = 0;
        let ruleApplications = 0;
      
        while (localIterations < context.maxIterations) {
          localIterations += 1;
          iterations += 1;
          let addedInIteration = 0;
      
          for (const ruleIndex of ruleIndexes) {
            context.iteration = iterations;
            const applied = applyRuleOnce(program, store, ruleIndex, context);
            addedInIteration += applied.added;
            ruleApplications += applied.applications;
          }
      
          if (addedInIteration === 0) break;
        }
      
        if (localIterations >= context.maxIterations) {
          throw new Error(`Reached maxIterations=${context.maxIterations} within layer ${context.layer}; rules may not terminate`);
        }
      
        return { iterations, ruleApplications };
      }
      
      function computeRecursiveLayerFlags(layerIndexes, edges = []) {
        const flags = Array(layerIndexes.length).fill(false);
        const layerOfRule = new Map();
        for (let layerIndex = 0; layerIndex < layerIndexes.length; layerIndex += 1) {
          for (const ruleIndex of layerIndexes[layerIndex]) layerOfRule.set(ruleIndex, layerIndex);
        }
        for (const edge of edges) {
          const fromLayer = layerOfRule.get(edge.from);
          if (fromLayer === undefined) continue;
          if (fromLayer === layerOfRule.get(edge.to)) flags[fromLayer] = true;
        }
        return flags;
      }
      
      
      function applyRuleOnce(program, store, ruleIndex, context) {
        const rule = program.rules[ruleIndex];
        let applications = 0;
        let added = 0;
        const dedupeBindings = rule.body.some((clause) => clause.type === 'path');
        const seenBindings = dedupeBindings ? new Set() : null;
        const headBlankLabels = collectHeadBlankLabels(rule.head);
      
        const bodyStore = rule.groundData ? context.groundStore : store;
        const bodyContext = { ...context };
        if (!context.trace && headBlankLabels.size === 0 && rule.body.every((clause) => clause.type === 'triple')) {
          bodyContext.retainedBodyVariables = collectVariables(rule.head);
        }
        const initialBindings = [{}];
        const bodyBindings = evaluateRuleBodyBindings(rule, bodyStore, bodyContext, initialBindings);
      
        for (const binding of bodyBindings) {
          if (seenBindings) {
            const key = bindingKey(binding);
            if (seenBindings.has(key)) continue;
            seenBindings.add(key);
          }
          applications += 1;
          context.perRule[ruleIndex].applications += 1;
      
          const headBlankMap = headBlankLabels.size > 0 ? new Map() : null;
          const skolemKey = headBlankMap ? skolemizationKey(ruleIndex, binding) : null;
          for (const head of rule.head) {
            const triple = instantiateHeadTriple(head, binding, headBlankLabels, headBlankMap, skolemKey);
            if (!triple) continue;
            if (store.add(triple)) {
              added += 1;
              context.perRule[ruleIndex].added += 1;
              if (!context.inputKeys.has(tripleKey(triple))) context.inferred.push(triple);
              if (context.trace) {
                context.trace.push({
                  layer: context.layer,
                  iteration: context.iteration,
                  rule: rule.name || `rule#${ruleIndex + 1}`,
                  triple,
                  binding,
                  uses: proofUses(rule.body, binding),
                });
              }
            }
          }
        }
      
        return { applications, added };
      }
      
      function* evaluateRuleBodyBindings(rule, bodyStore, bodyContext, initialBindings) {
        for (const initialBinding of initialBindings) {
          if (rule.body.length === 1 && rule.body[0].type === 'triple') {
            yield* bodyStore.match(rule.body[0].triple, initialBinding);
          } else {
            yield* evaluateBodyStream(rule.body, bodyStore, initialBinding, bodyContext);
          }
        }
      }
      
      function proofUses(body, binding) {
        return body
          .filter((clause) => clause.type === 'triple')
          .map((clause) => ({
            s: instantiateTerm(clause.triple.s, binding),
            p: instantiateTerm(clause.triple.p, binding),
            o: instantiateTerm(clause.triple.o, binding),
          }))
          .filter((triple) => ![triple.s, triple.p, triple.o].some((term) => term && term.type === 'var'));
      }
      
      function instantiateHeadTriple(pattern, binding, headBlankLabels, headBlankMap, skolemKey) {
        const s = instantiateHeadTerm(pattern.s, binding, headBlankLabels, headBlankMap, skolemKey);
        const p = instantiateHeadTerm(pattern.p, binding, headBlankLabels, headBlankMap, skolemKey);
        const o = instantiateHeadTerm(pattern.o, binding, headBlankLabels, headBlankMap, skolemKey);
        if (!s || !p || !o) return null;
        if (p.type !== 'iri') return null;
        return { s, p, o };
      }
      
      function instantiateHeadTerm(term, binding, headBlankLabels, headBlankMap, skolemKey) {
        if (term.type === 'var') return binding[term.value] || null;
        if (term.type === 'blank' && headBlankLabels.has(term.value)) {
          let label = headBlankMap.get(term.value);
          if (!label) {
            label = `sk_${deterministicSkolemIdFromKey(`${skolemKey}|${term.value}`).replace(/-/g, '_')}`;
            headBlankMap.set(term.value, label);
          }
          return blankNode(label);
        }
        if (term.type === 'triple') {
          const s = instantiateHeadTerm(term.s, binding, headBlankLabels, headBlankMap, skolemKey);
          const p = instantiateHeadTerm(term.p, binding, headBlankLabels, headBlankMap, skolemKey);
          const o = instantiateHeadTerm(term.o, binding, headBlankLabels, headBlankMap, skolemKey);
          if (!s || !p || !o) return null;
          return tripleTerm(s, p, o);
        }
        return term;
      }
      
      function collectHeadBlankLabels(head) {
        const labels = new Set();
        for (const triple of head || []) {
          collectBlankLabelsFromTerm(triple.s, labels);
          collectBlankLabelsFromTerm(triple.p, labels);
          collectBlankLabelsFromTerm(triple.o, labels);
        }
        return labels;
      }
      
      function collectBlankLabelsFromTerm(term, labels) {
        if (!term) return;
        if (term.type === 'blank') {
          labels.add(term.value);
          return;
        }
        if (term.type === 'triple') {
          collectBlankLabelsFromTerm(term.s, labels);
          collectBlankLabelsFromTerm(term.p, labels);
          collectBlankLabelsFromTerm(term.o, labels);
        }
      }
      
      function skolemizationKey(ruleIndex, binding) {
        let out = `rule:${ruleIndex}`;
        for (const name of Object.keys(binding).sort()) {
          const value = binding[name];
          out += `|${name}=${value ? termKey(value) : 'unbound'}`;
        }
        return out;
      }
      
      function deterministicSkolemIdFromKey(key) {
        let h1 = 0x811c9dc5;
        let h2 = 0x811c9dc5;
        let h3 = 0x811c9dc5;
        let h4 = 0x811c9dc5;
        for (let i = 0; i < key.length; i += 1) {
          const c = key.charCodeAt(i);
          h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
          h2 ^= c + 1; h2 = Math.imul(h2, 0x01000193) >>> 0;
          h3 ^= c + 2; h3 = Math.imul(h3, 0x01000193) >>> 0;
          h4 ^= c + 3; h4 = Math.imul(h4, 0x01000193) >>> 0;
        }
        return [h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, '0')).join('');
      }
      
      
      function evaluateBody(clauses, store, initialBinding = {}, options = {}) {
        const bindings = [];
        const seen = new Set();
        for (const binding of evaluateBodyStream(clauses, store, initialBinding, options)) {
          const key = bindingKey(binding);
          if (seen.has(key)) continue;
          seen.add(key);
          bindings.push(binding);
        }
        return bindings;
      }
      
      function* evaluateBodyStream(clauses, store, initialBinding = {}, options = {}, index = 0) {
        const plannedClauses = options.trace ? clauses : planBodyClauses(clauses);
        if (index >= plannedClauses.length) {
          yield initialBinding;
          return;
        }
        const stack = [{
          index,
          iterator: evaluateBodyClause(plannedClauses[index], store, initialBinding, options),
        }];
        const dropAfter = options.retainedBodyVariables
          ? bodyVariableLastUses(plannedClauses, options.retainedBodyVariables)
          : null;
        while (stack.length > 0) {
          const frame = stack[stack.length - 1];
          const next = frame.iterator.next();
          if (next.done) {
            stack.pop();
            continue;
          }
          const binding = dropAfter ? dropBindingVariables(next.value, dropAfter[frame.index]) : next.value;
          const nextIndex = frame.index + 1;
          if (nextIndex >= plannedClauses.length) {
            yield binding;
            continue;
          }
          stack.push({
            index: nextIndex,
            iterator: evaluateBodyClause(plannedClauses[nextIndex], store, binding, options),
          });
        }
      }
      function planBodyClauses(clauses) {
        const planned = [];
        for (let index = 0; index < clauses.length;) {
          const tuple = listTuplePatternAt(clauses, index);
          if (tuple) {
            planned.push({ type: 'listTuple', tuple });
            index += 7;
          } else {
            planned.push(clauses[index]);
            index += 1;
          }
        }
        return planned;
      }
      function listTuplePatternAt(clauses, index) {
        const group = clauses.slice(index, index + 7);
        if (group.length !== 7 || group.some((clause) => clause.type !== 'triple')) return null;
        const triples = group.map((clause) => clause.triple);
        const [first1, rest1, first2, rest2, first3, rest3, relation] = triples;
        if (!isPredicate(first1, 'first') || !isPredicate(rest1, 'rest')
          || !isPredicate(first2, 'first') || !isPredicate(rest2, 'rest')
          || !isPredicate(first3, 'first') || !isPredicate(rest3, 'rest')) return null;
        if (!sameVariable(first1.s, rest1.s) || !sameVariable(rest1.o, first2.s)
          || !sameVariable(first2.s, rest2.s) || !sameVariable(rest2.o, first3.s)
          || !sameVariable(first3.s, rest3.s) || !sameVariable(first1.s, relation.s)) return null;
        if (!rest3.o || rest3.o.type !== 'iri' || rest3.o.value !== 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil') return null;
        return { s: first1.s, p: relation.p, o: relation.o, items: [first1.o, first2.o, first3.o] };
      }
      function isPredicate(triple, localName) {
        return triple.p && triple.p.type === 'iri'
          && triple.p.value === `http://www.w3.org/1999/02/22-rdf-syntax-ns#${localName}`;
      }
      function sameVariable(left, right) {
        return left && right && left.type === 'var' && right.type === 'var' && left.value === right.value;
      }
      function bodyVariableLastUses(clauses, retainedVariables) {
        const lastUse = new Map();
        for (let index = 0; index < clauses.length; index += 1) {
          for (const name of collectVariables(clauses[index])) lastUse.set(name, index);
        }
        const dropAfter = Array.from({ length: clauses.length }, () => []);
        for (const [name, index] of lastUse) {
          if (!retainedVariables.has(name)) dropAfter[index].push(name);
        }
        return dropAfter;
      }
      function collectVariables(value, variables = new Set(), seen = new Set()) {
        if (!value || typeof value !== 'object' || seen.has(value)) return variables;
        seen.add(value);
        if (value.type === 'var' && typeof value.value === 'string') {
          variables.add(value.value);
          return variables;
        }
        if (Array.isArray(value)) {
          for (const item of value) collectVariables(item, variables, seen);
        } else {
          for (const item of Object.values(value)) collectVariables(item, variables, seen);
        }
        return variables;
      }
      function dropBindingVariables(binding, names) {
        if (names.length === 0 || !names.some((name) => Object.hasOwn(binding, name))) return binding;
        const projected = { ...binding };
        for (const name of names) delete projected[name];
        return projected;
      }
      function* evaluateBodyClause(clause, store, initialBinding, options) {
        if (clause.type === 'listTuple') {
          yield* store.matchListTuple(clause.tuple, initialBinding);
          return;
        }
        if (clause.type === 'triple') {
          yield* store.match(clause.triple, initialBinding);
          return;
        }
      
        if (clause.type === 'path') {
          for (const matched of store.matchPath(clause.triple, initialBinding)) {
            yield matched;
          }
          return;
        }
      
        if (clause.type === 'filter') {
          try {
            if (booleanValue(evalExpression(clause.expr, initialBinding, options))) {
              yield initialBinding;
            }
          } catch (_) {
            // SPARQL-style FILTER errors reject the current solution.
          }
          return;
        }
      
        if (clause.type === 'set' || clause.type === 'bind') {
          try {
            const value = asTerm(evalExpression(clause.expr, initialBinding, options));
            if (!initialBinding[clause.variable]) {
              yield { ...initialBinding, [clause.variable]: value };
            } else if (termEquals(initialBinding[clause.variable], value)) {
              yield initialBinding;
            }
          } catch (_) {
            // The SRL evaluation sketch drops a solution when assignment evaluation errors.
          }
          return;
        }
      
        if (clause.type === 'not') {
          const negationStore = clause.groundData ? (options.groundStore || store) : store;
          if (!bodyHasAny(clause.body, negationStore, initialBinding, options)) {
            yield initialBinding;
          }
          return;
        }
      
        throw new Error(`Unsupported body clause ${clause.type}`);
      }
      
      function bodyHasAny(clauses, store, initialBinding, options) {
        for (const _ of evaluateBodyStream(clauses, store, initialBinding, options)) return true;
        return false;
      }
      
      function uniqueBindings(bindings) {
        const seen = new Set();
        const out = [];
        for (const binding of bindings) {
          const key = bindingKey(binding);
          if (!seen.has(key)) {
            seen.add(key);
            out.push(binding);
          }
        }
        return out;
      }
      
      module.exports = { evaluate, evaluateAsync, evaluateBody, uniqueBindings };
      
    },
    "src/store.js": function (require, module, exports) {
      'use strict';
      
      const { RDF_FIRST, RDF_REST, RDF_NIL, tripleKey, termKey, termEquals } = require('./term.js');
      
      class TripleStore {
        constructor(triples = []) {
          this.map = new Map();
          this.byPredicate = new Map();
          this.byPredicateSubject = new Map();
          this.byPredicateObject = new Map();
          this.deepIndexes = new Map();
          this.version = 0;
          for (const triple of triples) this.add(triple);
        }
      
        add(triple) {
          const normalized = normalizeTriple(triple);
          const key = tripleKey(normalized);
          if (this.map.has(key)) return false;
          this.map.set(key, normalized);
          const predicate = termKey(normalized.p);
          const subject = termKey(normalized.s);
          const object = termKey(normalized.o);
          addIndex(this.byPredicate, predicate, key, normalized);
          addNestedIndex(this.byPredicateSubject, predicate, subject, key, normalized);
          addNestedIndex(this.byPredicateObject, predicate, object, key, normalized);
          this.version += 1;
          this.deepIndexes.clear();
          return true;
        }
      
        has(triple) {
          return this.map.has(tripleKey(normalizeTriple(triple)));
        }
      
        values() {
          return Array.from(this.map.values());
        }
      
        size() {
          return this.map.size;
        }
      
        candidates(pattern, binding = {}) {
          const p = instantiateTerm(pattern.p, binding);
          if (p && p.type !== 'var') {
            const predicate = termKey(p);
            const s = instantiateTerm(pattern.s, binding);
            const o = instantiateTerm(pattern.o, binding);
            const bySubject = s && s.type !== 'var' ? nestedLookup(this.byPredicateSubject, predicate, termKey(s)) : null;
            const byObject = o && o.type !== 'var' ? nestedLookup(this.byPredicateObject, predicate, termKey(o)) : null;
            if (bySubject && byObject) return smallerValues(bySubject, byObject);
            if (bySubject) return Array.from(bySubject.values());
            if (byObject) return Array.from(byObject.values());
            const indexed = this.byPredicate.get(predicate);
            return indexed ? Array.from(indexed.values()) : [];
          }
          return this.values();
        }
      
        match(pattern, binding = {}) {
          const out = [];
          for (const triple of this.candidates(pattern, binding)) {
            const matched = matchTriple(pattern, triple, binding);
            if (matched) out.push(matched);
          }
          return out;
        }
        matchListTuple(pattern, binding = {}) {
          const predicate = instantiateTerm(pattern.p, binding);
          if (!predicate || predicate.type === 'var') return [];
          const boundPositions = [];
          const boundKeys = [];
          for (let index = 0; index < pattern.items.length; index += 1) {
            const item = instantiateTerm(pattern.items[index], binding);
            if (item && item.type !== 'var') {
              boundPositions.push(index);
              boundKeys.push(termKey(item));
            }
          }
          const predicateKey = termKey(predicate);
          const indexKey = `${predicateKey}|${boundPositions.join(',')}`;
          let deepIndex = this.deepIndexes.get(indexKey);
          if (!deepIndex) {
            deepIndex = this.buildListTupleIndex(predicateKey, boundPositions, pattern.items.length);
            this.deepIndexes.set(indexKey, deepIndex);
          }
          const candidates = deepIndex.get(boundKeys.join('\u0000')) || [];
          const out = [];
          for (const candidate of candidates) {
            let next = matchTriple({ s: pattern.s, p: pattern.p, o: pattern.o }, candidate.triple, binding);
            if (!next) continue;
            for (let index = 0; index < pattern.items.length && next; index += 1) {
              next = mergeBindingTerm(next, pattern.items[index], candidate.items[index]);
            }
            if (next) out.push(next);
          }
          return out;
        }
        buildListTupleIndex(predicateKey, positions, length) {
          const out = new Map();
          const relations = this.byPredicate.get(predicateKey) || new Map();
          for (const triple of relations.values()) {
            const items = this.readListItems(triple.s, length);
            if (!items) continue;
            const key = positions.map((position) => termKey(items[position])).join('\u0000');
            if (!out.has(key)) out.set(key, []);
            out.get(key).push({ triple, items });
          }
          return out;
        }
        readListItems(head, length) {
          const items = [];
          let node = head;
          for (let index = 0; index < length; index += 1) {
            const first = singleNestedValue(this.byPredicateSubject, termKey({ type: 'iri', value: RDF_FIRST }), termKey(node));
            const rest = singleNestedValue(this.byPredicateSubject, termKey({ type: 'iri', value: RDF_REST }), termKey(node));
            if (!first || !rest) return null;
            items.push(first.o);
            node = rest.o;
          }
          return node.type === 'iri' && node.value === RDF_NIL ? items : null;
        }
      
        matchPath(pattern, binding = {}) {
          const prefix = `__path_${pathCallCounter++}_`;
          const tempVars = [];
          const bindings = matchPathExpression(this, pattern.p, pattern.s, pattern.o, binding, prefix, tempVars);
          if (tempVars.length === 0) return bindings;
          return bindings.map((matched) => {
            let cleaned = matched;
            for (const name of tempVars) {
              if (Object.prototype.hasOwnProperty.call(cleaned, name)) {
                if (cleaned === matched) cleaned = { ...matched };
                delete cleaned[name];
              }
            }
            return cleaned;
          });
        }
      }
      
      let pathCallCounter = 0;
      
      function addIndex(index, key, tripleKeyValue, triple) {
        if (!index.has(key)) index.set(key, new Map());
        index.get(key).set(tripleKeyValue, triple);
      }
      
      function addNestedIndex(index, outerKey, innerKey, tripleKeyValue, triple) {
        if (!index.has(outerKey)) index.set(outerKey, new Map());
        const inner = index.get(outerKey);
        if (!inner.has(innerKey)) inner.set(innerKey, new Map());
        inner.get(innerKey).set(tripleKeyValue, triple);
      }
      
      function nestedLookup(index, outerKey, innerKey) {
        const inner = index.get(outerKey);
        return inner ? inner.get(innerKey) || null : null;
      }
      function singleNestedValue(index, outerKey, innerKey) {
        const values = nestedLookup(index, outerKey, innerKey);
        if (!values || values.size !== 1) return null;
        return values.values().next().value;
      }
      
      function smallerValues(left, right) {
        const small = left.size <= right.size ? left : right;
        const large = small === left ? right : left;
        const out = [];
        for (const [key, triple] of small) if (large.has(key)) out.push(triple);
        return out;
      }
      
      function normalizeTriple(triple) {
        return { s: triple.s, p: triple.p, o: triple.o };
      }
      
      function bindingKey(binding) {
        return Object.keys(binding).sort().map((name) => `${name}=${termKey(binding[name])}`).join(';');
      }
      
      function mergeBindingTerm(binding, patternTerm, dataTerm) {
        if (!patternTerm || !dataTerm) return null;
        if (patternTerm.type === 'var') {
          const name = patternTerm.value;
          if (!binding[name]) return { ...binding, [name]: dataTerm };
          return termEquals(binding[name], dataTerm) ? binding : null;
        }
        if (patternTerm.type === 'triple') {
          if (dataTerm.type !== 'triple') return null;
          let next = mergeBindingTerm(binding, patternTerm.s, dataTerm.s);
          if (!next) return null;
          next = mergeBindingTerm(next, patternTerm.p, dataTerm.p);
          if (!next) return null;
          return mergeBindingTerm(next, patternTerm.o, dataTerm.o);
        }
        return termEquals(patternTerm, dataTerm) ? binding : null;
      }
      
      function matchTriple(pattern, triple, binding = {}) {
        let next = mergeBindingTerm(binding, pattern.s, triple.s);
        if (!next) return null;
        next = mergeBindingTerm(next, pattern.p, triple.p);
        if (!next) return null;
        next = mergeBindingTerm(next, pattern.o, triple.o);
        return next;
      }
      
      function instantiateTerm(term, binding) {
        if (term.type === 'var') return binding[term.value] || null;
        if (term.type === 'triple') {
          const s = instantiateTerm(term.s, binding);
          const p = instantiateTerm(term.p, binding);
          const o = instantiateTerm(term.o, binding);
          if (!s || !p || !o) return null;
          return { type: 'triple', s, p, o };
        }
        return term;
      }
      
      function instantiateTriple(pattern, binding) {
        const s = instantiateTerm(pattern.s, binding);
        const p = instantiateTerm(pattern.p, binding);
        const o = instantiateTerm(pattern.o, binding);
        if (!s || !p || !o) return null;
        if (p.type !== 'iri') return null;
        return { s, p, o };
      }
      
      function matchPathExpression(store, path, start, end, binding, tempPrefix, tempVars) {
        if (!path || path.type !== 'path') return store.match({ s: start, p: path, o: end }, binding);
      
        if (path.kind === 'iri') return store.match({ s: start, p: path.iri, o: end }, binding);
      
        if (path.kind === 'inverse') {
          return matchPathExpression(store, path.path, end, start, binding, tempPrefix, tempVars);
        }
      
        if (path.kind === 'sequence') {
          let bindings = [binding];
          let currentStart = start;
          for (let index = 0; index < path.parts.length; index += 1) {
            let currentEnd = end;
            if (index + 1 < path.parts.length) {
              const tempName = `${tempPrefix}${tempVars.length}`;
              currentEnd = { type: 'var', value: tempName };
              tempVars.push(tempName);
            }
            const next = [];
            for (const candidate of bindings) {
              for (const matched of matchPathExpression(store, path.parts[index], currentStart, currentEnd, candidate, tempPrefix, tempVars)) {
                next.push(matched);
              }
            }
            if (next.length === 0) return [];
            bindings = next;
            currentStart = currentEnd;
          }
          return bindings;
        }
      
        throw new Error(`Unsupported path kind ${path.kind}`);
      }
      
      function pathPairs(store, path) {
        if (!path || path.type !== 'path') {
          return store.match({ s: { type: 'var', value: '__s' }, p: path, o: { type: 'var', value: '__o' } })
            .map((binding) => ({ s: binding.__s, o: binding.__o }));
        }
      
        if (path.kind === 'iri') {
          return pathPairs(store, path.iri);
        }
      
        if (path.kind === 'inverse') {
          return pathPairs(store, path.path).map((pair) => ({ s: pair.o, o: pair.s }));
        }
      
        if (path.kind === 'sequence') {
          let pairs = pathPairs(store, path.parts[0]);
          for (const part of path.parts.slice(1)) {
            const right = pathPairs(store, part);
            const joined = [];
            for (const leftPair of pairs) {
              for (const rightPair of right) {
                if (termEquals(leftPair.o, rightPair.s)) joined.push({ s: leftPair.s, o: rightPair.o });
              }
            }
            pairs = uniquePairs(joined);
          }
          return pairs;
        }
      
        throw new Error(`Unsupported path kind ${path.kind}`);
      }
      
      function uniquePairs(pairs) {
        const seen = new Set();
        const out = [];
        for (const pair of pairs) {
          const key = `${termKey(pair.s)} ${termKey(pair.o)}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push(pair);
          }
        }
        return out;
      }
      
      module.exports = {
        TripleStore,
        normalizeTriple,
        bindingKey,
        matchTriple,
        instantiateTerm,
        instantiateTriple,
        pathPairs,
      };
      
    },
    "src/analyze.js": function (require, module, exports) {
      'use strict';
      
      const { compactIRI, iri, variable, termEquals } = require('./term.js');
      const { tripleHasBlankNode } = require('./assignments.js');
      
      function analyze(program, options = {}) {
        const diagnostics = [];
        const dependency = dependencyGraph(program, options);
      
        program.rules.forEach((rule, index) => {
          const name = ruleName(rule, index);
          const initialBound = new Set();
      
          const bound = boundVariables(rule.body, initialBound);
          const head = new Set();
          for (const triple of rule.head) collectTripleVars(triple, head);
          for (const variableName of head) {
            if (!bound.has(variableName)) diagnostics.push({
              code: 'unsafe-head-variable', severity: 'error', rule: name,
              message: `${displayRuleName(name, program.prefixes || {})} has unbound head variable ?${variableName}`,
            });
          }
          for (const triple of rule.head) {
            if (triple.p.type !== 'iri' && triple.p.type !== 'var') diagnostics.push({
              code: 'invalid-head-predicate', severity: 'error', rule: name,
              message: `${displayRuleName(name, program.prefixes || {})} has a non-IRI/non-variable predicate in the head`,
            });
          }
          diagnostics.push(...sequentialWellFormednessDiagnostics(rule.body, name, program.prefixes || {}, initialBound));
        });
      
        if (options.checkStratification !== false) {
          for (const cycle of dependency.unstratifiedCycles) diagnostics.push({
            code: 'unstratified-closed-dependency', severity: 'error', rules: cycle.rules,
            message: `Stratification condition violated by a recursive closed dependency through ${cycle.rules.map((name) => displayRuleName(name, program.prefixes || {})).join(' -> ')}`,
          });
        }
      
        return {
          warnings: diagnostics.filter((d) => d.severity === 'warning'),
          errors: diagnostics.filter((d) => d.severity === 'error'),
          diagnostics,
          dependency,
        };
      }
      
      function ruleName(rule, index) { return rule.name || `rule#${index + 1}`; }
      function displayRuleName(name, prefixes = {}) { return /^https?:/.test(name) ? compactIRI(name, prefixes) : name; }
      
      function dependencyGraph(program, options = {}) {
        const rules = program.rules.map((rule, index) => {
          // WHERE DATA and NOT DATA read the immutable base graph. Rule heads can
          // never add triples to that graph, so those patterns do not create rule
          // dependencies (§4.3 dependency is about possible head/body matching in
          // the inference graph).
          const positivePatterns = rule.groundData ? [] : bodyTriplePatterns(rule.body, false);
          const negativePatterns = rule.groundData ? [] : bodyTriplePatterns(rule.body, true);
          const headTemplates = effectiveHeadTemplates(rule);
          return {
            index, name: ruleName(rule, index), headTemplates, positivePatterns, negativePatterns,
            headPredicates: new Set(headTemplates.map((triple) => predicateIRI(triple)).filter(Boolean)),
            positivePredicates: new Set(positivePatterns.flatMap((triple) => predicateIRIs(triple))),
            negativePredicates: new Set(negativePatterns.flatMap((triple) => predicateIRIs(triple))),
            runOnce: !!rule.runOnce,
            hasAssignment: ruleHasAssignment(rule, options),
            hasTermGeneratingAssignment: ruleHasTermGeneratingAssignment(rule, options),
            headHasBlankNode: ruleHeadHasBlankNode(rule),
            createsTerms: ruleCreatesTerms(rule, options),
          };
        });
      
        const edgeMap = new Map();
        function addEdge(from, to, kind, predicate) {
          const key = `${from.index}->${to.index}`;
          const negated = kind === 'negated';
          // Per §4.3, every dependency *from* an assignment rule or a rule with a
          // blank node in its head is closed, even when the matching pattern itself
          // is positive.
          const runOnceConstraint = from.runOnce;
          const closed = negated || runOnceConstraint;
          const existing = edgeMap.get(key);
          if (existing) {
            existing.closed = existing.closed || closed;
            existing.negative = existing.closed;
            existing.negated = existing.negated || negated;
            existing.runOnceConstraint = existing.runOnceConstraint || runOnceConstraint;
            if (predicate && !existing.predicates.includes(predicate)) existing.predicates.push(predicate);
            if (!existing.predicate && predicate) existing.predicate = predicate;
            return;
          }
          edgeMap.set(key, {
            from: from.index, to: to.index, label: closed ? 'closed' : 'open', closed, negative: closed,
            negated, runOnceConstraint, predicate: predicate || null, predicates: predicate ? [predicate] : [],
          });
        }
      
        const headIndex = buildHeadTemplateIndex(rules);
        for (const from of rules) {
          for (const pattern of from.positivePatterns) {
            for (const candidate of candidateHeadTemplates(headIndex, pattern)) {
              if (canPossiblyGenerate(candidate.template, pattern)) addEdge(from, rules[candidate.ruleIndex], 'positive', dependencyPredicateLabel(pattern));
            }
          }
          for (const pattern of from.negativePatterns) {
            for (const candidate of candidateHeadTemplates(headIndex, pattern)) {
              if (canPossiblyGenerate(candidate.template, pattern)) addEdge(from, rules[candidate.ruleIndex], 'negated', dependencyPredicateLabel(pattern));
            }
          }
        }
      
        const edges = Array.from(edgeMap.values()).sort((a,b) => a.from-b.from || a.to-b.to);
        for (const edge of edges) edge.label = edge.closed ? 'closed' : 'open';
        const components = stronglyConnectedComponents(rules.length, edges);
        const componentOf = new Map();
        components.forEach((component, i) => component.forEach((ruleIndex) => componentOf.set(ruleIndex, i)));
      
        const unstratifiedCycles = [];
        const seen = new Set();
        for (const edge of edges) {
          if (!edge.closed || componentOf.get(edge.from) !== componentOf.get(edge.to)) continue;
          const component = components[componentOf.get(edge.from)];
          const isCycle = component.length > 1 || edge.from === edge.to;
          if (!isCycle) continue;
          const key = component.join(',');
          if (seen.has(key)) continue;
          seen.add(key);
          unstratifiedCycles.push({ rules: component.map((i) => rules[i].name) });
        }
      
        const layers = unstratifiedCycles.length ? [rules.map((r) => r.index)] : stratificationLayers(rules.length, components, componentOf, edges);
        return {
          rules: rules.map((rule) => ({
            index: rule.index, name: rule.name,
            headPredicates: Array.from(rule.headPredicates), positivePredicates: Array.from(rule.positivePredicates), negativePredicates: Array.from(rule.negativePredicates),
            runOnce: rule.runOnce, hasAssignment: rule.hasAssignment, hasTermGeneratingAssignment: rule.hasTermGeneratingAssignment,
            headHasBlankNode: rule.headHasBlankNode, createsTerms: rule.createsTerms,
          })),
          edges,
          components: components.map((component) => component.map((i) => rules[i].name)),
          layers: layers.map((layer) => layer.map((i) => rules[i].name)),
          layerIndexes: layers,
          unstratifiedCycles,
        };
      }
      
      function buildHeadTemplateIndex(rules) {
        const templates = [];
        const positions = ['s', 'p', 'o'];
        const byPosition = {
          s: new Map(),
          p: new Map(),
          o: new Map(),
        };
        const flexibleByPosition = {
          s: new Set(),
          p: new Set(),
          o: new Set(),
        };
      
        for (const rule of rules) {
          for (const template of rule.headTemplates) {
            const entry = { id: templates.length, ruleIndex: rule.index, template };
            templates.push(entry);
            for (const position of positions) {
              const key = fixedTermIndexKey(template[position]);
              if (key === null) flexibleByPosition[position].add(entry.id);
              else {
                let bucket = byPosition[position].get(key);
                if (!bucket) {
                  bucket = new Set();
                  byPosition[position].set(key, bucket);
                }
                bucket.add(entry.id);
              }
            }
          }
        }
      
        return { templates, byPosition, flexibleByPosition };
      }
      
      function candidateHeadTemplates(index, pattern) {
        const positions = ['s', 'p', 'o'];
        let selected = null;
      
        for (const position of positions) {
          const key = fixedTermIndexKey(pattern[position]);
          if (key === null) continue;
          const exact = index.byPosition[position].get(key) || null;
          const flexible = index.flexibleByPosition[position];
          const estimatedSize = (exact ? exact.size : 0) + flexible.size;
          if (selected === null || estimatedSize < selected.estimatedSize) selected = { exact, flexible, estimatedSize };
          if (estimatedSize === 0) break;
        }
      
        if (selected === null) return index.templates;
        const ids = [];
        if (selected.exact) for (const id of selected.exact) ids.push(id);
        for (const id of selected.flexible) ids.push(id);
        const out = [];
        const seen = new Set();
        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          out.push(index.templates[id]);
        }
        return out;
      }
      
      function fixedTermIndexKey(term) {
        if (!term) return null;
        if (term.type === 'var') return null;
        if (term.type === 'path') return null;
        if (term.type === 'triple' && containsVariableTerm(term)) return null;
        return termIndexKey(term);
      }
      
      function containsVariableTerm(term) {
        if (!term) return false;
        if (term.type === 'var') return true;
        if (term.type === 'triple') return containsVariableTerm(term.s) || containsVariableTerm(term.p) || containsVariableTerm(term.o);
        if (term.type === 'path') {
          if (term.kind === 'inverse') return containsVariableTerm(term.path);
          if (term.kind === 'sequence') return term.parts.some(containsVariableTerm);
        }
        return false;
      }
      
      function literalIndexValue(value) {
        if (typeof value === 'bigint') return `${value.toString()}n`;
        return JSON.stringify(value);
      }
      
      function termIndexKey(term) {
        if (!term) return 'null';
        if (term.type === 'iri') return `I:${term.value}`;
        if (term.type === 'blank') return `B:${term.value}`;
        if (term.type === 'literal') return `L:${literalIndexValue(term.value)}^^${term.datatype || ''}@${term.lang || ''}--${term.langDir || ''}`;
        if (term.type === 'triple') return `T:${termIndexKey(term.s)} ${termIndexKey(term.p)} ${termIndexKey(term.o)}`;
        return JSON.stringify(term);
      }
      
      function unionSets(a, b) {
        const out = new Set();
        if (a) for (const value of a) out.add(value);
        if (b) for (const value of b) out.add(value);
        return out;
      }
      
      function allTemplateIds(length) {
        const out = new Set();
        for (let i = 0; i < length; i += 1) out.add(i);
        return out;
      }
      
      function stratificationLayers(ruleCount, components, componentOf, edges) {
        if (ruleCount === 0) return [];
        const levels = Array(ruleCount).fill(0);
        const limit = ruleCount + 1;
        let changed = true;
        while (changed) {
          changed = false;
          for (const edge of edges) {
            const required = levels[edge.to] + (edge.closed ? 1 : 0);
            if (levels[edge.from] < required) {
              levels[edge.from] = required;
              if (levels[edge.from] > limit) throw new Error('Stratification error');
              changed = true;
            }
          }
        }
        const max = Math.max(0, ...levels);
        const layers = Array.from({ length: max + 1 }, () => []);
        levels.forEach((level, index) => layers[level].push(index));
        return layers;
      }
      
      function stronglyConnectedComponents(size, edges) {
        const adjacency = Array.from({ length: size }, () => []);
        const reverse = Array.from({ length: size }, () => []);
        for (const edge of edges) {
          adjacency[edge.from].push(edge.to);
          reverse[edge.to].push(edge.from);
        }
      
        const visited = Array(size).fill(false);
        const order = [];
        for (let start = 0; start < size; start += 1) {
          if (visited[start]) continue;
          const stack = [[start, 0]];
          visited[start] = true;
          while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const v = frame[0];
            let nextIndex = frame[1];
            if (nextIndex < adjacency[v].length) {
              const w = adjacency[v][nextIndex];
              frame[1] = nextIndex + 1;
              if (!visited[w]) {
                visited[w] = true;
                stack.push([w, 0]);
              }
            } else {
              order.push(v);
              stack.pop();
            }
          }
        }
      
        const assigned = Array(size).fill(false);
        const components = [];
        for (let i = order.length - 1; i >= 0; i -= 1) {
          const start = order[i];
          if (assigned[start]) continue;
          const component = [];
          const stack = [start];
          assigned[start] = true;
          while (stack.length > 0) {
            const v = stack.pop();
            component.push(v);
            for (const w of reverse[v]) {
              if (!assigned[w]) {
                assigned[w] = true;
                stack.push(w);
              }
            }
          }
          components.push(component.sort((a, b) => a - b));
        }
        return components;
      }
      
      function sequentialWellFormednessDiagnostics(clauses, ruleNameValue, prefixes = {}, initialBound = new Set()) {
        const diagnostics = [];
      
        function visit(items, initialBound, scopeLabel) {
          const bound = new Set(initialBound);
          for (const clause of items) {
            if (clause.type === 'triple' || clause.type === 'path') {
              collectTripleVars(clause.triple, bound);
            } else if (clause.type === 'filter') {
              for (const variable of expressionVariables(clause.expr)) {
                if (!bound.has(variable)) {
                  diagnostics.push({
                    code: 'unbound-filter-variable',
                    severity: 'error',
                    rule: ruleNameValue,
                    message: `${displayRuleName(ruleNameValue, prefixes)} FILTER uses ?${variable} before it is bound${scopeLabel}`,
                  });
                }
              }
            } else if ((clause.type === 'set' || clause.type === 'bind')) {
              if (bound.has(clause.variable)) {
                diagnostics.push({
                  code: 'assignment-variable-already-bound',
                  severity: 'error',
                  rule: ruleNameValue,
                  message: `${displayRuleName(ruleNameValue, prefixes)} SET assigns ?${clause.variable}, but that variable is already bound${scopeLabel}`,
                });
              }
              for (const variable of expressionVariables(clause.expr)) {
                if (!bound.has(variable)) {
                  diagnostics.push({
                    code: 'unbound-assignment-variable',
                    severity: 'error',
                    rule: ruleNameValue,
                    message: `${displayRuleName(ruleNameValue, prefixes)} SET expression uses ?${variable} before it is bound${scopeLabel}`,
                  });
                }
              }
              bound.add(clause.variable);
            } else if (clause.type === 'not') {
              visit(clause.body, bound, ' inside NOT');
            }
          }
          return bound;
        }
      
        visit(clauses, initialBound, '');
        return diagnostics;
      }
      
      function bodyTriplePatterns(clauses, wantNegative, inNegativeContext = false) {
        const out = [];
        for (const clause of clauses) {
          if ((clause.type === 'triple' || clause.type === 'path') && wantNegative === inNegativeContext) {
            if (clause.type === 'path') out.push(...pathTriplePatterns(clause.triple));
            else out.push(clause.triple);
          } else if (clause.type === 'not') {
            if (!clause.groundData) out.push(...bodyTriplePatterns(clause.body, wantNegative, true));
          }
        }
        return out;
      }
      
      function pathTriplePatterns(triple) {
        const predicates = predicateIRIs(triple);
        if (predicates.length === 0) return [];
        return predicates.map((predicate, index) => ({
          s: variable(`__path_s_${index}`),
          p: iri(predicate),
          o: variable(`__path_o_${index}`),
        }));
      }
      
      function dependencyPredicateLabel(pattern) {
        return pattern && pattern.p && pattern.p.type === 'iri' ? pattern.p.value : null;
      }
      
      function canPossiblyGenerate(template, pattern) {
        if (!template || !pattern) return false;
        if (!compatibleTerm(template.s, pattern.s)) return false;
        if (!compatibleTerm(template.p, pattern.p)) return false;
        if (!compatibleTerm(template.o, pattern.o)) return false;
      
        const constraints = new Map();
        if (!recordTemplateVariableConstraints(template.s, pattern.s, constraints)) return false;
        if (!recordTemplateVariableConstraints(template.p, pattern.p, constraints)) return false;
        if (!recordTemplateVariableConstraints(template.o, pattern.o, constraints)) return false;
        return true;
      }
      
      function compatibleTerm(templateTerm, patternTerm) {
        if (!templateTerm || !patternTerm) return false;
        if (templateTerm.type === 'var' || patternTerm.type === 'var') return true;
        if (templateTerm.type === 'triple' || patternTerm.type === 'triple') {
          if (templateTerm.type !== 'triple' || patternTerm.type !== 'triple') return false;
          return compatibleTerm(templateTerm.s, patternTerm.s)
            && compatibleTerm(templateTerm.p, patternTerm.p)
            && compatibleTerm(templateTerm.o, patternTerm.o);
        }
        return termEquals(templateTerm, patternTerm);
      }
      
      function recordTemplateVariableConstraints(templateTerm, patternTerm, constraints) {
        if (!templateTerm || !patternTerm) return false;
        if (templateTerm.type === 'var') {
          const existing = constraints.get(templateTerm.value);
          if (!existing) {
            constraints.set(templateTerm.value, patternTerm);
            return true;
          }
          return possiblySameTerm(existing, patternTerm);
        }
        if (templateTerm.type === 'triple' && patternTerm.type === 'triple') {
          return recordTemplateVariableConstraints(templateTerm.s, patternTerm.s, constraints)
            && recordTemplateVariableConstraints(templateTerm.p, patternTerm.p, constraints)
            && recordTemplateVariableConstraints(templateTerm.o, patternTerm.o, constraints);
        }
        return true;
      }
      
      function possiblySameTerm(a, b) {
        if (!a || !b) return false;
        if (a.type === 'var' || b.type === 'var') return true;
        if (a.type === 'triple' || b.type === 'triple') {
          if (a.type !== 'triple' || b.type !== 'triple') return false;
          return possiblySameTerm(a.s, b.s) && possiblySameTerm(a.p, b.p) && possiblySameTerm(a.o, b.o);
        }
        return termEquals(a, b);
      }
      
      function bodyPredicates(clauses, wantNegative, inNegativeContext = false) {
        const out = [];
        for (const clause of clauses) {
          if ((clause.type === 'triple' || clause.type === 'path') && wantNegative === inNegativeContext) {
            out.push(...predicateIRIs(clause.triple));
          } else if (clause.type === 'not') {
            out.push(...bodyPredicates(clause.body, wantNegative, true));
          }
        }
        return out;
      }
      
      function predicateIRI(triple) {
        return triple && triple.p && triple.p.type === 'iri' ? triple.p.value : null;
      }
      
      function predicateIRIs(triple) {
        if (!triple || !triple.p) return [];
        if (triple.p.type === 'iri') return [triple.p.value];
        if (triple.p.type === 'path') return pathPredicateIRIs(triple.p);
        return [];
      }
      
      function pathPredicateIRIs(path) {
        if (!path) return [];
        if (path.type === 'iri') return [path.value];
        if (path.type !== 'path') return [];
        if (path.kind === 'inverse') return pathPredicateIRIs(path.path);
        if (path.kind === 'sequence') return path.parts.flatMap(pathPredicateIRIs);
        if (path.kind === 'iri') return pathPredicateIRIs(path.iri);
        return [];
      }
      
      function effectiveHeadTemplates(rule) {
        const constants = assignmentConstantTerms(rule.body || []);
        if (constants.size === 0) return rule.head.slice();
        return rule.head.map((triple) => ({
          s: substituteAssignedConstant(triple.s, constants),
          p: substituteAssignedConstant(triple.p, constants),
          o: substituteAssignedConstant(triple.o, constants),
        }));
      }
      
      function assignmentConstantTerms(clauses) {
        const constants = new Map();
        const bound = new Set();
        for (const clause of clauses) {
          if (clause.type === 'triple' || clause.type === 'path') {
            collectTripleVars(clause.triple, bound);
            continue;
          }
          if (clause.type === 'filter') continue;
          if (clause.type === 'not') continue;
          if (clause.type === 'set' || clause.type === 'bind') {
            const value = constantExpressionTerm(clause.expr);
            if (value && !bound.has(clause.variable)) constants.set(clause.variable, value);
            bound.add(clause.variable);
          }
        }
        return constants;
      }
      
      function constantExpressionTerm(expr) {
        if (!expr || expressionVariables(expr).size > 0) return null;
        if (expr.type === 'term') return expr.value;
        return null;
      }
      
      function substituteAssignedConstant(term, constants) {
        if (!term) return term;
        if (term.type === 'var' && constants.has(term.value)) return constants.get(term.value);
        if (term.type === 'triple') {
          return {
            type: 'triple',
            s: substituteAssignedConstant(term.s, constants),
            p: substituteAssignedConstant(term.p, constants),
            o: substituteAssignedConstant(term.o, constants),
          };
        }
        return term;
      }
      
      function ruleHasAssignment(rule, options = {}) {
        return (rule.body || []).some((clause) => clause.type === 'set' || clause.type === 'bind');
      }
      
      function ruleHasTermGeneratingAssignment(rule, options = {}) {
        return (rule.body || []).some((clause) => (clause.type === 'set' || clause.type === 'bind') && assignmentMayCreateNewTerm(clause.expr));
      }
      
      function ruleCreatesTerms(rule, options = {}) {
        return ruleHeadHasBlankNode(rule) || ruleHasTermGeneratingAssignment(rule, options);
      }
      
      function assignmentMayCreateNewTerm(expr) {
        // Simple aliases and constants are not term generators: they select from a
        // fixed term or from already-bound terms.  Expressions that compute values
        // through operators or functions may create an unbounded sequence when used
        // recursively, e.g. SET(?v1 := ?v + 1), so they remain part of the strict
        // recursive-new-terms check.
        if (!expr) return false;
        if (expr.type === 'var' || expr.type === 'term' || expr.type === 'literal') return false;
        return true;
      }
      
      function ruleHeadHasBlankNode(rule) {
        return (rule.head || []).some(tripleHasBlankNode);
      }
      
      function boundVariables(clauses, initialBound = new Set()) {
        const vars = new Set(initialBound);
        for (const clause of clauses) {
          if (clause.type === 'triple' || clause.type === 'path') collectTripleVars(clause.triple, vars);
          if ((clause.type === 'set' || clause.type === 'bind')) vars.add(clause.variable);
        }
        return vars;
      }
      
      function positiveVariables(clauses) {
        const vars = new Set();
        for (const clause of clauses) {
          if (clause.type === 'triple' || clause.type === 'path') collectTripleVars(clause.triple, vars);
          if ((clause.type === 'set' || clause.type === 'bind')) vars.add(clause.variable);
          if (clause.type === 'filter') for (const v of expressionVariables(clause.expr)) vars.add(v);
        }
        return vars;
      }
      
      function bodyVariables(clauses) {
        const vars = new Set();
        for (const clause of clauses) {
          if (clause.type === 'triple' || clause.type === 'path') collectTripleVars(clause.triple, vars);
          if ((clause.type === 'set' || clause.type === 'bind')) {
            vars.add(clause.variable);
            for (const v of expressionVariables(clause.expr)) vars.add(v);
          }
          if (clause.type === 'filter') for (const v of expressionVariables(clause.expr)) vars.add(v);
          if (clause.type === 'not') for (const v of bodyVariables(clause.body)) vars.add(v);
        }
        return vars;
      }
      
      function collectTripleVars(triple, vars) {
        for (const term of [triple.s, triple.p, triple.o]) collectTermVars(term, vars);
      }
      
      function collectTermVars(term, vars) {
        if (!term) return;
        if (term.type === 'var') vars.add(term.value);
        if (term.type === 'triple') {
          collectTermVars(term.s, vars);
          collectTermVars(term.p, vars);
          collectTermVars(term.o, vars);
        }
        if (term.type === 'path') {
          if (term.kind === 'inverse') collectTermVars(term.path, vars);
          if (term.kind === 'sequence') for (const part of term.parts) collectTermVars(part, vars);
        }
      }
      
      function expressionVariables(expr, vars = new Set()) {
        if (!expr) return vars;
        if (expr.type === 'var') vars.add(expr.name);
        else if (expr.type === 'unary') expressionVariables(expr.expr, vars);
        else if (expr.type === 'binary') {
          expressionVariables(expr.left, vars);
          expressionVariables(expr.right, vars);
        } else if (expr.type === 'call') {
          for (const arg of expr.args) expressionVariables(arg, vars);
        } else if (expr.type === 'list') {
          for (const item of expr.items) expressionVariables(item, vars);
        } else if (expr.type === 'term') {
          collectTermVars(expr.value, vars);
        }
        return vars;
      }
      
      module.exports = {
        analyze,
        dependencyGraph,
        stratificationLayers,
        boundVariables,
        positiveVariables,
        bodyVariables,
        collectTripleVars,
        expressionVariables,
        pathPredicateIRIs,
        bodyTriplePatterns,
        canPossiblyGenerate,
      };
      
    },
    "src/format.js": function (require, module, exports) {
      'use strict';
      
      const { formatTriple, formatTerm } = require('./term.js');
      
      function sortTriples(triples, prefixes = {}) {
        return triples
          .map((triple) => ({ triple, text: formatTriple(triple, prefixes) }))
          .sort((a, b) => a.text.localeCompare(b.text))
          .map((entry) => entry.triple);
      }
      
      function formatTriples(triples, prefixes = {}) {
        return triples
          .map((triple) => formatTriple(triple, prefixes))
          .sort((a, b) => a.localeCompare(b))
          .join('\n');
      }
      
      function formatTrace(trace, prefixes = {}) {
        return trace.map((entry) => `#${entry.iteration} ${entry.rule} => ${formatTriple(entry.triple, prefixes)}`).join('\n');
      }
      
      function formatProof(trace, prefixes = {}) {
        if (!trace.length) return '';
        const lines = ['@prefix pe: <https://eyereasoner.github.io/pe#> .', ''];
        for (const entry of trace) {
          const conclusion = formatTriple(entry.triple, prefixes);
          lines.push(`{ ${conclusion} } pe:why {`);
          lines.push(`  { ${conclusion} }`);
          lines.push(`    pe:by [ pe:rule ${quoteString(entry.rule)} ]${proofDetails(entry, prefixes)} .`);
          lines.push('}.', '');
        }
        return lines.join('\n').trimEnd();
      }
      
      function proofDetails(entry, prefixes) {
        const details = [];
        const bindings = Object.entries(entry.binding || {}).sort(([a], [b]) => a.localeCompare(b));
        if (bindings.length > 0) {
          details.push(`\n    pe:binding ${bindings.map(([name, value]) => `[ pe:var ${quoteString(name)}; pe:value ${formatTerm(value, prefixes)} ]`).join(', ')}`);
        }
        if (entry.uses && entry.uses.length > 0) {
          details.push(`\n    pe:uses ${entry.uses.map((triple) => `{ ${formatTriple(triple, prefixes)} }`).join(', ')}`);
        }
        return details.length ? `;${details.join(';')}` : '';
      }
      
      function quoteString(value) {
        return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
      }
      
      function formatBindings(bindings, prefixes = {}, select = null) {
        const columns = select && select.length > 0 ? select : inferColumns(bindings);
        return bindings
          .slice()
          .sort((a, b) => formatBinding(a, prefixes, columns).localeCompare(formatBinding(b, prefixes, columns)))
          .map((binding) => formatBinding(binding, prefixes, columns))
          .join('\n');
      }
      
      function formatBinding(binding, prefixes = {}, columns = null) {
        const names = columns || Object.keys(binding).sort();
        if (names.length === 0) return 'true';
        return names.map((name) => `?${name} = ${binding[name] ? formatTerm(binding[name], prefixes) : 'UNDEF'}`).join('; ');
      }
      
      function inferColumns(bindings) {
        const columns = new Set();
        for (const binding of bindings) for (const name of Object.keys(binding)) columns.add(name);
        return Array.from(columns).sort();
      }
      
      function toJSON(result, options = {}) {
        const triples = options.all ? result.closure : result.inferred;
        const json = {
          baseIRI: result.baseIRI || null,
          iterations: result.iterations,
          ruleApplications: result.ruleApplications,
          perRule: result.perRule,
          prefixes: result.prefixes,
          diagnostics: result.diagnostics || [],
          triples: sortTriples(triples, result.prefixes).map(jsonSafeTriple),
          proof: options.proof ? result.trace : undefined,
          validation: result.validationReport ? {
            conforms: result.validationReport.conforms,
            results: Array.isArray(result.validationReport.results) ? result.validationReport.results.length : undefined,
          } : undefined,
        };
        if (result.query) json.query = jsonSafeValue(result.query);
        if (result.analysis && options.analysis) json.analysis = result.analysis;
        return json;
      }
      
      
      function jsonSafeTriple(triple) {
        return { s: jsonSafeTerm(triple.s), p: jsonSafeTerm(triple.p), o: jsonSafeTerm(triple.o) };
      }
      
      function jsonSafeTerm(term) {
        if (!term || typeof term !== 'object') return jsonSafeValue(term);
        if (term.type === 'triple') return { type: 'triple', s: jsonSafeTerm(term.s), p: jsonSafeTerm(term.p), o: jsonSafeTerm(term.o) };
        if (term.type === 'literal' && typeof term.value === 'bigint') return { ...term, value: term.value.toString() };
        return { ...term };
      }
      
      function jsonSafeValue(value) {
        if (typeof value === 'bigint') return value.toString();
        if (Array.isArray(value)) return value.map(jsonSafeValue);
        if (value && typeof value === 'object') {
          if (value.type) return jsonSafeTerm(value);
          return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, jsonSafeValue(val)]));
        }
        return value;
      }
      
      module.exports = { sortTriples, formatTriples, formatTrace, formatProof, formatBindings, formatBinding, toJSON };
      
    },
    "src/query.js": function (require, module, exports) {
      'use strict';
      
      const { parseQuery } = require('./parser.js');
      const { TripleStore, bindingKey } = require('./store.js');
      const { evaluateBody } = require('./engine.js');
      const { backwardQuery, planBackwardQuery } = require('./backward.js');
      
      function queryResult(result, querySpec, options = {}) {
        const store = new TripleStore(result.closure || []);
        const bindings = evaluateBody(querySpec.body, store, {}, { ...options, groundStore: result.groundStore });
        const select = normalizeSelect(querySpec.select, bindings);
        return {
          baseIRI: result.baseIRI,
          prefixes: result.prefixes,
          select,
          bindings: projectBindings(bindings, select),
          mode: 'forward',
        };
      }
      
      function queryProgram(program, querySpec, options = {}) {
        const mode = options.queryMode || 'auto';
        if (mode !== 'forward') {
          const planned = planBackwardQuery(program, querySpec, options);
          if (planned.ok) {
            const result = backwardQuery(program, querySpec, options);
            if (result.ok) {
              const select = normalizeSelect(querySpec.select, result.bindings);
              return {
                baseIRI: program.baseIRI,
                prefixes: program.prefixes,
                select,
                bindings: projectBindings(result.bindings, select),
                mode: 'backward',
                stats: result.stats,
              };
            }
            if (mode === 'backward') throw new Error(result.reason || 'Backward query failed');
          } else if (mode === 'backward') {
            throw new Error(`Backward query is not supported for this ruleset: ${planned.reason}`);
          }
        }
        return null;
      }
      
      function runQuery(source, querySource = null, options = {}) {
        const { run, compile } = require('./api.js');
        const { program, diagnostics, analysis } = compile(source, options);
      
        let querySpec;
        if (querySource) querySpec = parseQuery(querySource, { ...options, prefixes: program.prefixes, baseIRI: program.baseIRI });
        else throw new Error('No query supplied. Use --query or --query-file with a raw body pattern.');
      
        const direct = queryProgram(program, querySpec, options);
        if (direct) {
          return {
            baseIRI: program.baseIRI,
            version: program.version || null,
            imports: program.imports || [],
            prefixes: program.prefixes,
            input: (program.baseData || []).slice(),
            data: (program.data || []).slice(),
            inferred: (program.data || []).slice(),
            closure: [...(program.baseData || []), ...(program.data || [])],
            iterations: 0,
            layers: [],
            ruleApplications: 0,
            perRule: [],
            trace: [],
            diagnostics,
            analysis,
            query: direct,
          };
        }
      
        const result = run(program, options);
        result.diagnostics = diagnostics;
        result.query = queryResult(result, querySpec, options);
        return result;
      }
      
      async function runQueryAsync(source, querySource = null, options = {}) {
        const { compileAsync } = require('./api.js');
        const { evaluateAsync } = require('./engine.js');
        const compiled = await compileAsync(source, options);
        const { program, diagnostics, analysis } = compiled;
      
        let querySpec;
        if (querySource) querySpec = parseQuery(querySource, { ...options, prefixes: program.prefixes, baseIRI: program.baseIRI });
        else throw new Error('No query supplied. Use --query or --query-file with a raw body pattern.');
      
        const direct = queryProgram(program, querySpec, options);
        if (direct) {
          return {
            baseIRI: program.baseIRI,
            version: program.version || null,
            imports: program.imports || [],
            prefixes: program.prefixes,
            input: (program.baseData || []).slice(),
            data: (program.data || []).slice(),
            inferred: (program.data || []).slice(),
            closure: [...(program.baseData || []), ...(program.data || [])],
            iterations: 0,
            layers: [],
            ruleApplications: 0,
            perRule: [],
            trace: [],
            diagnostics,
            analysis,
            query: direct,
          };
        }
      
        const runOptions = { ...compiled.options, ...options };
        const result = await evaluateAsync(program, { ...runOptions, analysis });
        result.diagnostics = diagnostics;
        result.query = queryResult(result, querySpec, runOptions);
        return result;
      }
      
      function normalizeSelect(select, bindings) {
        if (select && select.length > 0) return select.slice();
        const vars = new Set();
        for (const binding of bindings) for (const key of Object.keys(binding)) vars.add(key);
        return Array.from(vars).sort().filter((name) => !name.includes('__b'));
      }
      
      function projectBindings(bindings, select) {
        const seen = new Set();
        const out = [];
        for (const binding of bindings) {
          const projected = {};
          for (const name of select) if (binding[name]) projected[name] = binding[name];
          const key = bindingKey(projected);
          if (!seen.has(key)) {
            seen.add(key);
            out.push(projected);
          }
        }
        return out;
      }
      
      module.exports = { runQuery, runQueryAsync, queryResult, queryProgram, parseQuery, normalizeSelect, projectBindings };
      
    },
    "src/backward.js": function (require, module, exports) {
      'use strict';
      
      const { TripleStore, bindingKey } = require('./store.js');
      const { tripleKey, termKey, termEquals } = require('./term.js');
      const { evalExpression, booleanValue, asTerm } = require('./builtins.js');
      
      function backwardQuery(program, querySpec, options = {}) {
        const planner = planBackwardQuery(program, querySpec, options);
        if (!planner.ok) return { ok: false, reason: planner.reason };
        const prover = new BackwardProver(program, { ...options, allowedRuleIndexes: planner.ruleIndexes });
        const bindings = uniqueBindings(Array.from(prover.solveBody(querySpec.body, {})));
        return { ok: true, bindings, stats: prover.stats, plan: planner };
      }
      
      function planBackwardQuery(program, querySpec, options = {}) {
        const clauses = querySpec && Array.isArray(querySpec.body) ? querySpec.body : [];
        if (!bodySupported(clauses, options)) return { ok: false, reason: 'query body contains clauses not supported by the backward prover yet' };
      
        const reachable = reachableBackwardRuleIndexes(program, clauses, options);
        for (const ruleIndex of reachable.ruleIndexes) {
          const rule = (program.rules || [])[ruleIndex];
          if (!ruleSupported(rule, options)) return { ok: false, reason: `reachable rule ${rule.name || '<anonymous>'} is not supported by the backward prover yet` };
        }
        return { ok: true, ruleIndexes: reachable.ruleIndexes, predicates: reachable.predicates };
      }
      
      function bodySupported(clauses, options = {}) {
        for (const clause of clauses || []) {
          if (clause.type === 'triple' || clause.type === 'filter' || clause.type === 'set' || clause.type === 'bind') continue;
          if (clause.type === 'not') {
            if (clause.groundData) return false;
            if (options.backwardNegation === false) return false;
            if (!bodySupported(clause.body, options)) return false;
            continue;
          }
          return false;
        }
        return true;
      }
      
      function ruleSupported(rule, options = {}) {
        if (rule.groundData || rule.runOnce) return false;
        if (!Array.isArray(rule.head) || rule.head.length === 0) return false;
        for (const head of rule.head) {
          if (!head || !head.p || head.p.type !== 'iri') return false;
          if (containsBlank(head.s) || containsBlank(head.p) || containsBlank(head.o)) return false;
        }
        if (containsGroundDataNegation(rule.body || [])) return false;
        return bodySupported(rule.body || [], options);
      }
      
      class BackwardProver {
        constructor(program, options = {}) {
          this.program = program;
          this.options = options;
          this.store = options.store || new TripleStore([...(program.baseData || []), ...(program.data || [])]);
          this.maxDepth = options.backwardMaxDepth || options.maxDepth || 10000;
          this.solutionLimit = options.backwardSolutionLimit || options.solutionLimit || 1000000;
          this.allowedPredicates = normalizePredicateSet(options.allowedPredicates || options.backwardPredicates || null);
          this.allowedRuleIndexes = normalizeRuleIndexSet(options.allowedRuleIndexes || null);
          this.ruleHeads = indexRuleHeads(program.rules || [], { allowedPredicates: this.allowedPredicates, allowedRuleIndexes: this.allowedRuleIndexes });
          this.memo = new Map();
          this.active = new Set();
          this.freshCounter = 0;
          this.solutionCount = 0;
          this.stats = {
            mode: 'backward',
            goals: 0,
            facts: 0,
            rules: 0,
            memoHits: 0,
            memoStores: 0,
            maxDepth: 0,
          };
        }
      
        *solveBody(clauses, binding = {}, depth = 0, index = 0) {
          if (depth > this.maxDepth) throw new Error(`Reached backwardMaxDepth=${this.maxDepth}; backward query may not terminate`);
          this.stats.maxDepth = Math.max(this.stats.maxDepth, depth);
          if (this.solutionCount >= this.solutionLimit) return;
          if (index >= clauses.length) {
            this.solutionCount += 1;
            yield resolveBinding(binding);
            return;
          }
      
          const clause = clauses[index];
          if (clause.type === 'triple') {
            for (const matched of this.solveTriple(clause.triple, binding, depth + 1)) {
              yield* this.solveBody(clauses, matched, depth + 1, index + 1);
            }
            return;
          }
      
          if (clause.type === 'filter') {
            try {
              if (booleanValue(evalExpression(clause.expr, resolveBinding(binding), this.options))) {
                yield* this.solveBody(clauses, binding, depth + 1, index + 1);
              }
            } catch (_) {
              // SPARQL-style FILTER errors reject the current solution.
            }
            return;
          }
      
          if (clause.type === 'set' || clause.type === 'bind') {
            try {
              const resolved = resolveBinding(binding);
              const value = asTerm(evalExpression(clause.expr, resolved, this.options));
              const next = unifyTerms({ type: 'var', value: clause.variable }, value, binding);
              if (next) yield* this.solveBody(clauses, next, depth + 1, index + 1);
            } catch (_) {
              // Assignment errors drop the current solution.
            }
            return;
          }
      
          if (clause.type === 'not') {
            let found = false;
            for (const _ of this.solveBody(clause.body, { ...binding }, depth + 1, 0)) { found = true; break; }
            if (!found) yield* this.solveBody(clauses, binding, depth + 1, index + 1);
            return;
          }
      
          throw new Error(`Unsupported backward body clause ${clause.type}`);
        }
      
        *solveTriple(pattern, binding = {}, depth = 0) {
          if (depth > this.maxDepth) throw new Error(`Reached backwardMaxDepth=${this.maxDepth}; backward query may not terminate`);
          this.stats.goals += 1;
          const resolvedPattern = resolvePattern(pattern, binding);
          const key = `${goalKey(resolvedPattern)}@store:${this.store.version || 0}`;
          const entry = this.memo.get(key);
          if (entry && entry.complete) {
            this.stats.memoHits += 1;
            yield* this.replayAnswers(pattern, binding, entry.answers);
            return;
          }
          if (this.active.has(key)) return;
      
          const answers = [];
          const answerKeys = new Set();
          this.active.add(key);
          try {
            for (const fact of this.factCandidates(resolvedPattern, binding)) {
              const next = unifyTriples(pattern, fact, binding);
              if (!next) continue;
              rememberAnswer(answers, answerKeys, pattern, next);
              this.stats.facts += 1;
            }
      
            for (const item of this.ruleCandidates(resolvedPattern)) {
              const suffix = `__b${++this.freshCounter}_${item.ruleIndex}`;
              const freshHead = freshTriple(item.head, suffix);
              const next = unifyTriples(pattern, freshHead, binding);
              if (!next) continue;
              const freshBody = (item.rule.body || []).map((clause) => freshClause(clause, suffix));
              for (const solved of this.solveBody(freshBody, next, depth + 1, 0)) {
                rememberAnswer(answers, answerKeys, pattern, solved);
                this.stats.rules += 1;
              }
            }
          } finally {
            this.active.delete(key);
          }
      
          this.memo.set(key, { complete: true, answers });
          this.stats.memoStores += 1;
          yield* this.replayAnswers(pattern, binding, answers);
        }
      
        *replayAnswers(pattern, binding, answers) {
          for (const answer of answers) {
            const next = unifyTriples(pattern, answer, binding);
            if (next) yield next;
          }
        }
      
        factCandidates(pattern, binding) {
          return this.store.candidates(pattern, binding);
        }
      
        ruleCandidates(pattern) {
          const predicate = pattern.p && pattern.p.type === 'iri' ? pattern.p.value : null;
          if (predicate) return this.ruleHeads.byPredicate.get(predicate) || [];
          return this.ruleHeads.all;
        }
      }
      
      function indexRuleHeads(rules, options = {}) {
        const allowedPredicates = options.allowedPredicates || null;
        const allowedRuleIndexes = options.allowedRuleIndexes || null;
        const byPredicate = new Map();
        const all = [];
        for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
          if (allowedRuleIndexes && !allowedRuleIndexes.has(ruleIndex)) continue;
          const rule = rules[ruleIndex];
          for (let headIndex = 0; headIndex < (rule.head || []).length; headIndex += 1) {
            const head = rule.head[headIndex];
            if (!head || !head.p || head.p.type !== 'iri') continue;
            if (allowedPredicates && !allowedPredicates.has(head.p.value)) continue;
            const item = { ruleIndex, headIndex, rule, head };
            all.push(item);
            const bucket = byPredicate.get(head.p.value);
            if (bucket) bucket.push(item);
            else byPredicate.set(head.p.value, [item]);
          }
        }
        return { byPredicate, all };
      }
      
      function freshClause(clause, suffix) {
        if (clause.type === 'triple') return { ...clause, triple: freshTriple(clause.triple, suffix) };
        if (clause.type === 'filter') return { ...clause, expr: freshExpr(clause.expr, suffix) };
        if (clause.type === 'set' || clause.type === 'bind') return { ...clause, variable: freshVarName(clause.variable, suffix), expr: freshExpr(clause.expr, suffix) };
        if (clause.type === 'not') return { ...clause, body: clause.body.map((item) => freshClause(item, suffix)) };
        return clause;
      }
      
      function freshTriple(triple, suffix) {
        return { s: freshTerm(triple.s, suffix), p: freshTerm(triple.p, suffix), o: freshTerm(triple.o, suffix) };
      }
      
      function freshTerm(term, suffix) {
        if (!term) return term;
        if (term.type === 'var') return { type: 'var', value: freshVarName(term.value, suffix) };
        if (term.type === 'triple') return { type: 'triple', s: freshTerm(term.s, suffix), p: freshTerm(term.p, suffix), o: freshTerm(term.o, suffix) };
        return term;
      }
      
      function freshExpr(expr, suffix) {
        if (!expr) return expr;
        if (expr.type === 'var') return { ...expr, name: freshVarName(expr.name, suffix) };
        if (expr.type === 'term') return { ...expr, value: freshTerm(expr.value, suffix) };
        if (expr.type === 'unary') return { ...expr, expr: freshExpr(expr.expr, suffix) };
        if (expr.type === 'binary') return { ...expr, left: freshExpr(expr.left, suffix), right: freshExpr(expr.right, suffix) };
        if (expr.type === 'call') return { ...expr, args: expr.args.map((arg) => freshExpr(arg, suffix)) };
        if (expr.type === 'list') return { ...expr, items: expr.items.map((item) => freshExpr(item, suffix)) };
        return expr;
      }
      
      function freshVarName(name, suffix) {
        return `${name}${suffix}`;
      }
      
      function resolvePattern(pattern, binding) {
        return { s: resolveTerm(pattern.s, binding, false), p: resolveTerm(pattern.p, binding, false), o: resolveTerm(pattern.o, binding, false) };
      }
      
      function resolveBinding(binding) {
        const out = {};
        for (const name of Object.keys(binding)) out[name] = resolveTerm(binding[name], binding, false);
        return out;
      }
      
      function resolveTerm(term, binding, preserveUnbound = true, seen = new Set()) {
        if (!term) return term;
        if (term.type === 'var') {
          const name = term.value;
          if (seen.has(name)) return preserveUnbound ? term : { type: 'var', value: name };
          if (!Object.prototype.hasOwnProperty.call(binding, name)) return preserveUnbound ? term : { type: 'var', value: name };
          seen.add(name);
          return resolveTerm(binding[name], binding, preserveUnbound, seen);
        }
        if (term.type === 'triple') {
          return {
            type: 'triple',
            s: resolveTerm(term.s, binding, preserveUnbound, new Set(seen)),
            p: resolveTerm(term.p, binding, preserveUnbound, new Set(seen)),
            o: resolveTerm(term.o, binding, preserveUnbound, new Set(seen)),
          };
        }
        return term;
      }
      
      function unifyTriples(left, right, binding) {
        let next = unifyTerms(left.s, right.s, binding);
        if (!next) return null;
        next = unifyTerms(left.p, right.p, next);
        if (!next) return null;
        return unifyTerms(left.o, right.o, next);
      }
      
      function unifyTerms(left, right, binding) {
        const a = resolveTerm(left, binding);
        const b = resolveTerm(right, binding);
        if (a.type === 'var' && b.type === 'var' && a.value === b.value) return binding;
        if (a.type === 'var') return bindVariable(a.value, b, binding);
        if (b.type === 'var') return bindVariable(b.value, a, binding);
        if (a.type === 'triple' || b.type === 'triple') {
          if (a.type !== 'triple' || b.type !== 'triple') return null;
          let next = unifyTerms(a.s, b.s, binding);
          if (!next) return null;
          next = unifyTerms(a.p, b.p, next);
          if (!next) return null;
          return unifyTerms(a.o, b.o, next);
        }
        return termEquals(a, b) ? binding : null;
      }
      
      function bindVariable(name, term, binding) {
        const existing = binding[name];
        if (existing) return unifyTerms(existing, term, binding);
        if (term.type === 'var' && term.value === name) return binding;
        return { ...binding, [name]: term };
      }
      
      function rememberAnswer(answers, answerKeys, pattern, binding) {
        const triple = {
          s: resolveTerm(pattern.s, binding),
          p: resolveTerm(pattern.p, binding),
          o: resolveTerm(pattern.o, binding),
        };
        if (triple.s.type === 'var' || triple.p.type === 'var' || triple.o.type === 'var') return;
        const key = tripleKey(triple);
        if (answerKeys.has(key)) return;
        answerKeys.add(key);
        answers.push(triple);
      }
      
      function goalKey(pattern) {
        return `${safeTermKey(pattern.s)} ${safeTermKey(pattern.p)} ${safeTermKey(pattern.o)}`;
      }
      
      function safeTermKey(term) {
        return term && term.type === 'var' ? '_' : termKey(term);
      }
      
      function uniqueBindings(bindings) {
        const seen = new Set();
        const out = [];
        for (const binding of bindings) {
          const resolved = resolveBinding(binding);
          const key = bindingKey(resolved);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(resolved);
        }
        return out;
      }
      
      function containsGroundDataNegation(clauses) {
        for (const clause of clauses || []) {
          if (clause.type !== 'not') continue;
          if (clause.groundData || containsGroundDataNegation(clause.body || [])) return true;
        }
        return false;
      }
      
      
      function containsBlank(term) {
        if (!term) return false;
        if (term.type === 'blank') return true;
        if (term.type === 'triple') return containsBlank(term.s) || containsBlank(term.p) || containsBlank(term.o);
        return false;
      }
      
      
      
      function reachableBackwardRuleIndexes(program, rootClauses, options = {}) {
        const rules = program.rules || [];
        const headIndex = new Map();
        const allHeadPredicates = new Set();
        const allRuleIndexes = new Set();
        for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
          const rule = rules[ruleIndex];
          for (const head of rule.head || []) {
            if (!head || !head.p || head.p.type !== 'iri') continue;
            allRuleIndexes.add(ruleIndex);
            allHeadPredicates.add(head.p.value);
            if (!headIndex.has(head.p.value)) headIndex.set(head.p.value, new Set());
            headIndex.get(head.p.value).add(ruleIndex);
          }
        }
      
        const predicates = new Set();
        const ruleIndexes = new Set();
        const work = [];
        const enqueue = (predicate) => {
          if (!predicate) {
            for (const item of allHeadPredicates) enqueue(item);
            return;
          }
          if (predicates.has(predicate)) return;
          predicates.add(predicate);
          work.push(predicate);
        };
      
        for (const predicate of bodyPredicateDemands(rootClauses || [])) enqueue(predicate);
      
        while (work.length > 0) {
          const predicate = work.shift();
          const indexes = headIndex.get(predicate);
          if (!indexes) continue;
          for (const ruleIndex of indexes) {
            if (ruleIndexes.has(ruleIndex)) continue;
            ruleIndexes.add(ruleIndex);
            const rule = rules[ruleIndex];
            for (const needed of bodyPredicateDemands(rule.body || [])) enqueue(needed);
          }
        }
      
        return { ruleIndexes, predicates };
      }
      
      function bodyPredicateDemands(clauses) {
        const out = [];
        for (const clause of clauses || []) {
          if (clause.type === 'triple') {
            out.push(predicateDemand(clause.triple.p));
            continue;
          }
          if (clause.type === 'not') {
            out.push(...bodyPredicateDemands(clause.body || []));
          }
        }
        return out;
      }
      
      function predicateDemand(term) {
        return term && term.type === 'iri' ? term.value : null;
      }
      
      function normalizePredicateSet(value) {
        if (!value) return null;
        if (value instanceof Set) return value;
        if (Array.isArray(value)) return new Set(value);
        return new Set(String(value).split(',').map((item) => item.trim()).filter(Boolean));
      }
      
      function normalizeRuleIndexSet(value) {
        if (!value) return null;
        if (value instanceof Set) return value;
        if (Array.isArray(value)) return new Set(value);
        return null;
      }
      
      module.exports = {
        BackwardProver,
        backwardQuery,
        planBackwardQuery,
        reachableBackwardRuleIndexes,
        ruleSupported,
        resolveBinding,
      };
      
    },
    "src/output.js": function (require, module, exports) {
      'use strict';
      
      function resultTriples(result, program = {}, options = {}) {
        return options.all ? result.closure : result.inferred;
      }
      
      module.exports = { resultTriples };
      
    },
  };
  const __mappings = {"src/tokenizer.js":{},"src/term.js":{},"src/builtins.js":{"./term.js":"src/term.js"},"src/assignments.js":{},"src/parser.js":{"./tokenizer.js":"src/tokenizer.js","./builtins.js":"src/builtins.js","./assignments.js":"src/assignments.js","./term.js":"src/term.js"},"src/rdf.js":{"./term.js":"src/term.js"},"src/rdfMessages.js":{"./rdf.js":"src/rdf.js","./term.js":"src/term.js"},"src/store.js":{"./term.js":"src/term.js"},"src/analyze.js":{"./term.js":"src/term.js","./assignments.js":"src/assignments.js"},"src/engine.js":{"./store.js":"src/store.js","./term.js":"src/term.js","./builtins.js":"src/builtins.js","./analyze.js":"src/analyze.js"},"src/format.js":{"./term.js":"src/term.js"},"src/backward.js":{"./store.js":"src/store.js","./term.js":"src/term.js","./builtins.js":"src/builtins.js"},"src/query.js":{"./parser.js":"src/parser.js","./store.js":"src/store.js","./engine.js":"src/engine.js","./backward.js":"src/backward.js","./api.js":"src/api.js"},"src/output.js":{},"src/api.js":{"./parser.js":"src/parser.js","./rdf.js":"src/rdf.js","./rdfMessages.js":"src/rdfMessages.js","./engine.js":"src/engine.js","./analyze.js":"src/analyze.js","./format.js":"src/format.js","./query.js":"src/query.js","./output.js":"src/output.js"},"src/cli.js":{"./api.js":"src/api.js","./term.js":"src/term.js"}};
  const __cache = {};
  function __require(id) {
    if (!id.startsWith("src/")) return __nativeRequire(id);
    if (__cache[id]) return __cache[id].exports;
    if (!__modules[id]) throw new Error("Bundled module not found: " + id);
    const module = { exports: {} };
    __cache[id] = module;
    const localRequire = function (request) {
      const mapped = (__mappings[id] && __mappings[id][request]) || request;
      return __require(mapped);
    };
    __modules[id](localRequire, module, module.exports);
    return module.exports;
  }
  Promise.resolve(__require("src/cli.js").main(process.argv.slice(2)))
    .then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(error); process.exitCode = 1; });
}());
