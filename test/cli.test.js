'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, main } = require('./harness.js').createHarness('CLI');
const { help, parseArgs } = require('../src/cli.js');

function longOptions(text) {
  return Array.from(text.matchAll(/(^|\s)(--[a-z][a-z0-9-]*)\b/gm), (match) => match[2])
    .filter((option, index, options) => options.indexOf(option) === index)
    .sort();
}

function readmeCliOptions() {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const match = readme.match(/Important options:\n\n```text\n([\s\S]*?)\n```/);
  assert.ok(match, 'README.md should contain the CLI Important options text block');
  return match[1];
}

test('CLI help documents RDF Message Log flags', () => {
  const text = help();
  assert.match(text, /--rdf-messages\s+Parse input as an RDF Message Log/);
  assert.doesNotMatch(text, /--stream-messages/);
  assert.match(text, /--include-message-facts\s+Include payload facts while parsing RDF Message Logs/);
});

test('README CLI options stay in sync with --help', () => {
  const helpOptions = longOptions(help()).filter((option) => option !== '--help');
  const readmeOptions = longOptions(readmeCliOptions()).filter((option) => option !== '--help');
  assert.deepEqual(readmeOptions, helpOptions);
});

test('RDF Message Log flags are accepted by parseArgs', () => {
  assert.equal(parseArgs(['--rdf-messages']).options.rdfMessages, true);
  assert.equal(parseArgs(['--include-message-facts']).options.includeMessageFacts, true);
});

test('query mode flag is accepted by parseArgs', () => {
  assert.equal(parseArgs(['--query-mode', 'auto']).options.queryMode, 'auto');
  assert.equal(parseArgs(['--query-mode', 'forward']).options.queryMode, 'forward');
  assert.equal(parseArgs(['--query-mode', 'backward']).options.queryMode, 'backward');
  assert.equal(parseArgs([]).options.hybrid, 'auto');
  assert.equal(parseArgs(['--hybrid']).options.hybrid, true);
  assert.equal(parseArgs(['--no-hybrid']).options.hybrid, false);
  assert.throws(() => parseArgs(['--query-mode', 'hybrid']), /--query-mode requires auto, forward, or backward/);
  assert.throws(() => parseArgs(['--query-mode', 'sideways']), /--query-mode requires auto, forward, or backward/);
  assert.throws(() => parseArgs(['--stream-messages']), /Unknown option --stream-messages/);
});

main();
