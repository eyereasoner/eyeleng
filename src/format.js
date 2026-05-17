'use strict';

const { formatTriple, formatTerm } = require('./term.js');
const { outputTriples } = require('./output.js');

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
  const triples = options.all ? result.closure : (outputTriples(result, options.output || []) || result.inferred);
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
