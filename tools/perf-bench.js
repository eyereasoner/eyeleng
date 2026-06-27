#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { runToString } = require('../src/index.js');

const root = path.join(__dirname, '..');
const baselinePath = path.join(root, 'test', 'perf-baseline.json');
const DEFAULT_RELATIVE_TOLERANCE = 1.35;
const DEFAULT_ABSOLUTE_TOLERANCE_MS = 1000;

const defaultCases = [
  { name: 'deep-taxonomy-100000.srl', file: 'examples/deep-taxonomy-100000.srl', repeat: 1 },
  { name: 'fibonacci.srl', file: 'examples/fibonacci.srl', repeat: 1 },
  { name: 'fft32-numeric.srl', file: 'examples/fft32-numeric.srl', repeat: 3 },
  { name: 'path-discovery.srl', file: 'examples/path-discovery.srl', repeat: 5 },
];

function parseArgs(argv) {
  const options = {
    mode: 'check',
    json: false,
    cases: [],
    repeat: null,
    baseline: baselinePath,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.mode = 'check';
    else if (arg === '--update') options.mode = 'update';
    else if (arg === '--report') options.mode = 'report';
    else if (arg === '--json') options.json = true;
    else if (arg === '--case') {
      i += 1;
      if (i >= argv.length) throw new Error('--case requires a benchmark name or file');
      options.cases.push(argv[i]);
    } else if (arg === '--repeat') {
      i += 1;
      if (i >= argv.length) throw new Error('--repeat requires a positive integer');
      options.repeat = Number(argv[i]);
      if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error('--repeat requires a positive integer');
    } else if (arg === '--baseline') {
      i += 1;
      if (i >= argv.length) throw new Error('--baseline requires a path');
      options.baseline = path.resolve(argv[i]);
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else {
      throw new Error(`Unknown option ${arg}`);
    }
  }

  return options;
}

function help() {
  return `Usage: node tools/perf-bench.js [--check|--update|--report] [options]\n\nRuns selected large examples and checks them against test/perf-baseline.json.\nThis is intentionally separate from npm test so normal correctness tests do not\nfail because of machine-dependent timings.\n\nOptions:\n  --check             Fail if a benchmark exceeds its budget (default)\n  --update            Rewrite the baseline with the current timings\n  --report            Print timings without checking or updating\n  --json              Print JSON output\n  --case NAME         Run only a case by name or file; may be repeated\n  --repeat N          Override per-case repeat count\n  --baseline FILE     Use a different baseline file\n  -h, --help          Print this help\n\nEnvironment overrides:\n  EYELENG_BENCH_RELATIVE_TOLERANCE       default ${DEFAULT_RELATIVE_TOLERANCE}\n  EYELENG_BENCH_ABSOLUTE_TOLERANCE_MS    default ${DEFAULT_ABSOLUTE_TOLERANCE_MS}\n  EYELENG_BENCH_REPEAT                   override repeat count\n`;
}

function loadBaseline(filename) {
  if (!fs.existsSync(filename)) return null;
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function baselineCases(baseline) {
  if (!baseline || !Array.isArray(baseline.cases)) return null;
  return baseline.cases.map((item) => ({
    name: item.name,
    file: item.file,
    repeat: item.repeat || 1,
    baselineMs: item.baselineMs,
  }));
}

function selectCases(allCases, requested) {
  if (requested.length === 0) return allCases;
  return requested.map((name) => {
    const found = allCases.find((item) => item.name === name || item.file === name || path.basename(item.file) === name);
    if (!found) throw new Error(`Unknown benchmark case ${name}`);
    return found;
  });
}

function importResolver(target) {
  if (!target.startsWith('file:')) throw new Error(`benchmark import resolver only supports file: imports, got ${target}`);
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

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function roundMs(ms) {
  return Math.round(ms * 10) / 10;
}

function runCase(testCase, repeatOverride) {
  const filename = path.join(root, testCase.file);
  const source = fs.readFileSync(filename, 'utf8');
  const repeat = repeatOverride || Number(process.env.EYELENG_BENCH_REPEAT) || testCase.repeat || 1;
  const samples = [];
  let outputBytes = 0;

  for (let i = 0; i < repeat; i += 1) {
    if (global.gc) global.gc();
    const start = performance.now();
    const output = runToString(source, runOptions(filename));
    const elapsed = performance.now() - start;
    outputBytes = Buffer.byteLength(output, 'utf8');
    samples.push(elapsed);
  }

  return {
    name: testCase.name,
    file: testCase.file,
    repeat,
    samplesMs: samples.map(roundMs),
    ms: roundMs(median(samples)),
    outputBytes,
  };
}

function toleranceFromEnv(baseline = {}) {
  const fromBaseline = baseline.tolerance || {};
  const relative = Number(process.env.EYELENG_BENCH_RELATIVE_TOLERANCE || fromBaseline.relative || DEFAULT_RELATIVE_TOLERANCE);
  const absoluteMs = Number(process.env.EYELENG_BENCH_ABSOLUTE_TOLERANCE_MS || fromBaseline.absoluteMs || DEFAULT_ABSOLUTE_TOLERANCE_MS);
  if (!Number.isFinite(relative) || relative < 1) throw new Error('relative tolerance must be >= 1');
  if (!Number.isFinite(absoluteMs) || absoluteMs < 0) throw new Error('absolute tolerance must be >= 0');
  return { relative, absoluteMs };
}

function budgetFor(item, tolerance) {
  if (!Number.isFinite(item.baselineMs)) return null;
  return roundMs(item.baselineMs * tolerance.relative + tolerance.absoluteMs);
}

function printTable(results, checks) {
  const widths = {
    name: Math.max('case'.length, ...results.map((item) => item.name.length)),
    ms: Math.max('ms'.length, ...results.map((item) => String(item.ms).length)),
    budget: Math.max('budget'.length, ...checks.map((item) => item.budgetMs == null ? 1 : String(item.budgetMs).length)),
  };
  console.log(`${'case'.padEnd(widths.name)}  ${'ms'.padStart(widths.ms)}  ${'budget'.padStart(widths.budget)}  status`);
  console.log(`${'-'.repeat(widths.name)}  ${'-'.repeat(widths.ms)}  ${'-'.repeat(widths.budget)}  ------`);
  for (const item of results) {
    const check = checks.find((entry) => entry.name === item.name) || {};
    const budget = check.budgetMs == null ? '-' : String(check.budgetMs);
    const status = check.status || 'report';
    console.log(`${item.name.padEnd(widths.name)}  ${String(item.ms).padStart(widths.ms)}  ${budget.padStart(widths.budget)}  ${status}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(help());
    return;
  }

  const baseline = loadBaseline(options.baseline);
  const allCases = baselineCases(baseline) || defaultCases;
  const selected = selectCases(allCases, options.cases);
  const repeatOverride = options.repeat || null;
  const results = selected.map((testCase) => runCase(testCase, repeatOverride));
  const tolerance = toleranceFromEnv(baseline || {});

  const byBaseline = new Map((baselineCases(baseline) || []).map((item) => [item.name, item]));
  const checks = results.map((result) => {
    const baselineCase = byBaseline.get(result.name);
    const budgetMs = baselineCase ? budgetFor(baselineCase, tolerance) : null;
    const status = budgetMs == null ? 'no-baseline' : result.ms <= budgetMs ? 'ok' : 'regressed';
    return { name: result.name, baselineMs: baselineCase ? baselineCase.baselineMs : null, budgetMs, status };
  });

  if (options.mode === 'update') {
    const updated = {
      version: 1,
      generatedBy: 'npm run bench:update',
      note: 'Machine-dependent performance baseline. Use npm run bench:update to refresh intentionally.',
      tolerance,
      cases: results.map((result) => ({
        name: result.name,
        file: result.file,
        repeat: result.repeat,
        baselineMs: result.ms,
        outputBytes: result.outputBytes,
      })),
    };
    fs.mkdirSync(path.dirname(options.baseline), { recursive: true });
    fs.writeFileSync(options.baseline, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  }

  if (options.json) {
    console.log(JSON.stringify({ mode: options.mode, tolerance, results, checks }, null, 2));
  } else {
    printTable(results, checks);
    if (options.mode === 'update') console.log(`\nUpdated ${path.relative(root, options.baseline)}`);
  }

  if (options.mode === 'check') {
    const regressions = checks.filter((item) => item.status === 'regressed');
    if (regressions.length > 0) {
      console.error('\nPerformance regression detected. Run npm run bench:update only after intentionally accepting a new baseline.');
      process.exitCode = 1;
    }
  }
}

try {
  main();
} catch (err) {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
}
