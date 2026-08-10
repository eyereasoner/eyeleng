import './eyeleng.browser.js';

function getBrowserApi() {
  const api = typeof globalThis !== 'undefined' ? globalThis.eyeleng : undefined;
  if (!api) throw new Error('Eyeleng browser bundle is not initialized');
  return api;
}

export function parse(...args) { return getBrowserApi().parse(...args); }
export function parseQuery(...args) { return getBrowserApi().parseQuery(...args); }
export function parseInput(...args) { return getBrowserApi().parseInput(...args); }
export function parseInputAsync(...args) { return getBrowserApi().parseInputAsync(...args); }
export function parseRdfSyntax(...args) { return getBrowserApi().parseRdfSyntax(...args); }
export function parseRdfDocument(...args) { return getBrowserApi().parseRdfDocument(...args); }
export function rdfDocumentToProgram(...args) { return getBrowserApi().rdfDocumentToProgram(...args); }
export function compile(...args) { return getBrowserApi().compile(...args); }
export function compileAsync(...args) { return getBrowserApi().compileAsync(...args); }
export function resolveImports(...args) { return getBrowserApi().resolveImports(...args); }
export function resolveImportsAsync(...args) { return getBrowserApi().resolveImportsAsync(...args); }
export function mergePrograms(...args) { return getBrowserApi().mergePrograms(...args); }
export function analyze(...args) { return getBrowserApi().analyze(...args); }
export function evaluate(...args) { return getBrowserApi().evaluate(...args); }
export function evaluateAsync(...args) { return getBrowserApi().evaluateAsync(...args); }
export function run(...args) { return getBrowserApi().run(...args); }
export function runAsync(...args) { return getBrowserApi().runAsync(...args); }
export function runAndValidateAsync(...args) { return getBrowserApi().runAndValidateAsync(...args); }
export function runToString(...args) { return getBrowserApi().runToString(...args); }
export function runToStringAsync(...args) { return getBrowserApi().runToStringAsync(...args); }
export function runQuery(...args) { return getBrowserApi().runQuery(...args); }
export function runQueryAsync(...args) { return getBrowserApi().runQueryAsync(...args); }
export function queryResult(...args) { return getBrowserApi().queryResult(...args); }
export function formatTriples(...args) { return getBrowserApi().formatTriples(...args); }
export function formatBindings(...args) { return getBrowserApi().formatBindings(...args); }
export function sortTriples(...args) { return getBrowserApi().sortTriples(...args); }
export function toJSON(...args) { return getBrowserApi().toJSON(...args); }
export function formatTrace(...args) { return getBrowserApi().formatTrace(...args); }
export function formatProof(...args) { return getBrowserApi().formatProof(...args); }

const eyeleng = {
  parse,
  parseQuery,
  parseInput,
  parseInputAsync,
  parseRdfSyntax,
  parseRdfDocument,
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
  formatTriples,
  formatBindings,
  sortTriples,
  toJSON,
  formatTrace,
  formatProof,
};

export default eyeleng;
