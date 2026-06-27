#!/usr/bin/env node
'use strict';

const { colors: C } = require('../test/harness.js');
const {
  defaultW3cRdfManifestUrls,
  runW3cRdfManifests,
  formatW3cRdfProgressLine,
  formatW3cRdfManifestsResult,
  rdfManifestsToEarl,
} = require('../src/rdfManifest.js');

async function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const earl = argv.includes('--earl');
  const quiet = json || earl || argv.includes('--quiet');
  const manifests = argv.filter((arg) => !arg.startsWith('--'));
  const resources = manifests.length ? manifests : defaultW3cRdfManifestUrls;
  const result = await runW3cRdfManifests(resources, {
    onManifestStart(resource, index, total) {
      if (!quiet) console.log(`${C.y}==${C.n} W3C RDF manifest ${index + 1}/${total}: ${resource}`);
    },
    onProgress(item, index) {
      if (!quiet) console.log(formatW3cRdfProgressLine(item, index, { colors: C }));
    },
  });
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (earl) process.stdout.write(`${rdfManifestsToEarl(result, { assertedBy: '<https://github.com/eyereasoner/eyeleng>' })}\n`);
  else process.stdout.write(`${formatW3cRdfManifestsResult(result, { colors: C })}\n`);
  return result.counts.fail === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
