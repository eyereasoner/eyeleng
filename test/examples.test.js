'use strict';

const { test, main } = require('./harness.js').createHarness('Examples');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { spawnSync } = require('node:child_process');
const { runToStringAsync, parseRdfMessageLog, compile, compileAsync, evaluateAsync, formatProof } = require('../src/index.js');

const root = path.join(__dirname, '..');
const examplesDir = path.join(root, 'examples');
const goldenDir = path.join(examplesDir, 'output');
const proofDir = path.join(examplesDir, 'proof');
const updateGoldens = process.env.UPDATE_EXAMPLE_GOLDENS === '1';

function relativeExample(filename) {
  return path.relative(examplesDir, filename).split(path.sep).join('/');
}

function collectExampleFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'README.md' || entry.name === 'output' || entry.name === 'proof') continue;
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectExampleFiles(filename));
    else if (/\.srl$/i.test(entry.name)) out.push(filename);
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

function goldenPath(filename, ext = '.srl') {
  const rel = relativeExample(filename);
  const stem = path.basename(rel, path.extname(rel));
  return path.join(goldenDir, `${stem}${ext}`);
}

function proofGoldenPath(filename) {
  const rel = relativeExample(filename);
  return path.join(proofDir, `${path.basename(rel, path.extname(rel))}.srl`);
}

// The proof document for an example, or '' when it derives nothing (an
// example whose rules never fire has no proof to check).
async function runProofExample(filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const options = { ...runOptions(filename), trace: true };
  if (relativeExample(filename) === 'rdf-messages.srl') {
    const dataFilename = path.join(examplesDir, 'rdf-messages.trig');
    const messageLog = await parseRdfMessageLog(fs.readFileSync(dataFilename, 'utf8'), {
      filename: dataFilename,
      baseIRI: pathToFileURL(dataFilename).href,
    });
    options.baseGraph = messageLog.baseData;
  }
  const compiled = await compileAsync(source, options);
  const result = await evaluateAsync(compiled.program, { ...options, analysis: compiled.analysis });
  return formatProof(result.trace, result.prefixes);
}

// Examples whose derivation is far too large to keep a proof document for:
// a proof step carries its own bindings and the premises it used, so these
// run into hundreds of thousands of steps. Their result goldens still
// cover them; eyeron skips the same family for the same reason.
const noProofExamples = new Set([
  'deep-taxonomy-100.srl',
  'deep-taxonomy-1000.srl',
  'deep-taxonomy-10000.srl',
  'deep-taxonomy-100000.srl',
  'odrl-dpv-risk-ranked.srl',
]);

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

async function runOutputExample(filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const options = runOptions(filename);
  if (relativeExample(filename) === 'rdf-messages.srl') {
    const dataFilename = path.join(examplesDir, 'rdf-messages.trig');
    const messageLog = await parseRdfMessageLog(fs.readFileSync(dataFilename, 'utf8'), {
      filename: dataFilename,
      baseIRI: pathToFileURL(dataFilename).href,
    });
    options.baseGraph = messageLog.baseData;
  }
  return runToStringAsync(source, options);
}


for (const filename of collectExampleFiles(examplesDir)) {
  const rel = relativeExample(filename);
  const check = checkExamples.get(rel);

  test(rel, async () => {
    const expectedPath = check ? goldenPath(filename, '.txt') : goldenPath(filename, '.srl');
    const actual = check ? runCheckExample(filename, check.status) : await runOutputExample(filename);

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

    if (check || noProofExamples.has(rel)) return;

    // Proof goldens, alongside the result goldens: an example that derives
    // anything also has its proof document checked, and that document is
    // itself an SRL rule set (PREFIX headers plus one DATA block of
    // reified steps), so it has to parse back in.
    const proof = await runProofExample(filename);
    const proofPath = proofGoldenPath(filename);
    if (updateGoldens) {
      fs.mkdirSync(proofDir, { recursive: true });
      if (proof) fs.writeFileSync(proofPath, ensureGoldenNewline(proof), 'utf8');
      else if (fs.existsSync(proofPath)) fs.unlinkSync(proofPath);
    }

    if (!proof) {
      assert.equal(fs.existsSync(proofPath), false, `${rel} derives nothing, so it should have no proof golden`);
      return;
    }
    assert.equal(fs.existsSync(proofPath), true, `Missing proof golden: ${path.relative(root, proofPath)}`);
    assert.equal(
      normalizeExampleOutput(proof),
      normalizeExampleOutput(fs.readFileSync(proofPath, 'utf8')),
      `${rel} proof differs from ${path.relative(root, proofPath)}`,
    );
    assert.doesNotThrow(() => compile(proof, { strictGrammar: true }), `${rel} proof golden is not valid SRL`);
  });
}

main();
