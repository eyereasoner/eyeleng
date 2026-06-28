#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { colors: C, info, summaryLine } = require('./harness.js');

const root = path.join(__dirname, '..');
const start = Date.now();
const summaryFile = path.join(os.tmpdir(), `eyeleng-test-summary-${process.pid}.jsonl`);

const preferred = [
  'api.test.js',
  'cli.test.js',
  'builtins.test.js',
  'browser-bundle.test.js',
  'examples.test.js',
  'shacl12-rules.test.js',
  'w3c-rdf.test.js',
];
const files = preferred.filter((name) => fs.existsSync(path.join(__dirname, name)));

let status = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, EYELENG_TEST_SUMMARY_FILE: summaryFile },
  });
  if (result.error) {
    console.error(result.error.stack || result.error.message || String(result.error));
    status = 1;
    break;
  }
  if (result.status !== 0) status = result.status || 1;
}

let passed = 0;
let failed = 0;
let total = 0;
let skipped = 0;
if (fs.existsSync(summaryFile)) {
  const lines = fs.readFileSync(summaryFile, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      passed += item.passed || 0;
      failed += item.failed || 0;
      total += item.total || 0;
      skipped += item.skipped || item.skip || 0;
    } catch {}
  }
  fs.rmSync(summaryFile, { force: true });
}

const ms = Date.now() - start;
info('Total');
if (status === 0 && failed === 0) {
  summaryLine('ok', passed, total, ms, { skipped });
} else {
  summaryLine('fail', passed, total, ms, { skipped });
}
process.exit(status === 0 && failed === 0 ? 0 : status || 1);
