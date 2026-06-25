#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { colors: C, msTag, info } = require('./harness.js');

const root = path.join(__dirname, '..');
const start = Date.now();
const summaryFile = path.join(os.tmpdir(), `eyesharl-test-summary-${process.pid}.jsonl`);

const preferred = [
  'api.test.js',
  'builtins.test.js',
  'browser-bundle.test.js',
  'examples.test.js',
  'shacl12-rules.test.js',
];
const files = preferred.filter((name) => fs.existsSync(path.join(__dirname, name)));

let status = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, EYESHARL_TEST_SUMMARY_FILE: summaryFile },
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
if (fs.existsSync(summaryFile)) {
  const lines = fs.readFileSync(summaryFile, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      passed += item.passed || 0;
      failed += item.failed || 0;
      total += item.total || 0;
    } catch {}
  }
  fs.rmSync(summaryFile, { force: true });
}

const ms = Date.now() - start;
info('Total');
if (status === 0 && failed === 0) {
  console.log(`${C.g}OK${C.n} ${passed}/${total} tests passed ${msTag(ms)}`);
} else {
  console.error(`${C.r}FAIL${C.n} ${passed}/${total} tests passed ${msTag(ms)}`);
}
process.exit(status === 0 && failed === 0 ? 0 : status || 1);
