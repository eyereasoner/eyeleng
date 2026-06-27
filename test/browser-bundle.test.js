'use strict';

const { test, main } = require('./harness.js').createHarness('Browser bundle');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

test('browser ES module wrapper runs Eyeleng', () => {
  const script = `
    import eyeleng from ${JSON.stringify(path.join(root, 'dist', 'browser', 'index.mjs'))};
    const source = 'PREFIX : <http://example/> DATA { :Socrates a :Man . } RULE { ?x a :Mortal } WHERE { ?x a :Man }';
    const output = eyeleng.runToString(source).trim();
    if (output !== ':Socrates a :Mortal .') throw new Error(output);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('browser global bundle exposes Eyeleng without ES modules', () => {
  const bundle = fs.readFileSync(path.join(root, 'dist', 'browser', 'eyeleng.browser.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(bundle, context, { filename: 'eyeleng.browser.js' });
  assert.equal(typeof context.eyeleng, 'object');
  assert.equal(typeof context.eyeleng.runToString, 'function');

  const source = 'PREFIX : <http://example/> DATA { :Socrates a :Man . } RULE { ?x a :Mortal } WHERE { ?x a :Man }';
  assert.equal(context.eyeleng.runToString(source).trim(), ':Socrates a :Mortal .');
});

test('playground inline scripts are syntactically valid', () => {
  const html = fs.readFileSync(path.join(root, 'playground.html'), 'utf8');
  const scriptRe = /<script(?<attrs>[^>]*)>(?<source>[\s\S]*?)<\/script>/g;
  let checked = 0;
  for (const match of html.matchAll(scriptRe)) {
    const attrs = match.groups.attrs || '';
    if (/\bsrc\s*=/.test(attrs) || /type=["']application\/json["']/.test(attrs)) continue;
    new vm.Script(match.groups.source, { filename: `playground-inline-script-${checked + 1}.js` });
    checked += 1;
  }
  assert.ok(checked > 0, 'expected at least one inline playground script');
});


test('playground loads version from package.json at runtime', () => {
  const html = fs.readFileSync(path.join(root, 'playground.html'), 'utf8');
  assert.equal(/window\.__EYELENG_VERSION__/.test(html), false, 'playground.html must not hard-code the package version');
  assert.match(html, /fetch\(new URL\(['"]package\.json['"],\s*window\.location\.href\)/);
  assert.match(html, /id=["']version-label["'][^>]*>v…<\/span>/);
});

main();
