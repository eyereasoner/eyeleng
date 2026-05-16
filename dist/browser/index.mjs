import './eyesharl.browser.js';

function getBrowserApi() {
  const api = typeof globalThis !== 'undefined' ? globalThis.eyesharl : undefined;
  if (!api) {
    throw new Error('Eyesharl browser bundle is not initialized. Import "eyesharl/browser" only in a browser or worker runtime.');
  }
  return api;
}

export const version = getBrowserApi().version;
export function parse(...args) { return getBrowserApi().parse(...args); }
export function parseQuery(...args) { return getBrowserApi().parseQuery(...args); }
export function parseInput(...args) { return getBrowserApi().parseInput(...args); }
export function parseRdfSyntax(...args) { return getBrowserApi().parseRdfSyntax(...args); }
export function parseRdfDocument(...args) { return getBrowserApi().parseRdfDocument(...args); }
export function rdfDocumentToProgram(...args) { return getBrowserApi().rdfDocumentToProgram(...args); }
export function compile(...args) { return getBrowserApi().compile(...args); }
export function resolveImports(...args) { return getBrowserApi().resolveImports(...args); }
export function mergePrograms(...args) { return getBrowserApi().mergePrograms(...args); }
export function analyze(...args) { return getBrowserApi().analyze(...args); }
export function evaluate(...args) { return getBrowserApi().evaluate(...args); }
export function run(...args) { return getBrowserApi().run(...args); }
export function runToString(...args) { return getBrowserApi().runToString(...args); }
export function runQuery(...args) { return getBrowserApi().runQuery(...args); }
export function queryResult(...args) { return getBrowserApi().queryResult(...args); }
export function formatTriples(...args) { return getBrowserApi().formatTriples(...args); }
export function formatBindings(...args) { return getBrowserApi().formatBindings(...args); }
export function sortTriples(...args) { return getBrowserApi().sortTriples(...args); }
export function toJSON(...args) { return getBrowserApi().toJSON(...args); }
export function formatTrace(...args) { return getBrowserApi().formatTrace(...args); }

const eyesharl = {
  get version() { return getBrowserApi().version; },
  parse,
  parseQuery,
  parseInput,
  parseRdfSyntax,
  parseRdfDocument,
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
};

export default eyesharl;
