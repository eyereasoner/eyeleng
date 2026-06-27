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
  console.log(`${C.y}==${C.n} ${C.y}${msg}${C.n}`);
}

function statusWord(status) {
  if (status === 'ok' || status === 'pass') return `${C.g}OK${C.n}`;
  if (status === 'skip') return `${C.y}SKIP${C.n}`;
  return `${C.r}FAIL${C.n}`;
}

function coloredMessage(status, msg) {
  if (status === 'ok' || status === 'pass') return `${C.g}${msg}${C.n}`;
  if (status === 'skip') return `${C.y}${msg}${C.n}`;
  return `${C.r}${msg}${C.n}`;
}

function line(idx, status, msg, ms) {
  const text = `${C.dim}${idx}${C.n} ${statusWord(status)} ${coloredMessage(status, msg)} ${msTag(ms)}`;
  if (status === 'fail') console.error(text);
  else console.log(text);
}

function okLine(idx, msg, ms) {
  line(idx, 'ok', msg, ms);
}

function skipLine(idx, msg, ms) {
  line(idx, 'skip', msg, ms);
}

function failLine(idx, msg, ms) {
  line(idx, 'fail', msg, ms);
}

function summaryLine(status, passed, total, ms, options = {}) {
  const skipped = options.skipped || 0;
  const skipPart = skipped ? `, ${C.y}${skipped} skipped${C.n}` : '';
  const label = options.label ? `${options.label}: ` : '';
  const timePart = ms === null || ms === undefined ? '' : ` ${msTag(ms)}`;
  const msg = `${label}${passed}/${total} tests passed${skipPart}${timePart}`;
  if (status === 'fail') console.error(`${statusWord(status)} ${msg}`);
  else console.log(`${statusWord(status)} ${msg}`);
}

function summarizeError(err) {
  if (!err) return 'Unknown error';
  if (err.stack) return err.stack;
  if (err.message) return err.message;
  return String(err);
}

function appendSummary(summary) {
  const file = process.env.EYELENG_TEST_SUMMARY_FILE;
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
    summaryLine(failed === 0 ? 'ok' : 'fail', passed, tests.length, suiteMs);
    console.log('');

    appendSummary({ section, passed, failed, total: tests.length, ms: suiteMs });
    if (failed > 0) process.exitCode = 1;
  }

  return { test, main, colors: C, info, msTag, okLine, skipLine, failLine, summaryLine };
}

module.exports = { createHarness, colors: C, info, msTag, okLine, skipLine, failLine, summaryLine, statusWord };
