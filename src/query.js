'use strict';

const { parseQuery } = require('./parser.js');
const { TripleStore, bindingKey } = require('./store.js');
const { evaluateBody } = require('./engine.js');
const { backwardQuery, planBackwardQuery, preferredBackwardPredicates } = require('./backward.js');

function queryResult(result, querySpec, options = {}) {
  const store = new TripleStore(result.closure || []);
  const bindings = evaluateBody(querySpec.body, store, {}, options);
  const select = normalizeSelect(querySpec.select, bindings);
  return {
    baseIRI: result.baseIRI,
    prefixes: result.prefixes,
    select,
    bindings: projectBindings(bindings, select),
    mode: options.queryMode === 'hybrid' || options.hybrid ? 'hybrid' : 'forward',
  };
}

function queryProgram(program, querySpec, options = {}) {
  const mode = options.queryMode || 'auto';
  if (mode !== 'forward' && mode !== 'hybrid') {
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
      input: program.data.slice(),
      inferred: [],
      closure: program.data.slice(),
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

  const runOptions = queryRunOptions(program, querySpec, options);
  const result = run(program, runOptions);
  result.diagnostics = diagnostics;
  result.query = queryResult(result, querySpec, runOptions);
  return result;
}

function queryRunOptions(program, querySpec, options = {}) {
  if (shouldUseHybridForQuery(program, querySpec, options)) return { ...options, hybrid: true };
  return options;
}

function shouldUseHybridForQuery(program, querySpec, options = {}) {
  const mode = options.queryMode || 'auto';
  if (options.hybrid || mode === 'hybrid') return true;
  if (mode !== 'auto') return false;
  if (!querySpec) return false;
  return preferredBackwardPredicates(program, options).size > 0;
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

module.exports = { runQuery, queryResult, queryProgram, queryRunOptions, shouldUseHybridForQuery, parseQuery, normalizeSelect, projectBindings };
