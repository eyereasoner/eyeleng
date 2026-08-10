'use strict';

const { parse, parseQuery } = require('./parser.js');
const { parseRdfSyntax, parseRdfDocument, rdfDocumentToProgram, looksLikeRdfRules } = require('./rdfSyntax.js');
const { parseRdfMessageLog, looksLikeRdfMessageLog } = require('./rdfMessages.js');
const { evaluate, evaluateAsync } = require('./engine.js');
const { analyze } = require('./analyze.js');
const { formatTriples, sortTriples, toJSON, formatTrace, formatProof, formatBindings } = require('./format.js');
const { runQuery, runQueryAsync, queryResult, queryProgram, queryRunOptions, shouldUseHybridForQuery } = require('./query.js');
const { resultTriples } = require('./output.js');

function parseInput(source, options = {}) {
  if (typeof source !== 'string') return source;
  if (looksLikeRdfMessageLog(source, options) || looksLikeRdfRules(source, options)) {
    throw new Error('RDF input parsing is asynchronous with rdf-parse; use parseInputAsync(), compileAsync(), runAsync(), or the CLI');
  }
  return parse(source, options);
}

async function parseInputAsync(source, options = {}) {
  if (typeof source !== 'string') return source;
  if (looksLikeRdfMessageLog(source, options)) return await parseRdfMessageLog(source, options);
  return looksLikeRdfRules(source, options) ? await parseRdfSyntax(source, options) : parse(source, options);
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

async function compileAsync(source, options = {}) {
  const asyncOptions = await withShapeEngine(options);
  const parsed = await parseInputAsync(source, asyncOptions);
  const program = asyncOptions.resolveImports === false ? parsed : await resolveImportsAsync(parsed, asyncOptions);
  const analysis = analyze(program, asyncOptions);
  const diagnostics = analysis.diagnostics;
  const fatal = analysis.errors.length > 0 || (asyncOptions.strict && analysis.warnings.length > 0);
  if (fatal && asyncOptions.throwOnDiagnostics !== false) {
    const details = diagnostics.map((diagnostic) => diagnostic.message).join('; ');
    throw new Error(`${analysis.errors.length > 0 ? 'Analysis failed' : 'Strict mode failed'}: ${details}`);
  }
  return { program, diagnostics, analysis, shapeEngine: asyncOptions.shapeEngine || null, options: asyncOptions };
}

async function withShapeEngine(options = {}) {
  if (!options.shapes || options.shapeEngine) return options;
  const { createShaclShapeEngine } = require('./shacl.js');
  const shapeEngine = await createShaclShapeEngine(options.shapes, options);
  return { ...options, shapeEngine };
}

async function resolveImportsAsync(program, options = {}, seen = new Set()) {
  if (!program.imports || program.imports.length === 0) return cloneProgram(program);
  const importResolver = options.importResolver;
  if (!importResolver) return cloneProgram(program);

  let merged = emptyProgram(program);
  const localKey = program.baseIRI || options.filename || '<input>';
  if (localKey) seen.add(localKey);

  for (const target of program.imports) {
    if (seen.has(target)) continue;
    seen.add(target);
    const resolved = await importResolver(target, { from: program.baseIRI || options.filename || null, seen });
    if (!resolved) throw new Error(`IMPORTS resolver returned no source for ${target}`);
    const importSource = typeof resolved === 'string' ? resolved : resolved.source;
    const importOptions = typeof resolved === 'string' ? {} : (resolved.options || {});
    const parsedImport = await parseInputAsync(importSource, { ...options, ...importOptions, baseIRI: importOptions.baseIRI || target, filename: importOptions.filename || target });
    const imported = await resolveImportsAsync(parsedImport, { ...options, ...importOptions, importResolver }, seen);
    merged = mergePrograms(merged, imported);
  }

  return mergePrograms(merged, program);
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

async function runAsync(source, options = {}) {
  const compiled = await compileAsync(source, options);
  const result = await evaluateAsync(compiled.program, { ...compiled.options, analysis: compiled.analysis });
  result.diagnostics = compiled.diagnostics;
  result.analysis = compiled.analysis;
  if (compiled.shapeEngine && options.validateShapes) {
    result.validationReport = await compiled.shapeEngine.validate(result.closure, options);
  }
  return result;
}

async function runAndValidateAsync(source, options = {}) {
  if (!options.shapes && !options.shapeEngine) throw new Error('runAndValidateAsync requires shapes or shapeEngine');
  return runAsync(source, { ...options, validateShapes: true });
}

async function runToStringAsync(source, options = {}) {
  const compiled = await compileAsync(source, options);
  const result = await evaluateAsync(compiled.program, { ...compiled.options, analysis: compiled.analysis });
  result.diagnostics = compiled.diagnostics;
  result.analysis = compiled.analysis;
  const triples = resultTriples(result, compiled.program, options);
  return formatTriples(triples, result.prefixes);
}

module.exports = {
  parse,
  parseQuery,
  parseInput,
  parseInputAsync,
  parseRdfSyntax,
  parseRdfDocument,
  parseRdfMessageLog,
  looksLikeRdfMessageLog,
  rdfDocumentToProgram,
  compile,
  compileAsync,
  resolveImports,
  resolveImportsAsync,
  mergePrograms,
  analyze,
  evaluate,
  evaluateAsync,
  run,
  runAsync,
  runAndValidateAsync,
  runToString,
  runToStringAsync,
  runQuery,
  runQueryAsync,
  queryResult,
  queryProgram,
  queryRunOptions,
  shouldUseHybridForQuery,
  formatTriples,
  formatBindings,
  sortTriples,
  toJSON,
  formatTrace,
  formatProof,
  resultTriples,
};
