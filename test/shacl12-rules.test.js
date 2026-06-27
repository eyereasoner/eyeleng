#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { colors: C, info, summaryLine } = require('./harness.js');
const {
  defaultShacl12RulesManifestUrl,
  isLikelyNetworkError,
  isW3cRequired,
  runShacl12RulesManifest,
  formatShacl12RulesProgressLine,
  writeShacl12RulesEarlReport,
} = require('../src/shacl12RulesManifest.js');

const rootManifestUrl = process.env.EYELENG_SHACL12_RULES_MANIFEST || defaultShacl12RulesManifestUrl;

function appendSummary(summary) {
  const file = process.env.EYELENG_TEST_SUMMARY_FILE;
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(summary)}\n`, 'utf8');
}

async function main() {
  const suiteStart = Date.now();
  info('W3C SHACL 1.2 Rules');
  console.log(`${C.dim}manifest: ${rootManifestUrl}${C.n}`);

  let result;
  try {
    result = await runShacl12RulesManifest(rootManifestUrl, {
      onProgress(item, index) {
        console.log(formatShacl12RulesProgressLine(item, index, { colors: C }));
      },
    });
  } catch (err) {
    if (isLikelyNetworkError(err) && !isW3cRequired()) {
      console.log(`${C.dim}W3C SHACL 1.2 Rules manifests not reachable; EYELENG_W3C_REQUIRED=0 permits this skip.${C.n}`);
      appendSummary({ section: 'W3C SHACL 1.2 Rules', passed: 1, failed: 0, total: 1, ms: Date.now() - suiteStart });
      return;
    }
    console.error(err.stack || err.message || String(err));
    appendSummary({ section: 'W3C SHACL 1.2 Rules', passed: 0, failed: 1, total: 1, ms: Date.now() - suiteStart });
    process.exitCode = 1;
    return;
  }

  try {
    const reportPath = writeShacl12RulesEarlReport(result);
    console.log(`${C.dim}EARL report: ${path.relative(path.join(__dirname, '..'), reportPath)}${C.n}`);
  } catch (err) {
    console.error(`Failed to write SHACL Rules EARL report: ${err.message}`);
    result.counts.fail += 1;
  }

  for (const section of result.bySection) {
    summaryLine(section.failed === 0 ? 'ok' : 'fail', section.passed, section.total, null, { label: section.section });
  }
  summaryLine(result.counts.fail === 0 ? 'ok' : 'fail', result.counts.pass, result.counts.total, result.durationMs);
  console.log('');

  appendSummary({
    section: 'W3C SHACL 1.2 Rules',
    passed: result.counts.pass,
    failed: result.counts.fail,
    skipped: result.counts.skip,
    total: result.counts.total,
    ms: result.durationMs,
  });
  if (result.counts.fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
