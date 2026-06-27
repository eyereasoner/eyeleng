#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const entry = 'src/api.js';
const outDir = path.join(root, 'dist', 'browser');
const browserOutput = path.join(outDir, 'eyeleng.browser.js');
const moduleOutput = path.join(outDir, 'index.mjs');
const modules = new Map();
const mappings = new Map();

function toPosix(file) {
  return file.split(path.sep).join('/');
}

function resolveModule(fromId, request) {
  if (!request.startsWith('.')) return null;
  const fromDir = path.dirname(fromId);
  let resolved = toPosix(path.normalize(path.join(fromDir, request)));
  if (!resolved.endsWith('.js')) resolved += '.js';
  return resolved;
}

function collect(id) {
  if (modules.has(id)) return;
  const abs = path.join(root, id);
  let source = fs.readFileSync(abs, 'utf8');
  source = source.replace(/^#!.*\n/, '');
  modules.set(id, source);

  const map = {};
  const re = /require\(['"]([^'"]+)['"]\)/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const request = match[1];
    const resolved = resolveModule(id, request);
    if (resolved) {
      map[request] = resolved;
      collect(resolved);
    } else if (!isBrowserGlobalModule(request)) {
      throw new Error(`Browser bundle cannot include external module ${request} required by ${id}`);
    }
  }
  mappings.set(id, map);
}

function isBrowserGlobalModule(request) {
  // The public API dependency graph should not need Node modules.  Keeping this
  // helper explicit makes future accidental Node-only imports fail during build.
  return false;
}

function js(value) {
  return JSON.stringify(value);
}

function indent(source, spaces) {
  const prefix = ' '.repeat(spaces);
  return source.split('\n').map((line) => prefix + line).join('\n');
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
}

function buildBrowserBundle() {
  collect(entry);
  fs.mkdirSync(outDir, { recursive: true });

  const chunks = [];
  chunks.push("'use strict';");
  chunks.push('(function (root) {');
  chunks.push('  const __modules = Object.create(null);');
  chunks.push('  const __cache = Object.create(null);');
  chunks.push('  // ---- bundled modules ----');
  for (const [id, source] of modules.entries()) {
    chunks.push(`  __modules[${js(id)}] = function (require, module, exports) {`);
    chunks.push(indent(source, 4));
    chunks.push('  };');
  }
  chunks.push(`  const __mappings = ${js(Object.fromEntries(mappings.entries()))};`);
  chunks.push('  function __require(id) {');
  chunks.push('    if (__cache[id]) return __cache[id].exports;');
  chunks.push('    if (!__modules[id]) throw new Error("Bundled module not found: " + id);');
  chunks.push('    const module = { exports: {} };');
  chunks.push('    __cache[id] = module;');
  chunks.push('    const localRequire = function (request) {');
  chunks.push('      const mapped = (__mappings[id] && __mappings[id][request]) || request;');
  chunks.push('      return __require(mapped);');
  chunks.push('    };');
  chunks.push('    __modules[id](localRequire, module, module.exports);');
  chunks.push('    return module.exports;');
  chunks.push('  }');
  chunks.push(`  const api = __require(${js(entry)});`);
  chunks.push(`  const browserApi = { version: ${js(readVersion())}, ...api };`);
  chunks.push('  root.eyeleng = browserApi;');
  chunks.push('}(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this)));');
  chunks.push('');
  fs.writeFileSync(browserOutput, chunks.join('\n'), 'utf8');
  console.log(`wrote ${path.relative(root, browserOutput)}`);
}

function buildModuleWrapper() {
  const exported = [
    'parse',
    'parseQuery',
    'parseInput',
    'parseRdfSyntax',
    'parseRdfDocument',
    'rdfDocumentToProgram',
    'compile',
    'resolveImports',
    'mergePrograms',
    'analyze',
    'evaluate',
    'run',
    'runToString',
    'runQuery',
    'queryResult',
    'formatTriples',
    'formatBindings',
    'sortTriples',
    'toJSON',
    'formatTrace',
  ];

  const chunks = [];
  chunks.push("import './eyeleng.browser.js';");
  chunks.push('');
  chunks.push('function getBrowserApi() {');
  chunks.push("  const api = typeof globalThis !== 'undefined' ? globalThis.eyeleng : undefined;");
  chunks.push('  if (!api) {');
  chunks.push("    throw new Error('Eyeleng browser bundle is not initialized. Import \"eyeleng/browser\" only in a browser or worker runtime.');");
  chunks.push('  }');
  chunks.push('  return api;');
  chunks.push('}');
  chunks.push('');
  chunks.push('export const version = getBrowserApi().version;');
  for (const name of exported) {
    chunks.push(`export function ${name}(...args) { return getBrowserApi().${name}(...args); }`);
  }
  chunks.push('');
  chunks.push('const eyeleng = {');
  chunks.push('  get version() { return getBrowserApi().version; },');
  for (const name of exported) chunks.push(`  ${name},`);
  chunks.push('};');
  chunks.push('');
  chunks.push('export default eyeleng;');
  chunks.push('');
  fs.writeFileSync(moduleOutput, chunks.join('\n'), 'utf8');
  console.log(`wrote ${path.relative(root, moduleOutput)}`);
}

buildBrowserBundle();
buildModuleWrapper();
