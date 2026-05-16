'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

test('browser ES module wrapper runs Eyesharl', () => {
  const script = `
    import eyesharl from ${JSON.stringify(path.join(root, 'dist', 'browser', 'index.mjs'))};
    const source = 'PREFIX : <http://example/> DATA { :Socrates a :Man . } RULE { ?x a :Mortal } WHERE { ?x a :Man }';
    const output = eyesharl.runToString(source).trim();
    if (output !== ':Socrates a :Mortal .') throw new Error(output);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('browser global bundle exposes Eyesharl without ES modules', () => {
  const bundle = fs.readFileSync(path.join(root, 'dist', 'browser', 'eyesharl.browser.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(bundle, context, { filename: 'eyesharl.browser.js' });
  assert.equal(typeof context.eyesharl, 'object');
  assert.equal(typeof context.eyesharl.runToString, 'function');

  const source = 'PREFIX : <http://example/> DATA { :Socrates a :Man . } RULE { ?x a :Mortal } WHERE { ?x a :Man }';
  assert.equal(context.eyesharl.runToString(source).trim(), ':Socrates a :Mortal .');
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
