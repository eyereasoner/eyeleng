'use strict';

const { TripleStore, instantiateTriple } = require('./store.js');
const { tripleKey } = require('./term.js');

function outputTriples(result, patterns = []) {
  if (!patterns || patterns.length === 0) return null;
  const store = new TripleStore(result.closure || []);
  const seen = new Set();
  const out = [];
  for (const pattern of patterns) {
    for (const binding of store.match(pattern, {})) {
      const triple = instantiateTriple(pattern, binding);
      if (!triple) continue;
      const key = tripleKey(triple);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(triple);
      }
    }
  }
  return out;
}

function resultTriples(result, program = {}, options = {}) {
  if (options.all) return result.closure;
  const projected = outputTriples(result, program.output || []);
  return projected || result.inferred;
}

module.exports = { outputTriples, resultTriples };
