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
