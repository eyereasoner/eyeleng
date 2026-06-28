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
        compile,
        evaluate,
        parseQuery,
        queryResult,
        formatTriples,
        formatTrace,
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
      
      function help() {
        return `eyeleng ${VERSION}\n\nA dependency-free JavaScript implementation experiment for the SHACL 1.2 Rules draft, including SRL and RDF Rules syntax front-ends.\n\nUsage:\n  eyeleng [options] [file ...]\n\nOptions:\n  --all                 Print the full closure, including input facts\n  --json                Print JSON instead of compact triples/bindings\n  --trace               Print derivation trace to stderr, or include it in JSON\n  --stats               Print iteration and triple counts to stderr\n  --check               Parse and analyze only; do not run rules\n  --strict              Treat static warnings as errors\n  --deps                Print rule dependency edges during --check\n  --query TEXT          Run a raw SRL body pattern over the closure\n  --query-file FILE     Read a raw SRL body pattern from a file\n  --max-iterations N    Stop after N fixpoint iterations within a recursive layer\n  --no-imports          Parse IMPORTS/owl:imports but do not load imported rule sets\n  --rdf-messages        Parse input as an RDF Message Log\n  --stream-messages     Replay RDF Message Log envelopes\n  --include-message-facts Include payload facts while parsing RDF Message Logs\n  --syntax MODE         Use srl, rdf, or auto syntax detection (default auto)\n  --ruleset TERM        In RDF syntax, run only the selected srl:RuleSet\n  --version             Print version\n  -h, --help            Print this help\n\nWith no file arguments, eyeleng reads from stdin.\n`;
      }
      
      function parseArgs(argv) {
        const options = {
          all: false,
          json: false,
          trace: false,
          stats: false,
          check: false,
          strict: false,
          deps: false,
          query: null,
          queryFile: null,
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
          else if (arg === '--trace') options.trace = true;
          else if (arg === '--stats') options.stats = true;
          else if (arg === '--check') options.check = true;
          else if (arg === '--strict') options.strict = true;
          else if (arg === '--deps') options.deps = true;
          else if (arg === '--no-imports') options.imports = false;
          else if (arg === '--rdf-messages' || arg === '--stream-messages') options.rdfMessages = true;
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
          }
          else if (arg === '--query') {
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
          } else if (arg.startsWith('-')) {
            throw new Error(`Unknown option ${arg}`);
          } else {
            files.push(arg);
          }
        }
        if (options.query && options.queryFile) throw new Error('Use either --query or --query-file, not both');
        return { options, files };
      }
      
      function readInput(files) {
        if (files.length === 0) return { source: fs.readFileSync(0, 'utf8'), filename: '<stdin>', baseIRI: null };
        if (files.length === 1) {
          const filename = path.resolve(files[0]);
          return { source: fs.readFileSync(filename, 'utf8'), filename, baseIRI: pathToFileURL(filename).href };
        }
        return { source: files.map((file) => fs.readFileSync(file, 'utf8')).join('\n'), filename: '<input>', baseIRI: null };
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
          const kind = edge.negative ? 'NOT' : 'uses';
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
      
      function main(argv = process.argv.slice(2), io = process) {
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
          const input = readInput(files);
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
      
          const result = evaluate(compiled.program, { ...options, analysis: compiled.analysis });
          result.diagnostics = compiled.diagnostics;
          result.analysis = compiled.analysis;
      
          const queryText = options.queryFile ? fs.readFileSync(options.queryFile, 'utf8') : options.query;
          const querySpec = queryText
            ? parseQuery(queryText, { filename: options.queryFile || '<query>', prefixes: compiled.program.prefixes, baseIRI: compiled.program.baseIRI })
            : null;
          if (querySpec) result.query = queryResult(result, querySpec, options);
      
          if (options.json) {
            io.stdout.write(`${JSON.stringify(toJSON(result, { all: options.all, trace: options.trace, analysis: options.deps }), null, 2)}\n`);
          } else if (result.query) {
            const out = formatBindings(result.query.bindings, result.prefixes, result.query.select);
            if (out) io.stdout.write(`${out}\n`);
          } else {
            if (options.trace && result.trace.length > 0) io.stderr.write(`${formatTrace(result.trace, result.prefixes)}\n`);
            const triples = resultTriples(result, compiled.program, options);
            const out = formatTriples(triples, result.prefixes);
            if (out) io.stdout.write(`${out}\n`);
          }
      
          if (options.stats) {
            io.stderr.write(`eyeleng: iterations=${result.iterations} layers=${result.layers.length} input=${result.input.length} inferred=${result.inferred.length} closure=${result.closure.length} ruleApplications=${result.ruleApplications}\n`);
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
      
      if (require.main === module) process.exitCode = main();
      
      module.exports = { main, parseArgs, help, VERSION, createFileImportResolver };
      
    },
    "src/api.js": function (require, module, exports) {
      'use strict';
      
      const { parse, parseQuery } = require('./parser.js');
      const { parseRdfSyntax, parseRdfDocument, rdfDocumentToProgram, looksLikeRdfRules } = require('./rdfSyntax.js');
      const { parseRdfMessageLog, looksLikeRdfMessageLog } = require('./rdfMessages.js');
      const { evaluate } = require('./engine.js');
      const { analyze } = require('./analyze.js');
      const { formatTriples, sortTriples, toJSON, formatTrace, formatBindings } = require('./format.js');
      const { runQuery, queryResult } = require('./query.js');
      const { resultTriples } = require('./output.js');
      
      function parseInput(source, options = {}) {
        if (typeof source !== 'string') return source;
        if (looksLikeRdfMessageLog(source, options)) return parseRdfMessageLog(source, options);
        return looksLikeRdfRules(source, options) ? parseRdfSyntax(source, options) : parse(source, options);
      }
      
      function compile(source, options = {}) {
        const parsed = parseInput(source, options);
        const program = options.resolveImports === false ? parsed : resolveImports(parsed, options);
        const analysis = analyze(program, options);
        const diagnostics = analysis.diagnostics;
        const fatal = analysis.errors.length > 0 || (options.strict && analysis.warnings.length > 0);
        if (fatal && options.throwOnDiagnostics !== false) {
          const details = diagnostics.map((diagnostic) => diagnostic.message).join('; ');
          throw new Error(`${analysis.errors.length > 0 ? 'Analysis failed' : 'Strict mode failed'}: ${details}`);
        }
        return { program, diagnostics, analysis };
      }
      
      function resolveImports(program, options = {}, seen = new Set()) {
        if (!program.imports || program.imports.length === 0) return cloneProgram(program);
        const importResolver = options.importResolver;
        if (!importResolver) return cloneProgram(program);
      
        let merged = emptyProgram(program);
        const localKey = program.baseIRI || options.filename || '<input>';
        if (localKey) seen.add(localKey);
      
        for (const target of program.imports) {
          if (seen.has(target)) continue;
          seen.add(target);
          const resolved = importResolver(target, { from: program.baseIRI || options.filename || null, seen });
          if (!resolved) throw new Error(`IMPORTS resolver returned no source for ${target}`);
          const importSource = typeof resolved === 'string' ? resolved : resolved.source;
          const importOptions = typeof resolved === 'string' ? {} : (resolved.options || {});
          const parsedImport = parseInput(importSource, { ...options, ...importOptions, baseIRI: importOptions.baseIRI || target, filename: importOptions.filename || target });
          const imported = resolveImports(parsedImport, { ...options, ...importOptions, importResolver }, seen);
          merged = mergePrograms(merged, imported);
        }
      
        return mergePrograms(merged, program);
      }
      
      function emptyProgram(program = {}) {
        return {
          baseIRI: program.baseIRI || null,
          version: program.version || null,
          imports: [],
          prefixes: { ...(program.prefixes || {}) },
          data: [],
          rules: [],
        };
      }
      
      function cloneProgram(program) {
        return {
          baseIRI: program.baseIRI || null,
          version: program.version || null,
          imports: (program.imports || []).slice(),
          prefixes: { ...(program.prefixes || {}) },
          data: (program.data || []).slice(),
          rules: (program.rules || []).slice(),
        };
      }
      
      function mergePrograms(left, right) {
        return {
          baseIRI: right.baseIRI || left.baseIRI || null,
          version: right.version || left.version || null,
          imports: Array.from(new Set([...(left.imports || []), ...(right.imports || [])])),
          prefixes: { ...(left.prefixes || {}), ...(right.prefixes || {}) },
          data: [...(left.data || []), ...(right.data || [])],
          rules: [...(left.rules || []), ...(right.rules || [])],
        };
      }
      
      function run(source, options = {}) {
        const { program, diagnostics, analysis } = compile(source, options);
        const result = evaluate(program, { ...options, analysis });
        result.diagnostics = diagnostics;
        result.analysis = analysis;
        return result;
      }
      
      function runToString(source, options = {}) {
        const { program, diagnostics, analysis } = compile(source, options);
        const result = evaluate(program, { ...options, analysis });
        result.diagnostics = diagnostics;
        result.analysis = analysis;
        const triples = resultTriples(result, program, options);
        return formatTriples(triples, result.prefixes);
      }
      
      module.exports = {
        parse,
        parseQuery,
        parseInput,
        parseRdfSyntax,
        parseRdfDocument,
        parseRdfMessageLog,
        looksLikeRdfMessageLog,
        rdfDocumentToProgram,
        compile,
        resolveImports,
        mergePrograms,
        analyze,
        evaluate,
        run,
        runToString,
        runQuery,
        queryResult,
        formatTriples,
        formatBindings,
        sortTriples,
        toJSON,
        formatTrace,
        resultTriples,
      };
      
    },
    "src/parser.js": function (require, module, exports) {
      'use strict';
      
      const { tokenize, SyntaxErrorWithLocation } = require('./tokenizer.js');
      const { parseN3 } = require('./rdfSyntax.js');
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
          this.prefixes = {
            rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
            sh: 'http://www.w3.org/ns/shacl#',
            srl: 'http://www.w3.org/ns/shacl-rules#',
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
              data.push(...this.parseDataBlockWithRdfSyntax());
            } else if (this.matchWord('RULE')) {
              rules.push(this.parseRule());
            } else if (this.matchWord('IF')) {
              rules.push(this.parseIfThenRule());
            } else if (this.checkDeclarationKeyword()) {
              rules.push(...this.parseDeclaration());
            } else {
              throw this.error(`Expected PREFIX, BASE, VERSION, IMPORTS, DATA, RULE, IF, TRANSITIVE, SYMMETRIC, or INVERSE; got ${this.peek().value}`);
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
            if (token.value !== '1.2') throw this.error('VERSION must be the SHACL Rules version label \"1.2\"', token);
          }
          this.version = token.value;
        }
      
        parseImports() {
          const target = this.parseIRIValue();
          this.imports.push(target.value);
          this.consumeOptionalDot();
        }
      
        parseRule() {
          this.expectValue('{');
          const head = this.parseTriplesBlock({ allowPath: false, context: 'head' });
          this.expectWord('WHERE');
          this.expectValue('{');
          const body = this.parseBodyBlockAlreadyOpen();
          return { name: null, head, body, runOnce: ruleNeedsRunOnce(head, body, this.options) };
        }
      
        parseIfThenRule() {
          this.expectValue('{');
          const body = this.parseBodyBlockAlreadyOpen();
          this.expectWord('THEN');
          this.expectValue('{');
          const head = this.parseTriplesBlock({ allowPath: false, context: 'head' });
          return { name: null, head, body, runOnce: ruleNeedsRunOnce(head, body, this.options) };
        }
      
        checkDeclarationKeyword() {
          return this.checkType('word') && ['TRANSITIVE', 'SYMMETRIC', 'INVERSE'].includes(this.peek().value.toUpperCase());
        }
      
        parseDeclaration() {
          if (this.matchWord('TRANSITIVE')) {
            this.expectValue('(');
            const pred = this.parseIRIValue();
            this.expectValue(')');
            this.consumeOptionalDot();
            return [{
              name: `TRANSITIVE(${pred.lexical})`,
              head: [{ s: variable('x'), p: iri(pred.value), o: variable('z') }],
              body: [
                { type: 'triple', triple: { s: variable('x'), p: iri(pred.value), o: variable('y') } },
                { type: 'triple', triple: { s: variable('y'), p: iri(pred.value), o: variable('z') } },
              ],
              runOnce: false,
            }];
          }
          if (this.matchWord('SYMMETRIC')) {
            this.expectValue('(');
            const pred = this.parseIRIValue();
            this.expectValue(')');
            this.consumeOptionalDot();
            return [{
              name: `SYMMETRIC(${pred.lexical})`,
              head: [{ s: variable('y'), p: iri(pred.value), o: variable('x') }],
              body: [{ type: 'triple', triple: { s: variable('x'), p: iri(pred.value), o: variable('y') } }],
              runOnce: false,
            }];
          }
          if (this.matchWord('INVERSE')) {
            this.expectValue('(');
            const left = this.parseIRIValue();
            this.expectValue(',');
            const right = this.parseIRIValue();
            this.expectValue(')');
            this.consumeOptionalDot();
            return [
              {
                name: `INVERSE(${left.lexical},${right.lexical})#1`,
                head: [{ s: variable('y'), p: iri(right.value), o: variable('x') }],
                body: [{ type: 'triple', triple: { s: variable('x'), p: iri(left.value), o: variable('y') } }],
                runOnce: false,
              },
              {
                name: `INVERSE(${left.lexical},${right.lexical})#2`,
                head: [{ s: variable('y'), p: iri(left.value), o: variable('x') }],
                body: [{ type: 'triple', triple: { s: variable('x'), p: iri(right.value), o: variable('y') } }],
                runOnce: false,
              },
            ];
          }
          throw this.error(`Expected declaration, got ${this.peek().value}`);
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
      
        parseDataBlockWithRdfSyntax() {
          const blockSource = this.collectBalancedDataBlockSource();
          const program = parseN3(blockSource, {
            profile: 'trig',
            base: this.baseIRI || '',
            prefixes: this.prefixes,
          });
          return (program.facts || []).map((triple) => this.convertRdfSyntaxTriple(triple));
        }
      
        collectBalancedDataBlockSource() {
          const tokens = [];
          let depth = 1;
          while (!this.is('eof')) {
            const token = this.advance();
            if (token.value === '{') {
              depth += 1;
              tokens.push(token);
            } else if (token.value === '}') {
              depth -= 1;
              if (depth === 0) return this.tokensToRdfSource(tokens);
              tokens.push(token);
            } else {
              tokens.push(token);
            }
          }
          throw this.error('Unterminated DATA block');
        }
      
        tokensToRdfSource(tokens) {
          const parts = [];
          for (let i = 0; i < tokens.length; i += 1) {
            const token = tokens[i];
            if (token.type === 'eof') continue;
            if ((token.value === '+' || token.value === '-') && tokens[i + 1] && tokens[i + 1].type === 'number') {
              parts.push(`${token.value}${this.tokenToRdfSource(tokens[i + 1])}`);
              i += 1;
            } else {
              parts.push(this.tokenToRdfSource(token));
            }
          }
          return parts.join(' ');
        }
      
        tokenToRdfSource(token) {
          if (token.type === 'iri') return `<${String(token.value).replace(/>/g, '\\>')}>`;
          if (token.type === 'string') return JSON.stringify(token.value);
          if (token.type === 'variable') return `?${token.value}`;
          if (token.type === 'number') return String(token.value);
          return String(token.value);
        }
      
        convertRdfSyntaxTriple(triple) {
          const out = {
            s: this.convertRdfSyntaxTerm(triple.s),
            p: this.convertRdfSyntaxTerm(triple.p),
            o: this.convertRdfSyntaxTerm(triple.o),
          };
          if (out.s.type === 'var' || out.p.type === 'var' || out.o.type === 'var') {
            throw this.error('DATA blocks may not contain variables');
          }
          if (out.p.type !== 'iri') {
            throw this.error('DATA predicates must be IRIs');
          }
          if (triple.graph) out.graph = this.convertRdfSyntaxTerm(triple.graph);
          return out;
        }
      
        convertRdfSyntaxTerm(term) {
          if (!term) return null;
          if (term.type) return term;
          if (term.kind === 'iri') return iri(term.value);
          if (term.kind === 'blank') return blankNode(term.value);
          if (term.kind === 'var') return variable(term.name || term.value);
          if (term.kind === 'literal') {
            return literal(
              coerceLexicalLiteral(term.value, term.datatype),
              term.datatype === XSD_STRING ? null : (term.datatype || null),
              term.language || null,
              term.langDir || null,
            );
          }
          if (term.kind === 'triple') {
            return tripleTerm(
              this.convertRdfSyntaxTerm(term.s),
              this.convertRdfSyntaxTerm(term.p),
              this.convertRdfSyntaxTerm(term.o),
            );
          }
          throw this.error(`Unsupported RDF term kind ${term.kind || typeof term}`);
        }
      
        parseTripleStatement(options = {}) {
          const subjectNode = this.parseGraphNode(options);
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
              const objectNode = this.parseGraphNode(options);
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
      
          const items = [];
          while (!this.checkValue(')')) items.push(this.parseGraphNode(options));
          this.expectValue(')');
      
          const triples = [];
          for (const item of items) triples.push(...item.triples);
          const cells = items.map(() => this.freshGraphNode(options));
          for (let i = 0; i < items.length; i += 1) {
            triples.push({ s: cells[i], p: iri(RDF_FIRST), o: items[i].term });
            triples.push({ s: cells[i], p: iri(RDF_REST), o: i + 1 < cells.length ? cells[i + 1] : iri(RDF_NIL) });
          }
          return { term: cells[0], triples };
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
          return this.parseVarOrReifierId();
        }
      
        parseVarOrReifierId() {
          const token = this.peek();
          if (token.type === 'variable') return this.parseTerm();
          if (token.type === 'iri') return this.parseTerm();
          if (token.type === 'word' && (token.value.startsWith('_:') || token.value.includes(':'))) return this.parseTerm();
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
          const term = this.parseTerm(options);
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
              if (this.strictGrammar()) throw this.error('BIND is not part of the SHACL 1.2 Rules grammar; use SET');
              clauses.push(this.parseBindClause());
            } else if (this.matchWord('NOT')) {
              this.expectValue('{');
              const body = this.parseBodyBasicAlreadyOpen();
              clauses.push({ type: 'not', body });
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
            if (token.value === 'a') return iri(RDF_TYPE);
            if (token.value === 'true') return literal(true, XSD_BOOLEAN);
            if (token.value === 'false') return literal(false, XSD_BOOLEAN);
            if (token.value.startsWith('_:')) return blankNode(token.value.slice(2));
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
            if (!this.checkValue('>>')) this.parseVarOrReifierId();
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
            const tag = this.advance().value.slice(1).toLowerCase();
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
        strictGrammar() { return !!this.options.strictGrammar; }
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
          throw new Error('QUERY/SELECT concrete syntax is not part of the SHACL Rules SRL grammar; pass a raw body pattern instead');
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
    "src/rdfSyntax.js": function (require, module, exports) {
      'use strict';
      
      const { tokenize, SyntaxErrorWithLocation } = require('./tokenizer.js');
      const { ruleNeedsRunOnce } = require('./assignments.js');
      const {
        iri,
        variable,
        blankNode,
        literal,
        tripleTerm,
        termKey,
        termEquals,
        formatTerm,
        RDF_TYPE,
        RDF_FIRST,
        RDF_REST,
        RDF_NIL,
        XSD_BOOLEAN,
        XSD_INTEGER,
        XSD_DECIMAL,
        XSD_DOUBLE,
      } = require('./term.js');
      
      const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
      const SRL_NS = 'http://www.w3.org/ns/shacl-rules#';
      const SHNEX_NS = 'http://www.w3.org/ns/shacl-node-expr#';
      const SPARQL_NS = 'http://www.w3.org/ns/sparql#';
      const OWL_IMPORTS = 'http://www.w3.org/2002/07/owl#imports';
      const SRL_RULE_SET = `${SRL_NS}RuleSet`;
      const SRL_RULE = `${SRL_NS}Rule`;
      const SRL_DATA = `${SRL_NS}data`;
      const SRL_RULES = `${SRL_NS}rules`;
      const SRL_BODY = `${SRL_NS}body`;
      const SRL_HEAD = `${SRL_NS}head`;
      const SRL_SUBJECT = `${SRL_NS}subject`;
      const SRL_PREDICATE = `${SRL_NS}predicate`;
      const SRL_OBJECT = `${SRL_NS}object`;
      const SRL_FILTER = `${SRL_NS}filter`;
      const SRL_EXPR = `${SRL_NS}expr`;
      const SRL_ASSIGN = `${SRL_NS}assign`;
      const SRL_ASSIGN_VAR = `${SRL_NS}assignVar`;
      const SRL_ASSIGN_VALUE = `${SRL_NS}assignValue`;
      const SRL_NOT = `${SRL_NS}not`;
      const SRL_VAR_NAME = `${SRL_NS}varName`;
      const SHNEX_VAR = `${SHNEX_NS}var`;
      
      class TurtleParser {
        constructor(source, options = {}) {
          this.tokens = Array.isArray(source) ? source : tokenize(source, options.filename || '<rdf>');
          this.pos = 0;
          this.baseIRI = options.baseIRI || null;
          this.bnodeCounter = 0;
          this.prefixes = {
            '': 'http://example/',
            rdf: RDF_NS,
            srl: SRL_NS,
            shnex: SHNEX_NS,
            sparql: SPARQL_NS,
            xsd: 'http://www.w3.org/2001/XMLSchema#',
            owl: 'http://www.w3.org/2002/07/owl#',
            ...options.prefixes,
          };
          this.triples = [];
          this.imports = [];
        }
      
        parseDocument() {
          while (!this.is('eof')) {
            if (this.matchDirective('PREFIX', '@prefix')) this.parsePrefix(this.previous().value.startsWith('@'));
            else if (this.matchDirective('BASE', '@base')) this.parseBase(this.previous().value.startsWith('@'));
            else this.parseTriplesStatement();
          }
          return {
            baseIRI: this.baseIRI,
            prefixes: { ...this.prefixes },
            triples: this.triples,
            imports: this.imports.slice(),
          };
        }
      
        parsePrefix(atStyle = false) {
          const nameToken = this.advance();
          if (nameToken.type !== 'word' || !nameToken.value.endsWith(':')) throw this.error('Expected prefix label ending in :', nameToken);
          const iriToken = this.expectType('iri');
          this.prefixes[nameToken.value.slice(0, -1)] = this.resolveIRI(iriToken.value, iriToken);
          if (atStyle) this.expectValue('.');
        }
      
        parseBase(atStyle = false) {
          const iriToken = this.expectType('iri');
          this.baseIRI = this.resolveIRI(iriToken.value, iriToken);
          if (atStyle) this.expectValue('.');
        }
      
        parseTriplesStatement() {
          const subjectNode = this.parseNode();
          this.triples.push(...subjectNode.triples);
          this.triples.push(...this.parsePredicateObjectList(subjectNode.term, ['.']));
          this.expectValue('.');
        }
      
        parsePredicateObjectList(subject, terminators = [']']) {
          const triples = [];
          while (!terminators.some((value) => this.checkValue(value))) {
            const predicate = this.parseVerb();
            do {
              const objectNode = this.parseNode();
              triples.push(...objectNode.triples);
              triples.push({ s: subject, p: predicate, o: objectNode.term });
              if (predicate.type === 'iri' && predicate.value === OWL_IMPORTS && objectNode.term.type === 'iri') this.imports.push(objectNode.term.value);
            } while (this.matchValue(','));
            if (this.matchValue(';')) {
              while (this.matchValue(';')) { /* tolerate repeated semicolons */ }
              if (terminators.some((value) => this.checkValue(value))) break;
            } else break;
          }
          return triples;
        }
      
        parseNode() {
          if (this.checkValue('[')) return this.parseBlankNodePropertyList();
          if (this.checkValue('(')) return this.parseCollection();
          return { term: this.parseTerm(), triples: [] };
        }
      
        parseBlankNodePropertyList() {
          this.expectValue('[');
          const node = this.freshBlankNode();
          if (this.matchValue(']')) return { term: node, triples: [] };
          const triples = this.parsePredicateObjectList(node, [']']);
          this.expectValue(']');
          return { term: node, triples };
        }
      
        parseCollection() {
          this.expectValue('(');
          if (this.matchValue(')')) return { term: iri(RDF_NIL), triples: [] };
          const items = [];
          while (!this.checkValue(')')) items.push(this.parseNode());
          this.expectValue(')');
          const triples = [];
          for (const item of items) triples.push(...item.triples);
          const cells = items.map(() => this.freshBlankNode());
          for (let i = 0; i < items.length; i += 1) {
            triples.push({ s: cells[i], p: iri(RDF_FIRST), o: items[i].term });
            triples.push({ s: cells[i], p: iri(RDF_REST), o: i + 1 < cells.length ? cells[i + 1] : iri(RDF_NIL) });
          }
          return { term: cells[0], triples };
        }
      
        parseVerb() {
          if (this.checkType('word') && this.peek().value === 'a') { this.advance(); return iri(RDF_TYPE); }
          const term = this.parseTerm();
          if (term.type !== 'iri') throw this.error('Expected IRI as Turtle predicate');
          return term;
        }
      
        parseTerm() {
          const token = this.advance();
          if (token.type === 'operator' && (token.value === '+' || token.value === '-') && this.peek().type === 'number') {
            const numberToken = this.advance();
            return numericLiteral(token.value === '-' ? -numberToken.value : numberToken.value);
          }
          if (token.type === 'iri') return iri(this.resolveIRI(token.value, token));
          if (token.type === 'string') return this.parseLiteralAfterToken(token);
          if (token.type === 'number') return numericLiteral(token.value);
          if (token.value === '<<(') return this.parseTripleTermAfterOpen();
          if (token.type === 'word') {
            const word = token.value.includes(':') || token.value.startsWith('_:') ? this.consumeHyphenatedWord(token.value) : token.value;
            if (word === 'a') return iri(RDF_TYPE);
            if (word === 'true') return literal(true, XSD_BOOLEAN);
            if (word === 'false') return literal(false, XSD_BOOLEAN);
            if (word.startsWith('_:')) return blankNode(word.slice(2));
            if (word.includes(':')) return iri(this.expandPrefixedName(word, token));
          }
          throw this.error(`Expected RDF term, got ${token.value}`, token);
        }
      
        parseTripleTermAfterOpen() {
          const s = this.parseTerm();
          const p = this.parseVerb();
          const o = this.parseTerm();
          this.expectValue(')>>');
          return tripleTerm(s, p, o);
        }
      
        parseLiteralAfterToken(token) {
          if (this.matchValue('^^')) {
            const datatype = this.parseDatatypeIRI();
            return literal(coerceLexicalLiteral(token.value, datatype), datatype, null);
          }
          if (this.checkType('word') && /^@[A-Za-z]+(?:-[A-Za-z0-9]+)*(?:--[A-Za-z]+)?$/.test(this.peek().value)) {
            const tag = this.advance().value.slice(1).toLowerCase();
            const [lang, langDir = null] = tag.split('--');
            return literal(token.value, null, lang, langDir);
          }
          return literal(token.value);
        }
      
        parseDatatypeIRI() {
          const token = this.advance();
          if (token.type === 'iri') return this.resolveIRI(token.value, token);
          if (token.type === 'word' && token.value.includes(':')) return this.expandPrefixedName(token.value, token);
          throw this.error(`Expected datatype IRI, got ${token.value}`, token);
        }
      
        freshBlankNode() {
          this.bnodeCounter += 1;
          return blankNode(`rdf${this.bnodeCounter}`);
        }
      
        consumeHyphenatedWord(value) {
          let out = value;
          while (this.checkValue('-') && (this.peekN(1).type === 'word' || this.peekN(1).type === 'number')) {
            this.advance();
            out += `-${this.advance().value}`;
          }
          return out;
        }
      
        expandPrefixedName(value, token) {
          const colon = value.indexOf(':');
          if (colon < 0) throw this.error(`Expected prefixed name, got ${value}`, token);
          const prefix = value.slice(0, colon);
          const local = value.slice(colon + 1);
          if (!Object.hasOwn(this.prefixes, prefix)) throw this.error(`Unknown prefix ${prefix}:`, token);
          return this.prefixes[prefix] + local;
        }
      
        resolveIRI(value) {
          if (!this.baseIRI || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return value;
          try { return new URL(value, this.baseIRI).href; } catch (_) { return value; }
        }
      
        matchDirective(...names) {
          if (this.checkType('word')) {
            const value = this.peek().value;
            if (names.some((name) => value.toUpperCase() === name.toUpperCase())) { this.advance(); return true; }
          }
          return false;
        }
      
        previous() { return this.tokens[this.pos - 1]; }
        peek() { return this.tokens[this.pos]; }
        peekN(n) { return this.tokens[this.pos + n]; }
        is(type) { return this.peek().type === type; }
        checkType(type) { return this.peek().type === type; }
        checkValue(value) { return this.peek().value === value; }
        matchValue(value) { if (this.checkValue(value)) { this.advance(); return true; } return false; }
        advance() { return this.tokens[this.pos++]; }
        expectType(type) { const token = this.advance(); if (token.type !== type) throw this.error(`Expected ${type}, got ${token.value}`, token); return token; }
        expectValue(value) { const token = this.advance(); if (token.value !== value) throw this.error(`Expected ${value}, got ${token.value}`, token); return token; }
        error(message, token = this.peek()) { return new SyntaxErrorWithLocation(message, token); }
      }
      
      function parseRdfDocument(source, options = {}) {
        return new TurtleParser(source, options).parseDocument();
      }
      
      function parseRdfSyntax(source, options = {}) {
        const document = parseRdfDocument(source, options);
        return rdfDocumentToProgram(document, options);
      }
      
      function rdfDocumentToProgram(document, options = {}) {
        const graph = new RdfGraph(document.triples, document.prefixes);
        const ruleSetNodes = chooseRuleSets(graph, options.ruleSet);
        if (ruleSetNodes.length === 0) throw new Error('No srl:RuleSet found in RDF Rules syntax input');
      
        const program = {
          baseIRI: document.baseIRI || null,
          version: null,
          imports: options.rdfImportsAsImports ? document.imports.slice() : [],
          prefixes: { ...document.prefixes },
          data: [],
          rules: [],
          rdfSyntax: true,
          options: { shacl12Conformance: !!options.shacl12Conformance },
          ruleSets: ruleSetNodes.map((term) => formatTerm(term, document.prefixes)),
        };
      
        for (const ruleSet of ruleSetNodes) {
          for (const dataList of graph.objects(ruleSet, SRL_DATA)) {
            for (const item of graph.list(dataList)) program.data.push(toDataTriple(item, graph));
          }
          for (const rulesList of graph.objects(ruleSet, SRL_RULES)) {
            for (const ruleNode of graph.list(rulesList)) program.rules.push(toRule(ruleNode, graph, options));
          }
        }
        return program;
      }
      
      function chooseRuleSets(graph, selected) {
        if (selected) {
          const term = graph.parseReference(selected);
          return [term];
        }
        const typed = graph.subjects(RDF_TYPE, iri(SRL_RULE_SET));
        if (typed.length > 0) return uniqueTerms(typed);
        const byData = graph.subjectsWithPredicate(SRL_DATA);
        const byRules = graph.subjectsWithPredicate(SRL_RULES);
        return uniqueTerms([...byData, ...byRules]).filter((term) => graph.objects(term, SRL_RULES).length > 0 || graph.objects(term, SRL_DATA).length > 0);
      }
      
      function toDataTriple(item, graph) {
        if (item.type === 'triple') return { s: item.s, p: item.p, o: item.o };
        const triple = toTripleLike(item, graph);
        if ([triple.s, triple.p, triple.o].some((term) => term.type === 'var')) throw new Error('RDF Rules srl:data may not contain variables');
        if (triple.p.type !== 'iri') throw new Error('RDF Rules data triple predicate must be an IRI');
        return triple;
      }
      
      function toRule(ruleNode, graph, options = {}) {
        const bodyLists = graph.objects(ruleNode, SRL_BODY);
        const headLists = graph.objects(ruleNode, SRL_HEAD);
        if (bodyLists.length !== 1 || headLists.length !== 1) throw new Error(`RDF Rule ${graph.label(ruleNode)} must have exactly one srl:body and one srl:head`);
        const body = graph.list(bodyLists[0]).map((item) => toBodyElement(item, graph));
        const head = graph.list(headLists[0]).map((item) => toTripleLike(item, graph));
        return { name: graph.label(ruleNode), head, body, runOnce: ruleNeedsRunOnce(head, body, options) };
      }
      
      function toBodyElement(node, graph) {
        if (hasTripleShape(node, graph)) return { type: 'triple', triple: toTripleLike(node, graph) };
        const filters = graph.objects(node, SRL_FILTER).concat(graph.objects(node, SRL_EXPR));
        if (filters.length > 0) {
          if (filters.length !== 1) throw new Error(`Filter element ${graph.label(node)} must have exactly one srl:filter`);
          return { type: 'filter', expr: toExpression(filters[0], graph) };
        }
        const assigns = graph.objects(node, SRL_ASSIGN);
        if (assigns.length > 0) {
          if (assigns.length !== 1) throw new Error(`Assignment element ${graph.label(node)} must have exactly one srl:assign`);
          const assign = assigns[0];
          const vars = graph.objects(assign, SRL_ASSIGN_VAR);
          const values = graph.objects(assign, SRL_ASSIGN_VALUE);
          if (vars.length !== 1 || values.length !== 1) throw new Error(`Assignment ${graph.label(assign)} must have exactly one srl:assignVar and srl:assignValue`);
          const variableTerm = toVarOrTerm(vars[0], graph);
          if (variableTerm.type !== 'var') throw new Error('srl:assignVar must point to a variable node');
          return { type: 'set', variable: variableTerm.value, expr: toExpression(values[0], graph) };
        }
        const negations = graph.objects(node, SRL_NOT);
        if (negations.length > 0) {
          if (negations.length !== 1) throw new Error(`Negation element ${graph.label(node)} must have exactly one srl:not`);
          const body = graph.list(negations[0]).map((item) => {
            const clause = toBodyElement(item, graph);
            if (clause.type === 'set' || clause.type === 'not') throw new Error('RDF Rules srl:not may contain only triple patterns and filters');
            return clause;
          });
          return { type: 'not', body };
        }
        throw new Error(`Unsupported RDF Rules body element ${graph.label(node)}`);
      }
      
      function toTripleLike(node, graph) {
        if (node.type === 'triple') return { s: node.s, p: node.p, o: node.o };
        const subjects = graph.objects(node, SRL_SUBJECT);
        const predicates = graph.objects(node, SRL_PREDICATE);
        const objects = graph.objects(node, SRL_OBJECT);
        if (subjects.length !== 1 || predicates.length !== 1 || objects.length !== 1) {
          throw new Error(`Triple node ${graph.label(node)} must have exactly one srl:subject, srl:predicate and srl:object`);
        }
        return {
          s: toVarOrTerm(subjects[0], graph),
          p: toVarOrTerm(predicates[0], graph),
          o: toVarOrTerm(objects[0], graph),
        };
      }
      
      function hasTripleShape(node, graph) {
        return graph.objects(node, SRL_SUBJECT).length > 0 || graph.objects(node, SRL_PREDICATE).length > 0 || graph.objects(node, SRL_OBJECT).length > 0;
      }
      
      function toVarOrTerm(node, graph) {
        const varNames = graph.objects(node, SRL_VAR_NAME);
        if (varNames.length > 0) {
          if (varNames.length !== 1 || varNames[0].type !== 'literal') throw new Error(`Variable node ${graph.label(node)} must have exactly one string srl:varName`);
          return variable(String(varNames[0].value));
        }
        return node;
      }
      
      function toExpression(node, graph) {
        const varNames = graph.objects(node, SHNEX_VAR).concat(graph.objects(node, SRL_VAR_NAME));
        if (varNames.length > 0) {
          if (varNames.length !== 1 || varNames[0].type !== 'literal') throw new Error(`Expression variable ${graph.label(node)} must name one variable`);
          return { type: 'var', name: String(varNames[0].value) };
        }
        if (node.type === 'literal') {
          if (node.datatype || node.lang) return { type: 'term', value: node };
          return { type: 'literal', value: node.value };
        }
        if (node.type === 'iri' || node.type === 'blank' || node.type === 'triple') {
          const call = graph.functionCall(node);
          if (call) return toFunctionExpression(call.name, call.args.map((arg) => toExpression(arg, graph)));
          if (node.type === 'blank' && graph.hasOutgoing(node)) return { type: 'term', value: node };
          return { type: 'term', value: toVarOrTerm(node, graph) };
        }
        return { type: 'term', value: node };
      }
      
      function toFunctionExpression(name, args) {
        if (name.startsWith(SPARQL_NS)) {
          const local = name.slice(SPARQL_NS.length);
          if (local === 'less-than' || local === 'lessThan') return binary('<', args);
          if (local === 'less-than-or-equal' || local === 'lessThanOrEqual') return binary('<=', args);
          if (local === 'greater-than' || local === 'greaterThan') return binary('>', args);
          if (local === 'greater-than-or-equal' || local === 'greaterThanOrEqual') return binary('>=', args);
          if (local === 'equal' || local === 'equals') return binary('=', args);
          if (local === 'not-equal' || local === 'notEqual') return binary('!=', args);
          if (local === 'add') return foldBinary('+', args);
          if (local === 'subtract') return binary('-', args);
          if (local === 'multiply') return foldBinary('*', args);
          if (local === 'divide') return binary('/', args);
          if (local === 'and' || local === 'function-and') return foldBinary('&&', args);
          if (local === 'or' || local === 'function-or') return foldBinary('||', args);
          if (local === 'not') return { type: 'unary', op: '!', expr: args[0] };
          const builtin = sparqlLocalToBuiltin(local);
          return { type: 'call', name: builtin, args };
        }
        return { type: 'call', name, args };
      }
      
      function binary(op, args) {
        if (args.length !== 2) throw new Error(`sparql operator ${op} expects 2 arguments`);
        return { type: 'binary', op, left: args[0], right: args[1] };
      }
      
      function foldBinary(op, args) {
        if (args.length < 2) throw new Error(`sparql operator ${op} expects at least 2 arguments`);
        return args.slice(1).reduce((left, right) => ({ type: 'binary', op, left, right }), args[0]);
      }
      
      function sparqlLocalToBuiltin(local) {
        return local.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase()).replace(/^./, (ch) => ch.toUpperCase());
      }
      
      class RdfGraph {
        constructor(triples, prefixes = {}) {
          this.triples = triples;
          this.prefixes = prefixes;
          this.bySubject = new Map();
          for (const triple of triples) {
            const key = termKey(triple.s);
            if (!this.bySubject.has(key)) this.bySubject.set(key, []);
            this.bySubject.get(key).push(triple);
          }
        }
      
        objects(subject, predicateIRI) {
          const rows = this.bySubject.get(termKey(subject)) || [];
          return rows.filter((triple) => triple.p.type === 'iri' && triple.p.value === predicateIRI).map((triple) => triple.o);
        }
      
        subjects(predicateIRI, object) {
          return this.triples.filter((triple) => triple.p.type === 'iri' && triple.p.value === predicateIRI && termEquals(triple.o, object)).map((triple) => triple.s);
        }
      
        subjectsWithPredicate(predicateIRI) {
          return this.triples.filter((triple) => triple.p.type === 'iri' && triple.p.value === predicateIRI).map((triple) => triple.s);
        }
      
        hasOutgoing(subject) {
          return (this.bySubject.get(termKey(subject)) || []).length > 0;
        }
      
        list(head) {
          const out = [];
          let node = head;
          const seen = new Set();
          while (!(node.type === 'iri' && node.value === RDF_NIL)) {
            const key = termKey(node);
            if (seen.has(key)) throw new Error(`Cycle in RDF list at ${this.label(node)}`);
            seen.add(key);
            const first = this.objects(node, RDF_FIRST);
            const rest = this.objects(node, RDF_REST);
            if (first.length !== 1 || rest.length !== 1) throw new Error(`Expected RDF list node at ${this.label(node)}`);
            out.push(first[0]);
            node = rest[0];
          }
          return out;
        }
      
        functionCall(node) {
          if (node.type !== 'blank') return null;
          const rows = (this.bySubject.get(termKey(node)) || []).filter((triple) => triple.p.type === 'iri');
          const calls = rows.filter((triple) => triple.p.value.startsWith(SPARQL_NS) || triple.p.value.includes('#') || triple.p.value.includes('/'));
          const viable = calls.filter((triple) => isRdfListHead(triple.o, this));
          if (viable.length !== 1) return null;
          return { name: viable[0].p.value, args: this.list(viable[0].o) };
        }
      
        parseReference(text) {
          if (typeof text !== 'string') return text;
          if (text.startsWith('<') && text.endsWith('>')) return iri(text.slice(1, -1));
          if (text.startsWith('_:')) return blankNode(text.slice(2));
          const colon = text.indexOf(':');
          if (colon >= 0) {
            const prefix = text.slice(0, colon);
            const local = text.slice(colon + 1);
            const ns = this.prefixes[prefix] || (prefix === 'srl' ? SRL_NS : null);
            if (ns) return iri(ns + local);
          }
          return iri(text);
        }
      
        label(term) { return formatTerm(term, this.prefixes); }
      }
      
      function isRdfListHead(term, graph) {
        return (term.type === 'iri' && term.value === RDF_NIL) || graph.objects(term, RDF_FIRST).length === 1;
      }
      
      function uniqueTerms(terms) {
        const seen = new Set();
        const out = [];
        for (const term of terms) {
          const key = termKey(term);
          if (!seen.has(key)) { seen.add(key); out.push(term); }
        }
        return out;
      }
      
      function numericLiteral(value) {
        if (Number.isInteger(value)) return literal(value, XSD_INTEGER);
        if (String(value).includes('e') || String(value).includes('E')) return literal(value, XSD_DOUBLE);
        return literal(value, XSD_DECIMAL);
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
      
      function looksLikeRdfRules(source, options = {}) {
        if (options.syntax === 'rdf') return true;
        if (options.syntax === 'srl') return false;
        if (options.filename && /\.(ttl|trig|nt|n3)$/i.test(options.filename)) return true;
        return /\bsrl:RuleSet\b|\bsrl:rules\b|http:\/\/www\.w3\.org\/ns\/shacl-rules#RuleSet/.test(source);
      }
      
      module.exports = {
        parseRdfDocument,
        parseRdfSyntax,
        rdfDocumentToProgram,
        looksLikeRdfRules,
        TurtleParser,
        RdfGraph,
        constants: {
          SRL_NS,
          SHNEX_NS,
          SPARQL_NS,
          SRL_RULE_SET,
          SRL_RULE,
        },
      };
      
      
      // ---- Grammar-hardened RDF 1.1 / RDF 1.2 syntax helpers ----
      // These functions are used by the W3C RDF manifest harness and are kept in
      // rdfSyntax.js beside the existing Turtle/RDF-Rules front-end instead of in a
      // separate monolithic test file.  They intentionally keep an internal test
      // graph representation because the W3C manifests exercise syntax, datasets,
      // triple terms, and RDF 1.2 annotation isomorphism independently from the SRL
      // rule engine representation.
      const rdfW3cSyntax = (() => {
      // Grammar-hardened RDF syntax code shared by the RDF Rules front-end and W3C manifest harness.
      function iri(value) {
        if (!value) throw new Error('iri(value) requires a non-empty value');
        return Object.freeze({ kind: 'iri', value: String(value) });
      }
      function literal(value, datatype = null, language = null, langDir = null) {
        return Object.freeze({ kind: 'literal', value: String(value), datatype, language, langDir });
      }
      function blank(value) {
        const clean = String(value || '').replace(/^_:/, '');
        if (!clean) throw new Error('blank(value) requires a name');
        return Object.freeze({ kind: 'blank', value: clean });
      }
      function tripleTerm(s, p, o) { return Object.freeze({ kind: 'triple', s, p, o }); }
      function variable(name) {
        const clean = String(name || '').replace(/^\?/, '');
        if (!clean) throw new Error('variable(name) requires a name');
        return Object.freeze({ kind: 'var', name: clean });
      }
      function triple(s, p, o, graph = null) { return Object.freeze({ s, p, o, graph }); }
      function termKey(term) {
        if (!term) return 'default';
        switch (term.kind) {
          case 'iri': return `I:${term.value}`;
          case 'literal': return `L:${JSON.stringify(term.value)}^^${term.datatype || ''}@${term.language || ''}`;
          case 'blank': return `B:${term.value}`;
          case 'var': return `V:${term.name}`;
          case 'triple': return `T:${termKey(term.s)} ${termKey(term.p)} ${termKey(term.o)}`;
          default: throw new Error(`Unsupported term kind: ${term.kind}`);
        }
      }
      function tripleKey(t) { return `${termKey(t.s)} ${termKey(t.p)} ${termKey(t.o)} ${termKey(t.graph)}`; }
      class Rule { constructor({ id, body = [], head = [], profile = 'n3-rules-subset-v0' } = {}) { this.id = id; this.body = body; this.head = head; this.profile = profile; } }
      
      const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
      const RDF_TYPE = `${RDF_NS}type`;
      const RDF_FIRST = `${RDF_NS}first`;
      const RDF_REST = `${RDF_NS}rest`;
      const RDF_NIL = `${RDF_NS}nil`;
      const RDF_REIFIES = `${RDF_NS}reifies`;
      const RDF_LANG_STRING = `${RDF_NS}langString`;
      const RDF_DIR_LANG_STRING = `${RDF_NS}dirLangString`;
      const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';
      const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
      const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';
      const XSD_DOUBLE = 'http://www.w3.org/2001/XMLSchema#double';
      const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
      
      // ---- N-Triples / N-Quads parser ----
      const { parseNQuads, termToNQuads, tripleToNQuads, triplesToNQuads } = (() => {
      
      function isWs(ch) { return ch === ' ' || ch === '\t'; }
      function isLineEnd(ch) { return ch === '\n' || ch === '\r'; }
      function isHex(text) { return /^[0-9A-Fa-f]+$/.test(text); }
      
      function decodeCodePoint(hex, token) {
        const code = Number.parseInt(hex, 16);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
          throw new Error(`Invalid Unicode escape in ${token}`);
        }
        return String.fromCodePoint(code);
      }
      
      function decodeIriEscapes(value, token = 'IRI') {
        let out = '';
        for (let i = 0; i < value.length; i += 1) {
          const ch = value[i];
          if (ch !== '\\') {
            if (/[<>"{}|^`\u0000-\u0020]/.test(ch)) throw new Error(`Invalid character in ${token}`);
            out += ch;
            continue;
          }
          const esc = value[++i];
          if (esc === 'u') {
            const hex = value.slice(i + 1, i + 5);
            if (hex.length !== 4 || !isHex(hex)) throw new Error(`Invalid Unicode escape in ${token}`);
            out += decodeCodePoint(hex, token);
            i += 4;
          } else if (esc === 'U') {
            const hex = value.slice(i + 1, i + 9);
            if (hex.length !== 8 || !isHex(hex)) throw new Error(`Invalid Unicode escape in ${token}`);
            out += decodeCodePoint(hex, token);
            i += 8;
          } else {
            throw new Error(`Invalid IRI escape \\${esc} in ${token}`);
          }
        }
        return out;
      }
      
      function decodeLiteralEscapes(value, token = 'literal') {
        let out = '';
        for (let i = 0; i < value.length; i += 1) {
          const ch = value[i];
          if (ch !== '\\') {
            if (ch === '\n' || ch === '\r') throw new Error(`Raw line break in ${token}`);
            out += ch;
            continue;
          }
          const esc = value[++i];
          if (!esc) throw new Error(`Trailing escape in ${token}`);
          if (esc === 't') out += '\t';
          else if (esc === 'b') out += '\b';
          else if (esc === 'n') out += '\n';
          else if (esc === 'r') out += '\r';
          else if (esc === 'f') out += '\f';
          else if (esc === '"') out += '"';
          else if (esc === "'") out += "'";
          else if (esc === '\\') out += '\\';
          else if (esc === 'u') {
            const hex = value.slice(i + 1, i + 5);
            if (hex.length !== 4 || !isHex(hex)) throw new Error(`Invalid Unicode escape in ${token}`);
            out += decodeCodePoint(hex, token);
            i += 4;
          } else if (esc === 'U') {
            const hex = value.slice(i + 1, i + 9);
            if (hex.length !== 8 || !isHex(hex)) throw new Error(`Invalid Unicode escape in ${token}`);
            out += decodeCodePoint(hex, token);
            i += 8;
          } else {
            throw new Error(`Invalid escape \\${esc} in ${token}`);
          }
        }
        return out;
      }
      
      function stripNqComment(line) {
        let inString = false;
        let inIri = false;
        let escaped = false;
        for (let i = 0; i < line.length; i += 1) {
          const ch = line[i];
          if (escaped) { escaped = false; continue; }
          if (ch === '\\') { escaped = true; continue; }
          if (!inIri && ch === '"') { inString = !inString; continue; }
          if (!inString && ch === '<' && line[i + 1] !== '<') { inIri = true; continue; }
          if (!inString && inIri && ch === '>') { inIri = false; continue; }
          if (!inString && !inIri && ch === '#') return line.slice(0, i);
        }
        return line;
      }
      
      function validateAbsoluteIri(value, position) {
        if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) throw new Error(`${position} must be absolute`);
        return value;
      }
      
      function validateBlankLabel(value) {
        // RDF blank node labels follow PN_CHARS-style rules. This deliberately accepts
        // Unicode letters and leading underscores; it still rejects empty labels,
        // labels ending in '.', and doubled dots because those are common false
        // positives when a compact statement terminator is adjacent to a blank node.
        if (!value || value.endsWith('.') || value.includes('..')) throw new Error(`Invalid blank node label _: ${value}`);
        if (!/^[\p{L}\p{N}_](?:[\p{L}\p{N}._\-\u00B7\u0300-\u036F\u203F-\u2040]*[\p{L}\p{N}_\-\u00B7\u0300-\u036F\u203F-\u2040])?$/u.test(value)) {
          throw new Error(`Invalid blank node label _: ${value}`);
        }
        return value;
      }
      
      function validateLang(value) {
        // LANG_DIR uses BCP47-style language tags. Keep this intentionally strict enough
        // for the W3C syntax tests: each subtag is 1..8 alphanumeric chars, starting alpha.
        if (!value || value.includes('--') || !/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value)) throw new Error(`Invalid language tag @${value}`);
        return value;
      }
      
      class LineReader {
        constructor(line, lineNumber) {
          this.line = line;
          this.lineNumber = lineNumber;
          this.i = 0;
        }
      
        eof() { return this.i >= this.line.length; }
        peek(offset = 0) { return this.line[this.i + offset]; }
        startsWith(value) { return this.line.startsWith(value, this.i); }
        skipWs() { while (isWs(this.peek())) this.i += 1; }
      
        expect(value) {
          if (!this.startsWith(value)) throw new Error(`Expected ${value} on line ${this.lineNumber}, got ${this.line.slice(this.i, this.i + 20) || 'end of line'}`);
          this.i += value.length;
        }
      
        readIri(position = 'IRI') {
          this.expect('<');
          let raw = '';
          while (!this.eof()) {
            const ch = this.peek();
            if (ch === '>') { this.i += 1; return validateAbsoluteIri(decodeIriEscapes(raw, position), position); }
            raw += ch;
            this.i += 1;
          }
          throw new Error(`Unterminated ${position} on line ${this.lineNumber}`);
        }
      
        readBlank() {
          this.expect('_:');
          const start = this.i;
          while (!this.eof()) {
            const ch = this.peek();
            if (!/[\p{L}\p{N}._\-\u00B7\u0300-\u036F\u203F-\u2040]/u.test(ch)) break;
            if (ch === '.') {
              const next = this.peek(1);
              if (!next || isWs(next) || next === '<' || next === '_' || next === '"' || next === '#') break;
            }
            this.i += 1;
          }
          return blank(validateBlankLabel(this.line.slice(start, this.i)));
        }
      
        readLiteral() {
          this.expect('"');
          let raw = '';
          let escaped = false;
          while (!this.eof()) {
            const ch = this.peek();
            this.i += 1;
            if (escaped) { raw += `\\${ch}`; escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === '"') {
              const value = decodeLiteralEscapes(raw, 'literal');
              let language = null;
              let datatype = XSD_STRING;
              if (this.peek() === '@') {
                this.i += 1;
                const start = this.i;
                while (!this.eof() && /[A-Za-z0-9-]/.test(this.peek())) this.i += 1;
                let rawLang = this.line.slice(start, this.i);
                if (!rawLang) throw new Error('Invalid language tag: missing');
                if (rawLang.endsWith('--ltr') || rawLang.endsWith('--rtl')) rawLang = rawLang.slice(0, -5);
                language = validateLang(rawLang);
                datatype = null;
              } else if (this.startsWith('^^')) {
                this.i += 2;
                this.skipWs();
                datatype = this.readIri('datatype IRI');
                if (datatype === RDF_LANG_STRING || datatype === RDF_DIR_LANG_STRING) {
                  throw new Error(`Datatype ${datatype} requires LANG_DIR syntax, not ^^`);
                }
              }
              // RDF 1.2 base direction suffix, e.g. --ltr / --rtl. The core term model does not preserve it yet;
              // accepting it is enough for syntax tests and keeps eval comparison conservative for now.
              if (this.startsWith('--ltr') || this.startsWith('--rtl')) {
                if (!language) throw new Error('Base direction requires a language tag');
                this.i += 5;
              }
              return literal(value, datatype, language);
            }
            raw += ch;
          }
          throw new Error(`Unterminated literal on line ${this.lineNumber}`);
        }
      
        readTerm(position = 'term') {
          this.skipWs();
          if (this.startsWith('<<')) return this.readTripleTerm();
          if (this.peek() === '<') return iri(this.readIri(position));
          if (this.startsWith('_:')) return this.readBlank();
          if (this.peek() === '"') return this.readLiteral();
          throw new Error(`Expected RDF term for ${position}, got ${this.line.slice(this.i, this.i + 20) || 'end of line'}`);
        }
      
        readSubjectOrGraph(position) {
          const term = this.readTerm(position);
          if (term.kind === 'literal') throw new Error(`N-Quads ${position} cannot be a literal`);
          if (term.kind === 'triple' && (position === 'subject' || position === 'graph')) throw new Error(`N-Quads ${position} cannot be a triple term`);
          return term;
        }
      
        readPredicate() {
          this.skipWs();
          if (this.peek() !== '<') throw new Error(`N-Quads predicate must be an IRI, got ${this.line.slice(this.i, this.i + 20) || 'end of line'}`);
          return iri(this.readIri('predicate'));
        }
      
        readTripleTerm() {
          this.expect('<<');
          this.skipWs();
          // RDF 1.2 N-Triples/N-Quads triple terms use parenthesized triples: <<( s p o )>>.
          // The older unparenthesized RDF-star form is a reified-triple syntax form and is not
          // accepted as a plain subject/object term by the RDF 1.2 syntax manifests.
          this.expect('(');
          this.skipWs();
          const s = this.readSubjectOrGraph('triple-term subject');
          this.skipWs();
          const p = this.readPredicate();
          this.skipWs();
          const o = this.readTerm('triple-term object');
          this.skipWs();
          this.expect(')');
          this.skipWs();
          this.expect('>>');
          return tripleTerm(s, p, o);
        }
      }
      
      function parseLine(line, lineNumber, format) {
        const clean = stripNqComment(line).trim();
        if (!clean) return null;
        const r = new LineReader(clean, lineNumber);
        const s = r.readSubjectOrGraph('subject');
        r.skipWs();
        const p = r.readPredicate();
        r.skipWs();
        const o = r.readTerm('object');
        r.skipWs();
        let g = null;
        if (r.peek() !== '.') {
          if (format === 'ntriples') throw new Error(`N-Triples line ${lineNumber} has too many terms before .`);
          g = r.readSubjectOrGraph('graph');
          r.skipWs();
        }
        if (r.peek() !== '.') throw new Error(`N-Quads line ${lineNumber} must end with .`);
        r.i += 1;
        r.skipWs();
        if (!r.eof()) throw new Error(`Unexpected trailing content on N-Quads line ${lineNumber}: ${clean.slice(r.i)}`);
        return triple(s, p, o, g);
      }
      
      function parseNQuads(source, options = {}) {
        const facts = [];
        const prefixes = { ...(options.prefixes || {}) };
        const format = options.format || (options.profileId === 'ntriples-graph-v0' ? 'ntriples' : 'nquads');
        const lines = String(source || '').split(/\r\n|\n|\r/);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const fact = parseLine(lines[lineIndex], lineIndex + 1, format);
          if (fact) facts.push(fact);
        }
        return {
          profile: options.profileId || (format === 'ntriples' ? 'ntriples-graph-v0' : 'nquads-dataset-v0'),
          prefixes,
          base: options.base || '',
          imports: [],
          facts,
          rules: [],
          queries: [],
          expectations: [],
        };
      }
      
      function escapeIri(value) {
        return String(value).replace(/[\\>\u0000-\u0020]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
      }
      
      function escapeLiteral(value) {
        return String(value)
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t')
          .replace(/\u0008/g, '\\b')
          .replace(/\u000c/g, '\\f');
      }
      
      function termToNQuads(term) {
        if (!term) return '';
        switch (term.kind) {
          case 'iri':
            return `<${escapeIri(term.value)}>`;
          case 'blank':
            return `_:${term.value}`;
          case 'literal': {
            let out = `"${escapeLiteral(term.value)}"`;
            if (term.language) out += `@${term.language}`;
            else if (term.datatype && term.datatype !== XSD_STRING) out += `^^<${escapeIri(term.datatype)}>`;
            return out;
          }
          case 'triple':
            return `<< ${termToNQuads(term.s)} ${termToNQuads(term.p)} ${termToNQuads(term.o)} >>`;
          default:
            throw new Error(`Cannot serialize ${term.kind} as N-Quads`);
        }
      }
      
      function tripleToNQuads(value) {
        const terms = [termToNQuads(value.s), termToNQuads(value.p), termToNQuads(value.o)];
        if (value.graph) terms.push(termToNQuads(value.graph));
        return `${terms.join(' ')} .`;
      }
      
      function triplesToNQuads(triples) {
        return Array.from(new Set(Array.from(triples || []).map(tripleToNQuads))).sort().join('\n');
      }
      return { parseNQuads, termToNQuads, tripleToNQuads, triplesToNQuads };
      })();
      
      // ---- Turtle / TriG parser ----
      const { parseN3 } = (() => {
      
      const DEFAULT_PREFIXES = Object.freeze({
        rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
        xsd: 'http://www.w3.org/2001/XMLSchema#',
        log: 'http://www.w3.org/2000/10/swap/log#',
      });
      
      
      function isWs(ch) { return /\s/.test(ch || ''); }
      function isPunct(ch) { return '{}.;,()[]|'.includes(ch || ''); }
      function isHex(text) { return /^[0-9A-Fa-f]+$/.test(text); }
      function isAbsoluteIri(value) { return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value || ''); }
      function resolveIriReference(value, base) {
        if (isAbsoluteIri(value)) return value;
        if (!base) return value;
        try {
          const url = new URL(value, base);
          let href = url.href;
          // The RDF IRI-resolution tests expect bare authority references such as //g
          // to remain http://g, not to gain the URL API's cosmetic trailing slash.
          if (/^\/\/[^/?#]+$/.test(value) && href.endsWith('/')) href = href.slice(0, -1);
          if (/^file:\/\/[^/?#]+$/.test(value) && href.endsWith('/')) href = href.slice(0, -1);
          return href;
        } catch { return `${base}${value}`; }
      }
      function validateBlankLabel(value) {
        const clean = String(value || '').replace(/^_:/, '');
        if (!clean || clean.endsWith('.') || clean.includes('..')) throw new Error(`Invalid blank node label _: ${clean}`);
        // BLANK_NODE_LABEL follows the PN_CHARS family; ':' is only for prefixed names, not blank labels.
        if (/[\s<>"{}|^`\\:]/u.test(clean)) throw new Error(`Invalid blank node label _: ${clean}`);
        if (/^[\-.]/u.test(clean)) throw new Error(`Invalid blank node label _: ${clean}`);
        return clean;
      }
      function validateIriReference(value) {
        if (/[<>\"{}|^`\u0000-\u0020]/.test(value)) throw new Error('Invalid character in IRIREF');
        return value;
      }
      function validatePrefixedLocal(raw, decoded) {
        if (!raw) return decoded;
        if (raw.startsWith('-') || raw.startsWith('\\-') || raw.startsWith('.')) throw new Error(`Invalid prefixed name local ${raw}`);
        for (let i = 0; i < raw.length; i += 1) {
          const ch = raw[i];
          if (ch === '\\') {
            const esc = raw[i + 1];
            if (!esc || !'_~.-!$&\'()*+,;=/?#@%'.includes(esc)) throw new Error(`Invalid prefixed name local escape ${raw}`);
            i += 1;
            continue;
          }
          if (ch === '%') {
            const hex = raw.slice(i + 1, i + 3);
            if (hex.length !== 2 || !isHex(hex)) throw new Error(`Invalid percent escape in prefixed name local ${raw}`);
            i += 2;
            continue;
          }
          if (ch === '~' || ch === '^') throw new Error(`Invalid prefixed name local ${raw}`);
        }
        return decoded;
      }
      function decodePrefixedLocal(raw) {
        let out = '';
        for (let i = 0; i < raw.length; i += 1) {
          const ch = raw[i];
          if (ch === '\\') { out += raw[i + 1] || ''; i += 1; }
          else out += ch;
        }
        return out;
      }
      function codePoint(hex, label) {
        const n = Number.parseInt(hex, 16);
        if (!Number.isFinite(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new Error(`Invalid Unicode escape in ${label}`);
        return String.fromCodePoint(n);
      }
      function decodeEscapes(text, label, iriMode = false) {
        let out = '';
        for (let i = 0; i < text.length; i += 1) {
          const ch = text[i];
          if (ch !== '\\') { out += ch; continue; }
          const esc = text[++i];
          if (!esc) throw new Error(`Trailing escape in ${label}`);
          if (esc === 'u') {
            const hex = text.slice(i + 1, i + 5); if (hex.length !== 4 || !isHex(hex)) throw new Error(`Invalid Unicode escape in ${label}`);
            out += codePoint(hex, label); i += 4;
          } else if (esc === 'U') {
            const hex = text.slice(i + 1, i + 9); if (hex.length !== 8 || !isHex(hex)) throw new Error(`Invalid Unicode escape in ${label}`);
            out += codePoint(hex, label); i += 8;
          } else if (!iriMode && 'tbnrf"\''.includes(esc)) {
            out += { t: '\t', b: '\b', n: '\n', r: '\r', f: '\f', '"': '"', "'": "'" }[esc] ?? esc;
          } else if (!iriMode && esc === '\\') out += '\\';
          else if (iriMode) throw new Error(`Invalid escape \\${esc} in ${label}`);
          else throw new Error(`Invalid escape \\${esc} in ${label}`);
        }
        return out;
      }
      
      class Tokenizer {
        constructor(source) { this.source = String(source || ''); this.i = 0; this.tokens = []; }
        eof() { return this.i >= this.source.length; }
        peek(offset = 0) { return this.source[this.i + offset]; }
        startsWith(value) { return this.source.startsWith(value, this.i); }
        push(type, value, extra = {}) { this.tokens.push({ type, value, ...extra }); }
        skipComment() { while (!this.eof() && this.peek() !== '\n' && this.peek() !== '\r') this.i += 1; }
        readIri() {
          this.i += 1;
          let raw = '';
          while (!this.eof()) {
            const ch = this.peek();
            if (ch === '>') { this.i += 1; this.push('iri', validateIriReference(decodeEscapes(raw, 'IRI', true))); return; }
            raw += ch; this.i += 1;
          }
          throw new Error('Unterminated IRIREF');
        }
        readString() {
          const quote = this.peek();
          const long = this.source.startsWith(quote.repeat(3), this.i);
          this.i += long ? 3 : 1;
          let raw = '';
          let escaped = false;
          while (!this.eof()) {
            const ch = this.peek();
            if (!escaped && long && this.source.startsWith(quote.repeat(3), this.i)) { this.i += 3; this.push(long ? 'longString' : 'string', decodeEscapes(raw, 'string'), { long }); return; }
            if (!escaped && !long && ch === quote) { this.i += 1; this.push('string', decodeEscapes(raw, 'string'), { long: false }); return; }
            if (!long && (ch === '\n' || ch === '\r')) throw new Error('Raw line break in short string');
            raw += ch;
            this.i += 1;
            escaped = !escaped && ch === '\\';
            if (ch !== '\\') escaped = false;
          }
          throw new Error('Unterminated string');
        }
        readBare() {
          const start = this.i;
          if (this.startsWith('_:')) {
            this.i += 2;
            while (!this.eof()) {
              const ch = this.peek();
              // BLANK_NODE_LABEL uses PN_CHARS, including broad Unicode ranges that are
              // not all JavaScript \p{L}/\p{N}.  Tokenize generously up to a real
              // Turtle delimiter, then validate the label separately.  Keep ':' as a
              // boundary so compact forms such as _:s:p tokenize as blank-node _:s
              // followed by predicate :p.
              if (isWs(ch) || '<>\"{}|^`\\;,)[]'.includes(ch) || ch === ':' || ch === '#') break;
              if (ch === '.') {
                const next = this.source[this.i + 1];
                if (!next || isWs(next) || '{};,)[]'.includes(next)) break;
              }
              this.i += 1;
            }
            this.push('bare', this.source.slice(start, this.i));
            return;
          }
          while (!this.eof()) {
            const ch = this.peek();
            if (isWs(ch)) break;
            if (ch === '\\' && this.source[this.i + 1]) { this.i += 2; continue; }
            if (ch === '<' || ch === '>' || ch === '"' || ch === "'") break;
            if (ch === '.') {
              const next = this.source[this.i + 1];
              if (!next || isWs(next) || '{};,)[]'.includes(next)) break;
            } else if (isPunct(ch)) break;
            if (ch === '#') break;
            if (ch === '^' && this.peek(1) === '^') break;
            if (ch === '=' && this.peek(1) === '>') break;
            this.i += 1;
          }
          this.push('bare', this.source.slice(start, this.i));
        }
        tokenize() {
          while (!this.eof()) {
            const ch = this.peek();
            if (isWs(ch)) { this.i += 1; continue; }
            if (ch === '#') { this.skipComment(); continue; }
            if (this.startsWith('@prefix') && (isWs(this.source[this.i + 7]) || this.source[this.i + 7] === ':')) { this.push('bare', '@prefix'); this.i += 7; continue; }
            if (this.startsWith('@base') && isWs(this.source[this.i + 5])) { this.push('bare', '@base'); this.i += 5; continue; }
            if (this.startsWith('@version') && isWs(this.source[this.i + 8])) { this.push('bare', '@version'); this.i += 8; continue; }
            if (this.startsWith('=>')) { this.push('=>', '=>'); this.i += 2; continue; }
            if (this.startsWith('^^')) { this.push('^^', '^^'); this.i += 2; continue; }
            if (this.startsWith('<<')) { this.push('<<', '<<'); this.i += 2; continue; }
            if (this.startsWith('>>')) { this.push('>>', '>>'); this.i += 2; continue; }
            if (ch === '<') { this.readIri(); continue; }
            if (ch === '"' || ch === "'") { this.readString(); continue; }
            if (ch === '.' && /[0-9]/.test(this.peek(1) || '')) { this.readBare(); continue; }
            if (ch === '~') { this.readBare(); continue; }
            if (isPunct(ch)) { this.push(ch, ch); this.i += 1; continue; }
            this.readBare();
          }
          return this.tokens;
        }
      }
      
      function parseN3(source, options = {}) {
        const tokens = new Tokenizer(source).tokenize();
        let i = 0;
        let base = options.base || '';
        const prefixes = { ...DEFAULT_PREFIXES, ...(options.prefixes || {}) };
        const facts = [];
        const rules = [];
        let bnodeCounter = 0;
        const bnodes = new Map();
        const syntaxProfile = String(options.profile || options.profileId || '').toLowerCase();
        const rdf12Surface = syntaxProfile === 'turtle' || syntaxProfile === 'trig';
        const implicitStatementNodes = new Set();
      
        function freshBlank() { bnodeCounter += 1; return blank(`b${bnodeCounter}`); }
        function peek(offset = 0) { return tokens[i + offset]; }
        function next() { return tokens[i++]; }
        function eof() { return i >= tokens.length; }
        function accept(value) { if (peek()?.value === value || peek()?.type === value) { i += 1; return true; } return false; }
        function expect(value) { const t = next(); if (!t || (t.value !== value && t.type !== value)) throw new Error(`Expected ${value}, got ${t?.value || 'end of input'}`); return t; }
        function error(msg) { throw new Error(msg); }
      
        function parseIriValueFromBare(token) {
          if (token === 'a') return RDF_TYPE;
          if (token.startsWith('_:')) error(`Blank node label ${token} cannot be used as IRI`);
          const split = token.indexOf(':');
          if (split >= 0) {
            const prefix = token.slice(0, split);
            let local = token.slice(split + 1);
            if (!(prefix in prefixes)) throw new Error(`Unknown prefix ${prefix}:`);
            // Turtle permits reserved escaped characters in local names.
            local = validatePrefixedLocal(local, decodePrefixedLocal(local));
            return prefixes[prefix] + local;
          }
          throw new Error(`Expected IRI or prefixed name, got ${token}`);
        }
      
        function parseIriLike() {
          const t = next();
          if (!t) error('Unexpected end of input while reading IRI');
          if (t.type === 'iri') return resolveIriReference(t.value, base);
          if (t.type === 'bare') return parseIriValueFromBare(t.value);
          throw new Error(`Expected IRI or prefixed name, got ${t.value}`);
        }
      
        function parseBlankLabel(label) {
          const key = validateBlankLabel(label);
          if (!bnodes.has(key)) bnodes.set(key, blank(key));
          return bnodes.get(key);
        }
      
        function parseNumber(token) {
          if (/^[+-]?\d+$/.test(token)) return literal(token, XSD_INTEGER);
          if (/^[+-]?(?:\d+\.\d*|\.\d+)$/.test(token)) return literal(token, XSD_DECIMAL);
          if (/^[+-]?(?:(?:\d+\.\d*)|(?:\.\d+)|\d+)[eE][+-]?\d+$/.test(token)) return literal(token, XSD_DOUBLE);
          return null;
        }
      
        function parseTerm(out = facts, graph = null, options2 = {}) {
          const t = peek();
          if (!t) error('Unexpected end of input while reading Turtle term');
          if (t.type === '<<') return parseTripleTerm(out, graph, options2);
          if (t.type === 'iri') { next(); return iri(resolveIriReference(t.value, base)); }
          if (t.type === 'string' || t.type === 'longString') {
            if (options2.noLiteral) throw new Error('Literal is not allowed here');
            return parseLiteral();
          }
          if (t.type === '[') {
            // ANON is a BlankNode and is permitted in rtSubject/ttSubject, even where
            // blankNodePropertyList is not. Keep [ ... ] rejected in those positions.
            if (options2.noCompound) {
              if (peek(1)?.type === ']') { expect('['); expect(']'); return freshBlank(); }
              throw new Error('Compound blank node expression is not allowed here');
            }
            return parseBlankNodePropertyList(out, graph);
          }
          if (t.type === '(') {
            if (options2.noCompound) throw new Error('Collection is not allowed here');
            return parseCollection(out, graph);
          }
          if (t.type === 'bare') {
            next();
            if (t.value.startsWith('?')) {
              if (rdf12Surface) throw new Error(`Variables are not allowed in Turtle/TriG: ${t.value}`);
              return variable(t.value.slice(1));
            }
            if (t.value.startsWith('_:')) return parseBlankLabel(t.value);
            if (t.value === 'a' && options2.noA) throw new Error('a is only allowed as a predicate');
            if (t.value === 'true' || t.value === 'false') {
              if (options2.noLiteral) throw new Error('Literal is not allowed here');
              return literal(t.value, XSD_BOOLEAN);
            }
            const num = parseNumber(t.value);
            if (num) {
              if (options2.noLiteral) throw new Error('Literal is not allowed here');
              return num;
            }
            return iri(parseIriValueFromBare(t.value));
          }
          throw new Error(`Expected IRI or prefixed name, got ${t.value}`);
        }
      
        function parseLiteral() {
          const t = next(); if (!t || (t.type !== 'string' && t.type !== 'longString')) throw new Error(`Expected string, got ${t?.value || 'end of input'}`);
          if (peek()?.type === 'bare' && peek().value.startsWith('@')) {
            let lang = next().value.slice(1);
            let langDir = null;
            if (lang.endsWith('--ltr') || lang.endsWith('--rtl')) {
              langDir = lang.slice(-3);
              lang = lang.slice(0, -5);
            }
            if (!lang || lang.includes('--') || !/^[A-Za-z]+(?:-[A-Za-z0-9]+)*$/.test(lang)) throw new Error(`Invalid language tag @${lang}`);
            if (peek()?.type === 'bare' && ['--ltr', '--rtl'].includes(peek().value)) langDir = next().value.slice(2);
            return literal(t.value, null, lang, langDir);
          }
          if (accept('^^')) return literal(t.value, parseIriLike());
          if (peek()?.type === 'bare' && ['--ltr', '--rtl'].includes(peek().value)) throw new Error('Base direction requires a language tag');
          return literal(t.value, XSD_STRING);
        }
      
        function parseReifierToken(out, graph) {
          const t = peek();
          if (!t || t.type !== 'bare' || !t.value.startsWith('~')) return null;
          next();
          const suffix = t.value.slice(1);
          if (suffix) {
            if (suffix.startsWith('_:')) return parseBlankLabel(suffix);
            return iri(parseIriValueFromBare(suffix));
          }
          const n = peek();
          if (n && (n.type === 'iri' || (n.type === 'bare' && (n.value.startsWith('_:') || n.value.includes(':') || n.value === 'a')))) {
            const term = parseTerm(out, graph, { noLiteral: true, noCompound: true, noTripleTerm: true });
            if (term.kind !== 'iri' && term.kind !== 'blank') throw new Error('Reifier must be an IRI or blank node');
            return term;
          }
          return freshBlank();
        }
      
        function parseTripleTerm(out, graph, options2 = {}) {
          expect('<<');
          const parenthesized = accept('(');
          if (parenthesized) {
            if (options2.noTripleTerm) throw new Error('Triple term is not allowed here');
            const s = parseTerm(out, graph, { noLiteral: true, noCompound: true, noReifiedTriple: true });
            if (s.kind === 'triple') throw new Error('Triple term subject cannot be a triple term');
            const p = iri(parseIriLike());
            const o = parseTerm(out, graph, { noCompound: true, noReifiedTriple: true });
            if (o.kind !== 'iri' && o.kind !== 'blank' && o.kind !== 'literal' && o.kind !== 'triple') throw new Error('Invalid triple term object');
            expect(')');
            expect('>>');
            return tripleTerm(s, p, o);
          }
          if (options2.noReifiedTriple) throw new Error('Reified triple is not allowed here');
          const s = parseTerm(out, graph, { noLiteral: true, noCompound: true, noTripleTerm: true });
          if (s.kind !== 'iri' && s.kind !== 'blank') throw new Error('Invalid reified triple subject');
          const p = iri(parseIriLike());
          const o = parseTerm(out, graph, { noCompound: true });
          if (o.kind !== 'iri' && o.kind !== 'blank' && o.kind !== 'literal' && o.kind !== 'triple') throw new Error('Invalid reified triple object');
          let reifier = null;
          if (peek()?.type === 'bare' && peek().value.startsWith('~')) reifier = parseReifierToken(out, graph);
          expect('>>');
          const node = reifier || freshBlank();
          out.push(triple(node, iri(RDF_REIFIES), tripleTerm(s, p, o), graph));
          if (node.kind === 'blank') implicitStatementNodes.add(node.value);
          return node;
        }
      
        function parseCollection(out, graph) {
          expect('(');
          if (accept(')')) return iri(RDF_NIL);
          const head = freshBlank();
          let current = head;
          while (true) {
            const item = parseTerm(out, graph);
            out.push(triple(current, iri(RDF_FIRST), item, graph));
            if (accept(')')) {
              out.push(triple(current, iri(RDF_REST), iri(RDF_NIL), graph));
              break;
            }
            const rest = freshBlank();
            out.push(triple(current, iri(RDF_REST), rest, graph));
            current = rest;
          }
          return head;
        }
      
        function parseBlankNodePropertyList(out, graph) {
          expect('[');
          const node = freshBlank();
          if (accept(']')) return node;
          parsePredicateObjectList(node, out, graph);
          expect(']');
          if (node.kind === 'blank') implicitStatementNodes.add(node.value);
          return node;
        }
      
        function parseAnnotationBlock(reifier, out, graph = null) {
          expect('{');
          expect('|');
          if (peek()?.type === '|') {
            // Empty annotation blocks are rejected by the RDF 1.2 syntax tests.
            throw new Error('Empty annotation block');
          }
          parsePredicateObjectList(reifier, out, graph);
          expect('|');
          expect('}');
        }
      
        function ensureReifierForTriple(assertedTriple, out, graph = null) {
          const reifier = freshBlank();
          out.push(triple(reifier, iri(RDF_REIFIES), tripleTerm(assertedTriple.s, assertedTriple.p, assertedTriple.o), graph));
          return reifier;
        }
      
        function parseObjectList(subject, predicate, out, graph = null) {
          while (true) {
            const object = parseTerm(out, graph, { noA: true });
            const asserted = triple(subject, predicate, object, graph);
            out.push(asserted);
            let pendingReifier = null;
            while (true) {
              if (peek()?.type === 'bare' && peek().value.startsWith('~')) {
                pendingReifier = parseReifierToken(out, graph);
                out.push(triple(pendingReifier, iri(RDF_REIFIES), tripleTerm(asserted.s, asserted.p, asserted.o), graph));
                continue;
              }
              if (peek()?.type === '{' && peek(1)?.type === '|') {
                const blockReifier = pendingReifier || ensureReifierForTriple(asserted, out, graph);
                parseAnnotationBlock(blockReifier, out, graph);
                pendingReifier = null;
                continue;
              }
              break;
            }
            if (!accept(',')) break;
          }
        }
      
        function parsePredicateObjectList(subject, out, graph = null) {
          while (true) {
            const predicate = iri(parseIriLike());
            parseObjectList(subject, predicate, out, graph);
            if (!accept(';')) break;
            while (accept(';')) {}
            if ([']', '.', '}', '|'].includes(peek()?.type)) break;
          }
        }
      
        function parseGraphLabel(out, inheritedGraph = null) {
          if (peek()?.type === '[' && peek(1)?.type === ']') { expect('['); expect(']'); return freshBlank(); }
          if (peek()?.type === '(') throw new Error('GRAPH name must be an IRI or blank node');
          const graph = parseTerm(out, inheritedGraph, { noLiteral: true, noCompound: true, noTripleTerm: true, noReifiedTriple: true, noA: true });
          if (graph.kind !== 'iri' && graph.kind !== 'blank') throw new Error('GRAPH name must be an IRI or blank node');
          return graph;
        }
      
        function parseGraphBlock(out, inheritedGraph = null) {
          expect('GRAPH');
          const graph = parseGraphLabel(out, inheritedGraph);
          parseFormula(graph, out);
        }
      
        function parseTripleStatement(out, graph = null, options3 = {}) {
          if (String(peek()?.value || '').toUpperCase() === 'GRAPH') {
            if (syntaxProfile === 'turtle') throw new Error('GRAPH blocks are not Turtle');
            if (graph) throw new Error('GRAPH blocks cannot be nested inside a graph block');
            parseGraphBlock(out, graph);
            if (options3.requireDot) expect('.'); else accept('.');
            return;
          }
          if (peek()?.type === '<<' && peek(1)?.type === '(') throw new Error('Triple term cannot be used as a subject');
          const subject = parseTerm(out, graph, { noLiteral: true, noA: true });
          if ((peek()?.type === '.' || peek()?.type === '}' || peek()?.type === undefined) && subject.kind === 'blank' && implicitStatementNodes.has(subject.value)) {
            if (options3.requireDot) expect('.'); else accept('.');
            return;
          }
          parsePredicateObjectList(subject, out, graph);
          if (options3.requireDot) expect('.'); else accept('.');
        }
      
        function parseFormula(graph = null, target = null) {
          expect('{');
          const triples = target || [];
          while (peek()?.type !== '}') parseTripleStatement(triples, graph);
          expect('}');
          return triples;
        }
      
        function parseBase() {
          const directive = next();
          const iriToken = next();
          if (iriToken?.type !== 'iri') throw new Error(`Expected base IRI, got ${iriToken?.value}`);
          base = resolveIriReference(iriToken.value, base);
          if (String(directive.value || '').startsWith('@')) expect('.');
        }
      
        function parsePrefix() {
          const directive = next();
          const label = next();
          if (label?.type !== 'bare' || !label.value.endsWith(':')) throw new Error(`Expected prefix label ending with :, got ${label?.value}`);
          const prefixLabel = label.value.slice(0, -1);
          if (prefixLabel.endsWith('.') || prefixLabel.includes('..')) throw new Error(`Invalid prefix label ${prefixLabel}`);
          const iriToken = next();
          if (iriToken?.type !== 'iri') throw new Error(`Expected prefix IRI, got ${iriToken?.value}`);
          prefixes[prefixLabel] = resolveIriReference(iriToken.value, base);
          if (String(directive.value || '').startsWith('@')) expect('.');
        }
      
        function isSimpleGraphLabelStart(t) {
          return t && (t.type === 'iri' || (t.type === 'bare' && (t.value.startsWith('_:') || t.value.includes(':'))));
        }
      
        while (!eof()) {
          const token = peek();
          const lowerValue = String(token.value || '').toLowerCase();
          if (token.value === '@base' || (!String(token.value || '').startsWith('@') && lowerValue === 'base')) parseBase();
          else if (token.value === '@prefix' || (!String(token.value || '').startsWith('@') && lowerValue === 'prefix')) parsePrefix();
          else if ((!String(token.value || '').startsWith('@') && String(token.value || '').toUpperCase() === 'VERSION') || token.value === '@version') {
            const directive = next();
            const v = next();
            if (!v || v.type !== 'string') throw new Error('VERSION requires a short quoted string');
            if (String(directive.value || '').startsWith('@')) expect('.');
          }
          else if (token.type === '{') {
            if (syntaxProfile === 'turtle') throw new Error('Turtle does not allow top-level graph/formula blocks');
            const body = parseFormula();
            if (accept('=>')) {
              const head = parseFormula();
              accept('.');
              rules.push(new Rule({ id: `n3${rules.length + 1}`, body, head, profile: 'n3-rules-subset-v0' }));
            } else {
              facts.push(...body);
              accept('.');
            }
          } else if (String(token.value || '').toUpperCase() === 'GRAPH') {
            parseGraphBlock(facts);
            if (accept('.')) throw new Error('GRAPH block must not be followed by .');
          } else if (token.type === '[' && peek(1)?.type === ']' && peek(2)?.type === '{') {
            if (syntaxProfile === 'turtle') throw new Error('Turtle does not allow graph labels');
            const graph = parseGraphLabel(facts, null);
            parseFormula(graph, facts);
            accept('.');
          } else if (isSimpleGraphLabelStart(token) && peek(1)?.type === '{') {
            if (syntaxProfile === 'turtle') throw new Error('Turtle does not allow graph labels');
            const graph = parseGraphLabel(facts, null);
            parseFormula(graph, facts);
            accept('.');
          } else {
            parseTripleStatement(facts, null, { requireDot: syntaxProfile === 'turtle' });
          }
        }
      
        return { profile: 'n3-rules-subset-v0', prefixes, base, facts, rules };
      }
      return { parseN3 };
      })();
      
      
      return {
        parseNQuads,
        termToNQuads,
        tripleToNQuads,
        triplesToNQuads,
        parseN3,
      };
      })();
      
      Object.assign(module.exports, rdfW3cSyntax);
      
    },
    "src/assignments.js": function (require, module, exports) {
      'use strict';
      
      // Most SET expressions are deterministic and can safely participate in the
      // ordinary fixpoint loop.  Only genuinely fresh generators need run-once
      // evaluation, otherwise a recursive rule such as SET(?x := UUID()) would keep
      // creating new terms forever.
      function assignmentsNeedRunOnce(clauses = [], options = {}) {
        if (options.shacl12Conformance) {
          return clauses.some((clause) => clause.type === 'set' || clause.type === 'bind');
        }
        const hasSet = clauses.some((clause) => clause.type === 'set');
        const hasNegation = clauses.some((clause) => clause.type === 'not');
        return (hasSet && hasNegation)
          || clauses.some((clause) => (clause.type === 'set' || clause.type === 'bind') && expressionIsVolatile(clause.expr));
      }
      
      function ruleNeedsRunOnce(head = [], body = [], options = {}) {
        return assignmentsNeedRunOnce(body, options) || head.some(tripleHasBlankNode);
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
      
      function expressionIsVolatile(expr) {
        if (!expr) return false;
        switch (expr.type) {
          case 'call': {
            const name = localName(expr.name).toLowerCase();
            if (name === 'uuid' || name === 'struuid') return true;
            if (name === 'bnode' && (!expr.args || expr.args.length === 0)) return true;
            return (expr.args || []).some(expressionIsVolatile);
          }
          case 'binary':
            return expressionIsVolatile(expr.left) || expressionIsVolatile(expr.right);
          case 'unary':
            return expressionIsVolatile(expr.expr);
          case 'list':
            return (expr.items || []).some(expressionIsVolatile);
          default:
            return false;
        }
      }
      
      function localName(name) {
        const text = String(name || '');
        const hash = text.lastIndexOf('#');
        const slash = text.lastIndexOf('/');
        const colon = text.lastIndexOf(':');
        const index = Math.max(hash, slash, colon);
        return index >= 0 ? text.slice(index + 1) : text;
      }
      
      module.exports = { assignmentsNeedRunOnce, ruleNeedsRunOnce, expressionIsVolatile, tripleHasBlankNode, termHasBlankNode };
      
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
        RDF_NS,
        XSD_INTEGER,
        XSD_DECIMAL,
        XSD_DOUBLE,
      } = require('./term.js');
      
      const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
      const XSD_DAYTIME_DURATION = 'http://www.w3.org/2001/XMLSchema#dayTimeDuration';
      const RDF_LANGSTRING = `${RDF_NS}langString`;
      const RDF_DIRLANGSTRING = `${RDF_NS}dirLangString`;
      const NUMERIC_DATATYPES = new Set([XSD_INTEGER, XSD_DECIMAL, XSD_DOUBLE]);
      const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
      const MIN_SAFE_INTEGER_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
      
      // This table is intentionally shaped by the SHACL 1.2 Rules grammar production BuiltInCall.
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
        return callBuiltin(expr.name, expr.args.map((arg) => evalExpression(arg, binding, options)), binding, options);
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
        if (op === '/') return Number(lp) / Number(rp);
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
    "src/rdfMessages.js": function (require, module, exports) {
      'use strict';
      
      const { parseRdfDocument } = require('./rdfSyntax.js');
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
      
      function parseRdfMessageLog(source, options = {}) {
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
          const parsed = hasBody ? parseRdfDocument(bodySource, { ...options, filename: `${options.filename || '<message>'}#m${i + 1}`, baseIRI: options.baseIRI }) : { triples: [], prefixes: {} };
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
          data,
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
      
      const { TripleStore, bindingKey, instantiateTriple } = require('./store.js');
      const { tripleKey, termEquals } = require('./term.js');
      const { evalExpression, booleanValue, asTerm } = require('./builtins.js');
      const { analyze } = require('./analyze.js');
      
      function evaluate(program, options = {}) {
        const maxIterations = options.maxIterations ?? 10000;
        const evalOptions = { ...options, baseIRI: options.baseIRI || program.baseIRI || null, now: options.now || new Date(), __bnodeLabels: options.__bnodeLabels || new Map() };
        const store = new TripleStore(program.data);
        const inputKeys = new Set(program.data.map(tripleKey));
        const inferred = [];
        const trace = [];
        let iterations = 0;
        let ruleApplications = 0;
        const perRule = program.rules.map((rule, index) => ({
          name: rule.name || `rule#${index + 1}`,
          applications: 0,
          added: 0,
          runOnce: !!rule.runOnce,
        }));
      
        const analysis = options.analysis || analyze(program);
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
        };
      
        for (let layerIndex = 0; layerIndex < layerIndexes.length; layerIndex += 1) {
          const layer = layerIndexes[layerIndex];
          const ordinary = layer.filter((ruleIndex) => !program.rules[ruleIndex].runOnce);
          const runOnce = layer.filter((ruleIndex) => program.rules[ruleIndex].runOnce);
      
          if (runOnce.length > 0) {
            iterations += 1;
            for (const ruleIndex of runOnce) {
              baseContext.layer = layerIndex + 1;
              baseContext.iteration = iterations;
              const added = applyRuleOnce(program, store, ruleIndex, baseContext);
              ruleApplications += added.applications;
            }
          }
      
          baseContext.layer = layerIndex + 1;
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
          input: program.data.slice(),
          inferred,
          closure: store.values(),
          iterations,
          layers: layerIndexes.map((layer) => layer.map((ruleIndex) => perRule[ruleIndex].name)),
          ruleApplications,
          perRule,
          trace,
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
      
        const bodyBindings = rule.body.length === 1 && rule.body[0].type === 'triple'
          ? store.match(rule.body[0].triple, {})
          : evaluateBodyStream(rule.body, store, {}, context);
      
        for (const binding of bodyBindings) {
          if (seenBindings) {
            const key = bindingKey(binding);
            if (seenBindings.has(key)) continue;
            seenBindings.add(key);
          }
          applications += 1;
          context.perRule[ruleIndex].applications += 1;
      
          for (const head of rule.head) {
            const triple = instantiateTriple(head, binding);
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
                });
              }
            }
          }
        }
      
        return { applications, added };
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
        if (index >= clauses.length) {
          yield initialBinding;
          return;
        }
      
        const clause = clauses[index];
        if (clause.type === 'triple') {
          for (const matched of store.match(clause.triple, initialBinding)) {
            yield* evaluateBodyStream(clauses, store, matched, options, index + 1);
          }
          return;
        }
      
        if (clause.type === 'path') {
          for (const matched of store.matchPath(clause.triple, initialBinding)) {
            yield* evaluateBodyStream(clauses, store, matched, options, index + 1);
          }
          return;
        }
      
        if (clause.type === 'filter') {
          try {
            if (booleanValue(evalExpression(clause.expr, initialBinding, options))) {
              yield* evaluateBodyStream(clauses, store, initialBinding, options, index + 1);
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
              yield* evaluateBodyStream(clauses, store, { ...initialBinding, [clause.variable]: value }, options, index + 1);
            } else if (termEquals(initialBinding[clause.variable], value)) {
              yield* evaluateBodyStream(clauses, store, initialBinding, options, index + 1);
            }
          } catch (_) {
            // The SRL evaluation sketch drops a solution when assignment evaluation errors.
          }
          return;
        }
      
        if (clause.type === 'not') {
          if (!bodyHasAny(clause.body, store, initialBinding, options)) {
            yield* evaluateBodyStream(clauses, store, initialBinding, options, index + 1);
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
      
      module.exports = { evaluate, evaluateBody, uniqueBindings };
      
    },
    "src/store.js": function (require, module, exports) {
      'use strict';
      
      const { tripleKey, termKey, termEquals } = require('./term.js');
      
      class TripleStore {
        constructor(triples = []) {
          this.map = new Map();
          this.byPredicate = new Map();
          this.byPredicateSubject = new Map();
          this.byPredicateObject = new Map();
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
        const hasRunOnceRules = program.rules.some((rule) => rule.runOnce);
        const recursiveIndexes = hasRunOnceRules ? recursiveRuleIndexes(dependency) : new Set();
      
        program.rules.forEach((rule, index) => {
          const name = ruleName(rule, index);
          const bound = boundVariables(rule.body);
          const head = new Set();
          for (const triple of rule.head) collectTripleVars(triple, head);
      
          for (const variable of head) {
            if (!bound.has(variable)) {
              diagnostics.push({
                code: 'unsafe-head-variable',
                severity: 'error',
                rule: name,
                message: `${displayRuleName(name, program.prefixes || {})} has unbound head variable ?${variable}`,
              });
            }
          }
      
          for (const triple of rule.head) {
            if (triple.p.type !== 'iri' && triple.p.type !== 'var') {
              diagnostics.push({
                code: 'invalid-head-predicate',
                severity: 'error',
                rule: name,
                message: `${displayRuleName(name, program.prefixes || {})} has a non-IRI/non-variable predicate in the head`,
              });
            }
          }
      
          diagnostics.push(...sequentialWellFormednessDiagnostics(rule.body, name, program.prefixes || {}));
      
          if (rule.runOnce && recursiveIndexes.has(index)) {
            diagnostics.push({
              code: 'recursive-assignment-rule',
              severity: 'warning',
              rule: name,
              message: `${displayRuleName(name, program.prefixes || {})} is a run-once rule in a recursive dependency cycle`,
            });
          }
      
        });
      
        for (const cycle of dependency.unstratifiedCycles) {
          diagnostics.push({
            code: 'unstratified-negation',
            severity: 'error',
            rules: cycle.rules,
            message: `Unstratified negation through ${cycle.rules.map((name) => displayRuleName(name, program.prefixes || {})).join(' -> ')} using ${cycle.predicate ? compactIRI(cycle.predicate, program.prefixes || {}) : '*'}`,
          });
        }
      
        return {
          warnings: diagnostics.filter((diagnostic) => diagnostic.severity === 'warning'),
          errors: diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
          diagnostics,
          dependency,
        };
      }
      
      function ruleName(rule, index) {
        return rule.name || `rule#${index + 1}`;
      }
      
      function displayRuleName(name, prefixes = {}) {
        return /^https?:/.test(name) ? compactIRI(name, prefixes) : name;
      }
      
      function dependencyGraph(program, options = {}) {
        const rules = program.rules.map((rule, index) => {
          const positivePatterns = bodyTriplePatterns(rule.body, false);
          const negativePatterns = bodyTriplePatterns(rule.body, true);
          const headTemplates = effectiveHeadTemplates(rule);
          return {
            index,
            name: ruleName(rule, index),
            headTemplates,
            positivePatterns,
            negativePatterns,
            headPredicates: new Set(headTemplates.map((triple) => predicateIRI(triple)).filter(Boolean)),
            positivePredicates: new Set(positivePatterns.flatMap((triple) => predicateIRIs(triple))),
            negativePredicates: new Set(negativePatterns.flatMap((triple) => predicateIRIs(triple))),
            runOnce: !!rule.runOnce,
            hasAssignment: ruleHasAssignment(rule, options),
            headHasBlankNode: ruleHeadHasBlankNode(rule),
          };
        });
      
        const edgeMap = new Map();
        function addEdge(from, to, negative, predicate) {
          const label = predicate || '*';
          const key = `${from.index}->${to.index}:${label}`;
          const existing = edgeMap.get(key);
          if (existing) {
            existing.negative = existing.negative || negative;
            return;
          }
          edgeMap.set(key, { from: from.index, to: to.index, negative, predicate });
        }
      
        const headIndex = buildHeadTemplateIndex(rules);
      
        for (const from of rules) {
          const forceClosed = from.hasAssignment || from.headHasBlankNode;
          for (const pattern of from.positivePatterns) {
            for (const candidate of candidateHeadTemplates(headIndex, pattern)) {
              if (canPossiblyGenerate(candidate.template, pattern)) addEdge(from, rules[candidate.ruleIndex], forceClosed, dependencyPredicateLabel(pattern));
            }
          }
          for (const pattern of from.negativePatterns) {
            for (const candidate of candidateHeadTemplates(headIndex, pattern)) {
              if (canPossiblyGenerate(candidate.template, pattern)) addEdge(from, rules[candidate.ruleIndex], true, dependencyPredicateLabel(pattern));
            }
          }
        }
      
        const edges = Array.from(edgeMap.values()).sort((a, b) => a.from - b.from || a.to - b.to || String(a.predicate || '').localeCompare(String(b.predicate || '')));
      
        const components = stronglyConnectedComponents(rules.length, edges);
        const componentOf = new Map();
        components.forEach((component, index) => {
          for (const ruleIndex of component) componentOf.set(ruleIndex, index);
        });
      
        const unstratifiedCycles = [];
        const seen = new Set();
        for (const edge of edges) {
          if (!edge.negative) continue;
          if (edge.from === edge.to && rules[edge.from].runOnce && !rules[edge.from].headHasBlankNode) continue;
          if (componentOf.get(edge.from) !== componentOf.get(edge.to)) continue;
          const component = components[componentOf.get(edge.from)];
          const key = `${component.slice().sort((a, b) => a - b).join(',')}|${edge.predicate || '*'}`;
          if (seen.has(key)) continue;
          seen.add(key);
          unstratifiedCycles.push({
            predicate: edge.predicate,
            rules: component.map((ruleIndex) => rules[ruleIndex].name),
          });
        }
      
        const layers = stratificationLayers(rules.length, components, componentOf, edges);
      
        return {
          rules: rules.map((rule) => ({
            index: rule.index,
            name: rule.name,
            headPredicates: Array.from(rule.headPredicates),
            positivePredicates: Array.from(rule.positivePredicates),
            negativePredicates: Array.from(rule.negativePredicates),
            runOnce: rule.runOnce,
            headHasBlankNode: rule.headHasBlankNode,
          })),
          edges,
          components: components.map((component) => component.map((ruleIndex) => rules[ruleIndex].name)),
          layers: layers.map((layer) => layer.map((ruleIndex) => rules[ruleIndex].name)),
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
        const outgoing = Array.from({ length: components.length }, () => new Set());
        const indegree = Array(components.length).fill(0);
      
        for (const edge of edges) {
          const dependent = componentOf.get(edge.from);
          const dependency = componentOf.get(edge.to);
          if (dependent === dependency) continue;
          // Rule edge means "from depends on to". Evaluation must run dependency before dependent.
          if (!outgoing[dependency].has(dependent)) {
            outgoing[dependency].add(dependent);
            indegree[dependent] += 1;
          }
        }
      
        let ready = [];
        for (let i = 0; i < indegree.length; i += 1) if (indegree[i] === 0) ready.push(i);
        const layers = [];
        const emitted = new Set();
        while (ready.length > 0) {
          ready.sort((a, b) => componentMin(components[a]) - componentMin(components[b]));
          const layerComponents = ready;
          ready = [];
          const layer = [];
          for (const componentIndex of layerComponents) {
            emitted.add(componentIndex);
            layer.push(...components[componentIndex]);
            for (const next of outgoing[componentIndex]) {
              indegree[next] -= 1;
              if (indegree[next] === 0) ready.push(next);
            }
          }
          layers.push(layer.sort((a, b) => a - b));
        }
      
        if (emitted.size !== components.length) return [Array.from({ length: ruleCount }, (_, i) => i)];
        return layers;
      }
      
      
      function componentMin(component) {
        let min = Infinity;
        for (const value of component) if (value < min) min = value;
        return min;
      }
      
      function recursiveRuleIndexes(dependency) {
        const out = new Set();
        const ruleByName = new Map(dependency.rules.map((rule) => [rule.name, rule]));
        const ruleByIndex = new Map(dependency.rules.map((rule) => [rule.index, rule]));
      
        for (const component of dependency.components) {
          if (component.length <= 1) continue;
          for (const name of component) {
            const rule = ruleByName.get(name);
            if (rule) out.add(rule.index);
          }
        }
      
        for (const edge of dependency.edges) {
          const rule = ruleByIndex.get(edge.from);
          if (edge.from === edge.to && edge.negative && rule && rule.runOnce && !rule.headHasBlankNode) continue;
          out.add(edge.from);
        }
        return out;
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
      
      function sequentialWellFormednessDiagnostics(clauses, ruleNameValue, prefixes = {}) {
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
      
        visit(clauses, new Set(), '');
        return diagnostics;
      }
      
      function bodyTriplePatterns(clauses, wantNegative, inNegativeContext = false) {
        const out = [];
        for (const clause of clauses) {
          if ((clause.type === 'triple' || clause.type === 'path') && wantNegative === inNegativeContext) {
            if (clause.type === 'path') out.push(...pathTriplePatterns(clause.triple));
            else out.push(clause.triple);
          } else if (clause.type === 'not') {
            out.push(...bodyTriplePatterns(clause.body, wantNegative, true));
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
        return !!options.shacl12Conformance && (rule.body || []).some((clause) => clause.type === 'set' || clause.type === 'bind');
      }
      
      function ruleHeadHasBlankNode(rule) {
        return (rule.head || []).some(tripleHasBlankNode);
      }
      
      function boundVariables(clauses) {
        const vars = new Set();
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
          trace: options.trace ? result.trace : undefined,
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
      
      module.exports = { sortTriples, formatTriples, formatTrace, formatBindings, formatBinding, toJSON };
      
    },
    "src/query.js": function (require, module, exports) {
      'use strict';
      
      const { parseQuery } = require('./parser.js');
      const { TripleStore, bindingKey } = require('./store.js');
      const { evaluateBody } = require('./engine.js');
      
      function queryResult(result, querySpec, options = {}) {
        const store = new TripleStore(result.closure || []);
        const bindings = evaluateBody(querySpec.body, store, {}, options);
        const select = normalizeSelect(querySpec.select, bindings);
        return {
          baseIRI: result.baseIRI,
          prefixes: result.prefixes,
          select,
          bindings: projectBindings(bindings, select),
        };
      }
      
      function runQuery(source, querySource = null, options = {}) {
        const { run, compile } = require('./api.js');
        const { program, diagnostics } = compile(source, options);
        const result = run(program, options);
        result.diagnostics = diagnostics;
      
        let querySpec;
        if (querySource) querySpec = parseQuery(querySource, { ...options, prefixes: program.prefixes, baseIRI: program.baseIRI });
        else throw new Error('No query supplied. Use --query or --query-file with a raw body pattern.');
      
        const query = queryResult(result, querySpec, options);
        return { ...result, query };
      }
      
      function normalizeSelect(select, bindings) {
        if (select && select.length > 0) return select.slice();
        const vars = new Set();
        for (const binding of bindings) for (const key of Object.keys(binding)) vars.add(key);
        return Array.from(vars).sort();
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
      
      module.exports = { runQuery, queryResult, parseQuery, normalizeSelect, projectBindings };
      
    },
    "src/output.js": function (require, module, exports) {
      'use strict';
      
      function resultTriples(result, program = {}, options = {}) {
        return options.all ? result.closure : result.inferred;
      }
      
      module.exports = { resultTriples };
      
    },
  };
  const __mappings = {"src/tokenizer.js":{},"src/assignments.js":{},"src/term.js":{},"src/rdfSyntax.js":{"./tokenizer.js":"src/tokenizer.js","./assignments.js":"src/assignments.js","./term.js":"src/term.js"},"src/builtins.js":{"./term.js":"src/term.js"},"src/parser.js":{"./tokenizer.js":"src/tokenizer.js","./rdfSyntax.js":"src/rdfSyntax.js","./builtins.js":"src/builtins.js","./assignments.js":"src/assignments.js","./term.js":"src/term.js"},"src/rdfMessages.js":{"./rdfSyntax.js":"src/rdfSyntax.js","./term.js":"src/term.js"},"src/store.js":{"./term.js":"src/term.js"},"src/analyze.js":{"./term.js":"src/term.js","./assignments.js":"src/assignments.js"},"src/engine.js":{"./store.js":"src/store.js","./term.js":"src/term.js","./builtins.js":"src/builtins.js","./analyze.js":"src/analyze.js"},"src/format.js":{"./term.js":"src/term.js"},"src/query.js":{"./parser.js":"src/parser.js","./store.js":"src/store.js","./engine.js":"src/engine.js","./api.js":"src/api.js"},"src/output.js":{},"src/api.js":{"./parser.js":"src/parser.js","./rdfSyntax.js":"src/rdfSyntax.js","./rdfMessages.js":"src/rdfMessages.js","./engine.js":"src/engine.js","./analyze.js":"src/analyze.js","./format.js":"src/format.js","./query.js":"src/query.js","./output.js":"src/output.js"},"src/cli.js":{"./api.js":"src/api.js","./term.js":"src/term.js"}};
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
  process.exitCode = __require("src/cli.js").main(process.argv.slice(2));
}());
