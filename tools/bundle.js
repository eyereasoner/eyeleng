#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const cliEntry = 'src/cli.js';
const cliOutput = 'eyeleng.js';
const browserEntry = 'src/index.js';
const browserOutput = 'dist/browser/eyeleng.browser.js';
const playgroundOutput = 'playground.html';

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

function collectGraph(entry) {
  const modules = new Map();
  const mappings = new Map();

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
      }
    }
    mappings.set(id, map);
  }

  collect(entry);
  return { modules, mappings };
}

function js(value) {
  return JSON.stringify(value);
}



function ensureParentDir(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
}

function writeExecutable(relativeOutput, chunks) {
  const outPath = path.join(root, relativeOutput);
  ensureParentDir(outPath);
  fs.writeFileSync(outPath, chunks.join('\n'), 'utf8');
  fs.chmodSync(outPath, 0o755);
  console.log(`wrote ${relativeOutput}`);
}

function writeFile(relativeOutput, chunks) {
  const outPath = path.join(root, relativeOutput);
  ensureParentDir(outPath);
  fs.writeFileSync(outPath, chunks.join('\n'), 'utf8');
  console.log(`wrote ${relativeOutput}`);
}

function buildCli() {
  const { modules, mappings } = collectGraph(cliEntry);
  const chunks = [];
  chunks.push('#!/usr/bin/env node');
  chunks.push("'use strict';");
  chunks.push('(function () {');
  chunks.push('  const __nativeRequire = require;');
  chunks.push('  const __modules = {');
  for (const [id, source] of modules.entries()) {
    chunks.push(`    ${js(id)}: function (require, module, exports) {`);
    chunks.push(indent(source, 6));
    chunks.push('    },');
  }
  chunks.push('  };');
  chunks.push(`  const __mappings = ${js(Object.fromEntries(mappings.entries()))};`);
  chunks.push('  const __cache = {};');
  chunks.push('  function __require(id) {');
  chunks.push('    if (!id.startsWith("src/")) return __nativeRequire(id);');
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
  chunks.push(`  Promise.resolve(__require(${js(cliEntry)}).main(process.argv.slice(2)))`);
  chunks.push('    .then((code) => { process.exitCode = code; })');
  chunks.push("    .catch((error) => { console.error(error); process.exitCode = 1; });");
  chunks.push('}());');
  chunks.push('');

  writeExecutable(cliOutput, chunks);
}

function buildBrowser() {
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch {
    // Keep source-only checkouts buildable before npm install. This fallback is
    // sufficient for the synchronous SRL API; installing dependencies enables
    // the full RDF/SHACL browser bundle.
    return buildBrowserFallback();
  }

  const outfile = path.join(root, browserOutput);
  ensureParentDir(outfile);
  esbuild.buildSync({
    entryPoints: [path.join(root, browserEntry)],
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'eyeleng',
    target: ['es2020'],
    footer: { js: 'globalThis.eyeleng = globalThis.Eyeleng = eyeleng;' },
  });
  console.log(`wrote ${browserOutput}`);
}

function buildBrowserFallback() {
  const { modules, mappings } = collectGraph(browserEntry);
  const chunks = [];
  chunks.push("'use strict';");
  chunks.push('(function (global) {');
  chunks.push('  const __modules = {');
  for (const [id, source] of modules.entries()) {
    chunks.push(`    ${js(id)}: function (require, module, exports) {`);
    chunks.push(indent(source, 6));
    chunks.push('    },');
  }
  chunks.push('  };');
  chunks.push(`  const __mappings = ${js(Object.fromEntries(mappings.entries()))};`);
  chunks.push('  const __cache = {};');
  chunks.push('  function __require(id) {');
  chunks.push('    if (__cache[id]) return __cache[id].exports;');
  chunks.push('    if (!__modules[id]) throw new Error("Bundled dependency not available; run npm install && npm run build: " + id);');
  chunks.push('    const module = { exports: {} };');
  chunks.push('    __cache[id] = module;');
  chunks.push('    const localRequire = function (request) {');
  chunks.push('      const mapped = (__mappings[id] && __mappings[id][request]) || request;');
  chunks.push('      return __require(mapped);');
  chunks.push('    };');
  chunks.push('    __modules[id](localRequire, module, module.exports);');
  chunks.push('    return module.exports;');
  chunks.push('  }');
  chunks.push(`  const api = __require(${js(browserEntry)});`);
  chunks.push('  global.eyeleng = api;');
  chunks.push('  global.Eyeleng = api;');
  chunks.push('}(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this));');
  chunks.push('');
  writeFile(browserOutput, chunks);
}

function buildBrowserModuleWrapper() {
  const exported = [
    'parse', 'parseQuery', 'parseInput', 'parseInputAsync', 'parseRdfSyntax', 'parseRdfDocument',
    'rdfDocumentToProgram', 'compile', 'compileAsync', 'resolveImports', 'resolveImportsAsync',
    'mergePrograms', 'analyze', 'evaluate', 'evaluateAsync', 'run', 'runAsync', 'runAndValidateAsync',
    'runToString', 'runToStringAsync', 'runQuery', 'runQueryAsync', 'queryResult', 'formatTriples',
    'formatBindings', 'sortTriples', 'toJSON', 'formatTrace', 'formatProof',
  ];
  const chunks = [
    "import './eyeleng.browser.js';",
    '',
    'function getBrowserApi() {',
    "  const api = typeof globalThis !== 'undefined' ? globalThis.eyeleng : undefined;",
    "  if (!api) throw new Error('Eyeleng browser bundle is not initialized');",
    '  return api;',
    '}',
    '',
  ];
  for (const name of exported) chunks.push(`export function ${name}(...args) { return getBrowserApi().${name}(...args); }`);
  chunks.push('', 'const eyeleng = {');
  for (const name of exported) chunks.push(`  ${name},`);
  chunks.push('};', '', 'export default eyeleng;', '');
  writeFile('dist/browser/index.mjs', chunks);
}

function updatePlaygroundBundle() {
  const fallbackNames = [
    'family.srl',
    'socrates.srl',
    'spec-2-2-recursion.srl',
    'bmi.srl',
    'stratified-negation.srl',
    'spec-builtins.srl',
    'spec-4-2-rdf-rules-syntax.ttl',
    'basic-ruleset.ttl',
  ];
  const examples = {};
  for (const name of fallbackNames) {
    examples[name] = fs.readFileSync(path.join(root, 'examples', name), 'utf8');
  }

  const filename = path.join(root, playgroundOutput);
  let html = fs.readFileSync(filename, 'utf8');
  html = html.replace(/^    window\.__EYELENG_MODULES__ = .*;$/m, '    window.__EYELENG_MODULES__ = {};');
  html = html.replace(/^    window\.__EYELENG_MAPPINGS__ = .*;$/m, '    window.__EYELENG_MAPPINGS__ = {};');
  html = html.replace(
    /^    window\.__EYELENG_EXAMPLES__ = .*;$/m,
    () => `    window.__EYELENG_EXAMPLES__ = ${js(examples)};`,
  );
  fs.writeFileSync(filename, html, 'utf8');
  console.log(`updated ${playgroundOutput}`);
}

function indent(source, spaces) {
  const prefix = ' '.repeat(spaces);
  return source.split('\n').map((line) => prefix + line).join('\n');
}

buildCli();
buildBrowser();
buildBrowserModuleWrapper();
updatePlaygroundBundle();
