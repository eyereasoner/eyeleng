'use strict';

const { parse, parseQuery } = require('./parser.js');
const { parseRdfDocument } = require('./rdf.js');
const { parseRdfMessageLog, looksLikeRdfMessageLog } = require('./rdfMessages.js');
const { evaluate, evaluateAsync } = require('./engine.js');
const { analyze } = require('./analyze.js');
const { formatTriples, sortTriples, toJSON, formatTrace, formatProof, formatBindings } = require('./format.js');
const { runQuery, runQueryAsync, queryResult, queryProgram, queryRunOptions, shouldUseHybridForQuery } = require('./query.js');
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
  run, runAsync, runToString, runToStringAsync, runQuery, runQueryAsync, queryResult, queryProgram, queryRunOptions,
  shouldUseHybridForQuery, formatTriples, formatBindings, sortTriples, toJSON, formatTrace, formatProof, resultTriples,
};
