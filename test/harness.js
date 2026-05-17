'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const C = TTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', dim: '\x1b[2m', n: '\x1b[0m' }
  : { g: '', r: '', y: '', dim: '', n: '' };

function msTag(ms) {
  return `${C.dim}(${ms} ms)${C.n}`;
}

function info(msg) {
  console.log(`${C.y}==${C.n} ${msg}`);
}

function okLine(idx, msg, ms) {
  console.log(`${C.dim}${idx}${C.n} ${C.g}OK${C.n} ${C.g}${msg}${C.n} ${msTag(ms)}`);
}

function failLine(idx, msg, ms) {
  console.error(`${C.dim}${idx}${C.n} ${C.r}FAIL${C.n} ${C.r}${msg}${C.n} ${msTag(ms)}`);
}

function summarizeError(err) {
  if (!err) return 'Unknown error';
  if (err.stack) return err.stack;
  if (err.message) return err.message;
  return String(err);
}

function appendSummary(summary) {
  const file = process.env.EYESHARL_TEST_SUMMARY_FILE;
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(summary)}\n`, 'utf8');
}

function createHarness(section) {
  const tests = [];

  function test(name, fn) {
    tests.push({ name, fn });
  }

  async function main() {
    const suiteStart = Date.now();
    const idxWidth = Math.max(3, String(Math.max(1, tests.length)).length);
    let passed = 0;
    let failed = 0;

    info(section);
    for (let i = 0; i < tests.length; i++) {
      const { name, fn } = tests[i];
      const idx = String(i + 1).padStart(idxWidth, '0');
      const start = Date.now();
      try {
        await fn();
        const ms = Date.now() - start;
        okLine(idx, name, ms);
        passed++;
      } catch (err) {
        const ms = Date.now() - start;
        failLine(idx, name, ms);
        console.error(summarizeError(err));
        failed++;
      }
    }

    const suiteMs = Date.now() - suiteStart;
    if (failed === 0) {
      console.log(`${C.g}OK${C.n} ${passed}/${tests.length} tests passed ${msTag(suiteMs)}`);
    } else {
      console.error(`${C.r}FAIL${C.n} ${passed}/${tests.length} tests passed ${msTag(suiteMs)}`);
    }
    console.log('');

    appendSummary({ section, passed, failed, total: tests.length, ms: suiteMs });
    if (failed > 0) process.exitCode = 1;
  }

  return { test, main, colors: C, info, msTag };
}

module.exports = { createHarness, colors: C, info, msTag };
