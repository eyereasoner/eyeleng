'use strict';

const { formatTriple, formatTerm, tripleKey } = require('./term.js');

const PE_NS = 'https://eyereasoner.github.io/pe#';
const RDF_PROOF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

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

// A proof is emitted as an ordinary SRL document: `PREFIX` headers and one
// `DATA { ... }` block whose steps reify their own conclusion, the shape
// eyeron's own `--proof` for `.srl` produces. N3 writes the same steps as
// top-level triples whose subject is the quoted conclusion, which SRL has
// no term for: its only quoted-graph-shaped term is the single-triple
// `<<( s p o )>>` of [80] TripleTerm, so a step names itself by reifying
// that instead.
function formatProof(trace, prefixes = {}) {
  if (!trace.length) return '';

  // One step per distinct conclusion, in first-derivation order.
  const stepOf = new Map();
  const steps = [];
  for (const entry of trace) {
    const key = tripleKey(entry.triple);
    if (stepOf.has(key)) continue;
    const id = `_:step${stepOf.size + 1}`;
    stepOf.set(key, id);
    steps.push({ id, entry });
  }

  const body = [];
  for (const { entry } of steps) body.push(`  ${formatTriple(entry.triple, prefixes)}`);
  body.push('');

  steps.forEach(({ id, entry }, index) => {
    if (index > 0) body.push('');
    const groups = [['rdf:reifies', [proofTripleTerm(entry.triple, prefixes)]], ['pe:rule', [String(entry.ruleNumber)]]];
    const bindings = Object.entries(entry.binding || {}).sort(([a], [b]) => a.localeCompare(b));
    if (bindings.length > 0) {
      groups.push(['pe:binding', bindings.map(([name, value]) => `[ pe:var ${quoteString(name)}; pe:value ${formatTerm(value, prefixes)} ]`)]);
    }
    // A premise that was itself derived points at that step; one given in
    // `DATA` or the base graph is named by its own triple term.
    const uses = (entry.uses || []).map((triple) => stepOf.get(tripleKey(triple)) || proofTripleTerm(triple, prefixes));
    if (uses.length > 0) groups.push(['pe:uses', uses]);
    body.push(renderProofStep(id, groups));
  });

  const block = `DATA {\n${body.join('\n')}\n}`;
  const header = proofPrefixHeader(block, prefixes);
  return `${header}${header ? '\n\n' : ''}${block}`;
}

function proofTripleTerm(triple, prefixes) {
  return `<<(${formatTerm(triple.s, prefixes)} ${formatTerm(triple.p, prefixes)} ${formatTerm(triple.o, prefixes)})>>`;
}

function renderProofStep(id, groups) {
  const lines = [`  ${id}`];
  groups.forEach(([predicate, objects], index) => {
    const end = index + 1 === groups.length ? '.' : ';';
    if (objects.length === 1) {
      lines.push(`    ${predicate} ${objects[0]}${end}`);
      return;
    }
    lines.push(`    ${predicate}`);
    objects.forEach((object, objectIndex) => {
      lines.push(`      ${object}${objectIndex + 1 === objects.length ? end : ','}`);
    });
  });
  return lines.join('\n');
}

// Declare exactly the prefixes the block uses, so the document stands on
// its own. `pe:` and `rdf:` are always needed by the step vocabulary.
function proofPrefixHeader(block, prefixes) {
  const all = { pe: PE_NS, rdf: RDF_PROOF_NS, ...prefixes };
  const lines = [];
  for (const name of Object.keys(all).sort()) {
    const iri = all[name];
    if (!iri) continue;
    const used = name === 'pe' || name === 'rdf' || new RegExp(`(^|[\\s(,;\\[])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`, 'm').test(block);
    if (used) lines.push(`PREFIX ${name}: <${iri}>`);
  }
  return lines.join('\n');
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
