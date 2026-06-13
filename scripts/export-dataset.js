#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { exportTrainingDataset } from './lib/dataset-export.js';

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'data-dir': { type: 'string', default: 'data/production' },
      'out-dir': { type: 'string' },
    },
    allowPositionals: false,
  });
  return {
    dataDir: values['data-dir'],
    outDir: values['out-dir'] || join(values['data-dir'], 'training'),
  };
}

async function main() {
  const cfg = parseCliArgs(process.argv.slice(2));
  const result = exportTrainingDataset(cfg);
  process.stdout.write(`dataset:  ${result.datasetPath}\n`);
  process.stdout.write(`summary:  ${result.summaryPath}\n`);
  process.stdout.write(`manifest: ${result.manifestPath}\n`);
  process.stdout.write(`total:    ${result.summary.total_count}\n`);
  process.stdout.write(`real:     ${result.summary.source_type_counts.real}\n`);
  process.stdout.write(`synthetic:${result.summary.source_type_counts.synthetic}\n`);
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err)}\n`);
  process.exit(1);
});
