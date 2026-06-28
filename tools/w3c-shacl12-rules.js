#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { colors: C } = require('../test/harness.js');
const {
  defaultShacl12RulesManifestUrl,
  runShacl12RulesManifest,
  formatShacl12RulesProgressLine,
  formatShacl12RulesManifestResult,
  writeShacl12RulesEarlReport,
  defaultReportPath,
} = require('../src/shacl12RulesManifest.js');

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  return argv[index + 1] || null;
}

function loggerForMode({ json, earl }) {
  // Keep stdout machine-readable or empty in output modes. Progress still stays visible.
  return json || earl ? console.error : console.log;
}

async function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const earl = argv.includes('--earl');
  const noReport = argv.includes('--no-report');
  const quiet = argv.includes('--quiet');
  const output = argValue(argv, '--output') || defaultReportPath();
  const log = loggerForMode({ json, earl });
  const manifests = argv.filter((arg, index) => {
    if (arg.startsWith('--')) return false;
    if (argv[index - 1] === '--output') return false;
    return true;
  });
  const manifest = manifests[0] || process.env.EYELENG_SHACL12_RULES_MANIFEST || defaultShacl12RulesManifestUrl;

  if (!quiet) log(`${C.y}==${C.n} W3C SHACL 1.2 Rules manifest: ${manifest}`);
  const result = await runShacl12RulesManifest(manifest, {
    onProgress(item, index) {
      if (!quiet) log(formatShacl12RulesProgressLine(item, index, { colors: C }));
    },
  });

  if (!noReport) {
    const reportPath = writeShacl12RulesEarlReport(result, output);
    if (!quiet) log(`${C.dim}EARL report: ${path.relative(path.join(__dirname, '..'), reportPath)}${C.n}`);
  }

  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (!earl) process.stdout.write(`${formatShacl12RulesManifestResult(result, { colors: C })}\n`);
  return result.counts.fail === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
