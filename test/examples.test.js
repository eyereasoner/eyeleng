'use strict';

const { test, main } = require('./harness.js').createHarness('Examples');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { spawnSync } = require('node:child_process');
const { runToString } = require('../src/index.js');

const root = path.join(__dirname, '..');
const examplesDir = path.join(root, 'examples');
const goldenDir = path.join(examplesDir, 'output');
const updateGoldens = process.env.UPDATE_EXAMPLE_GOLDENS === '1';

function relativeExample(filename) {
  return path.relative(examplesDir, filename).split(path.sep).join('/');
}

function collectExampleFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'README.md' || entry.name === 'output') continue;
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectExampleFiles(filename));
    else if (/\.(srl|ttl)$/i.test(entry.name)) out.push(filename);
  }
  return out.sort((a, b) => relativeExample(a).localeCompare(relativeExample(b)));
}

function importResolver(target) {
  if (!target.startsWith('file:')) throw new Error(`test import resolver only supports file: imports, got ${target}`);
  const filename = fileURLToPath(target);
  return {
    source: fs.readFileSync(filename, 'utf8'),
    options: { filename, baseIRI: pathToFileURL(filename).href },
  };
}

function runOptions(filename) {
  return {
    filename,
    baseIRI: pathToFileURL(filename).href,
    importResolver,
    syntax: filename.endsWith('.ttl') ? 'rdf' : undefined,
    now: new Date('2026-05-15T12:34:56Z'),
  };
}

function normalizeGolden(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
}

function normalizeExampleOutput(text) {
  return normalizeGolden(text).replace(/<file:\/\/\/[^>\s]*\/examples\//g, '<file:///__EXAMPLES__/');
}

function ensureGoldenNewline(text) {
  const normalized = normalizeExampleOutput(text);
  return normalized.length === 0 ? '' : `${normalized}\n`;
}

function goldenPath(filename, ext = '.trig') {
  const rel = relativeExample(filename);
  const stem = path.basename(rel, path.extname(rel));
  return path.join(goldenDir, `${stem}${ext}`);
}

const checkExamples = new Map([
  ['check-unsafe.srl', { status: 1 }],
  ['unstratified-negation.srl', { status: 1 }],
  ['variable-predicate-dependency.srl', { status: 1 }],
  ['well-formedness-error.srl', { status: 1 }],
]);

function runCheckExample(filename, expectedStatus) {
  const result = spawnSync(process.execPath, [path.join(root, 'eyeleng.js'), '--check', filename], { encoding: 'utf8' });
  assert.equal(result.status, expectedStatus, `${relativeExample(filename)}\nSTDERR:\n${result.stderr}`);
  return result.stderr || result.stdout || '';
}

function runOutputExample(filename) {
  const source = fs.readFileSync(filename, 'utf8');
  return runToString(source, runOptions(filename));
}

for (const filename of collectExampleFiles(examplesDir)) {
  const rel = relativeExample(filename);
  const check = checkExamples.get(rel);

  test(rel, () => {
    const expectedPath = check ? goldenPath(filename, '.txt') : goldenPath(filename, '.trig');
    const actual = check ? runCheckExample(filename, check.status) : runOutputExample(filename);

    if (updateGoldens) {
      fs.mkdirSync(goldenDir, { recursive: true });
      fs.writeFileSync(expectedPath, ensureGoldenNewline(actual), 'utf8');
    }

    assert.equal(fs.existsSync(expectedPath), true, `Missing golden output: ${path.relative(root, expectedPath)}`);
    const expected = fs.readFileSync(expectedPath, 'utf8');
    assert.equal(
      normalizeExampleOutput(actual),
      normalizeExampleOutput(expected),
      `${rel} output differs from ${path.relative(root, expectedPath)}`,
    );
  });
}

main();
