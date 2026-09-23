#!/usr/bin/env node
'use strict';

/**
 * Checks every packaged proof against the rule set it was produced from.
 *
 * This is the suite that says what a proof is worth. It is not a golden
 * comparison: a proof that matched its golden byte for byte could still be
 * nonsense, so each document is re-checked here -- every recorded rule
 * application re-performed, every use resolved, the derivation graph tested
 * for cycles, and every claim accounted for.
 *
 * It also confirms the checker rejects a tampered document, because one that
 * accepted everything would pass the first half in silence.
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');

const { createHarness, info } = require('./harness');
const { compileAsync, parseRdfMessageLog } = require('../src/index.js');
const { checkProofDocument, verdict } = require('../src/check-proof.js');

const root = path.join(__dirname, '..');
const examplesDir = path.join(root, 'examples');
const proofDir = path.join(examplesDir, 'proof');

function importResolver(target) {
  if (!target.startsWith('file:')) throw new Error(`import resolver only supports file: imports, got ${target}`);
  const filename = fileURLToPath(target);
  return { source: fs.readFileSync(filename, 'utf8'), options: { filename, baseIRI: pathToFileURL(filename).href } };
}

// The program a proof was produced from, assembled the way the example suite
// assembles it: `IMPORTS` resolved, because a step cites a rule by its number
// in the compiled rule set, and a message log supplied as the base graph.
async function programFor(name) {
  const filename = path.join(examplesDir, name);
  const options = { filename, baseIRI: pathToFileURL(filename).href, importResolver, now: new Date('2026-05-15T12:34:56Z') };
  let baseGraph;
  if (name === 'rdf-messages.srl') {
    const dataFilename = path.join(examplesDir, 'rdf-messages.trig');
    const messageLog = await parseRdfMessageLog(fs.readFileSync(dataFilename, 'utf8'), {
      filename: dataFilename,
      baseIRI: pathToFileURL(dataFilename).href,
    });
    baseGraph = messageLog.baseData;
  }
  const compiled = await compileAsync(fs.readFileSync(filename, 'utf8'), options);
  return { program: compiled.program, baseGraph };
}

const harness = createHarness('Proof checking');
const names = fs.readdirSync(proofDir).filter((f) => f.endsWith('.srl')).sort();
const totals = { steps: 0, verified: 0 };

for (const name of names) {
  harness.test(name, async () => {
    const { program, baseGraph } = await programFor(name);
    const proof = fs.readFileSync(path.join(proofDir, name), 'utf8');
    const report = checkProofDocument(program, proof, { baseGraph });
    totals.steps += report.steps;
    totals.verified += report.verified;
    if (!report.valid) {
      const first = report.failures.slice(0, 3).map((f) => `[${f.condition}] ${f.conclusion} -- ${f.detail}`);
      throw new Error(`${verdict(report)}\n    ${first.join('\n    ')}`);
    }
  });
}

// A checker that accepted anything would pass everything above.
const TAMPERS = [
  ['a changed conclusion', (text) => text.replace('<<(:Socrates a :Mortal)>>', '<<(:Plato a :Mortal)>>')],
  ['a changed binding', (text) => text.replace('pe:value :Socrates', 'pe:value :Plato')],
  ['a changed rule citation', (text) => text.replace('pe:rule 1', 'pe:rule 2')],
  ['a changed use', (text) => text.replace('<<(:Socrates a :Human)>>', '<<(:Plato a :Human)>>')],
];

for (const [what, tamper] of TAMPERS) {
  harness.test(`rejects ${what}`, async () => {
    const { program } = await programFor('socrates.srl');
    const good = fs.readFileSync(path.join(proofDir, 'socrates.srl'), 'utf8');
    const text = tamper(good);
    if (text === good) throw new Error('the tamper changed nothing');
    const report = checkProofDocument(program, text);
    if (report.valid) throw new Error('the checker accepted it');
  });
}

harness.main().then(() => {
  info(`${names.length} proofs, ${totals.steps} steps, ${totals.verified} verified`);
});
