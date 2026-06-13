#!/usr/bin/env node
// Build public/models/1char/manifest.json from a training run's metadata and the
// production label map.
//
// Usage:
//   node scripts/build-model-manifest.js <train-output-run-dir> [options]
//
// Options:
//   --runtime <r>        'transformers.js' (default) or 'onnx'
//   --model-file <p>     model path relative to public/models/1char/
//                        (default 'onnx/model.onnx')
//   --tokenizer-file <p> tokenizer path (default 'tokenizer.json')
//   --dtype <d>          optional backend hint, e.g. 'q8' for an int8 model
//
// NOTE: this only writes the manifest. The actual ONNX model + tokenizer binaries
// must be exported/copied into public/models/1char/ separately — they are gitignored
// and never committed. See finetune_smoke/export_onnx.py for the export path.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBrowserManifest } from './lib/model-manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseArgs(argv) {
  const out = { _: [], options: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      out.options[a.slice(2)] = argv[i + 1];
      i++;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function main() {
  const { _: positionals, options } = parseArgs(process.argv.slice(2));
  const runDir = positionals[0];
  if (!runDir) {
    console.error('usage: node scripts/build-model-manifest.js <train-output-run-dir> [options]');
    process.exit(1);
  }

  let runMetadata = {};
  const metaPath = join(runDir, 'run_metadata.json');
  if (existsSync(metaPath)) {
    try {
      runMetadata = readJson(metaPath);
    } catch (err) {
      console.error(`warning: could not parse ${metaPath}: ${err.message}`);
    }
  } else {
    console.error(`warning: ${metaPath} not found; proceeding without run metadata`);
  }

  const labelMapPath = join(REPO_ROOT, 'data/production/label_map.json');
  if (!existsSync(labelMapPath)) {
    console.error(`error: label map not found at ${labelMapPath}`);
    process.exit(1);
  }
  const labelMap = readJson(labelMapPath);

  const files = {};
  if (options['model-file']) files.model = options['model-file'];
  if (options['tokenizer-file']) files.tokenizer = options['tokenizer-file'];

  const manifest = buildBrowserManifest({
    runMetadata,
    labelMap,
    files,
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.dtype ? { dtype: options.dtype } : {}),
  });

  const outDir = join(REPO_ROOT, 'public/models/1char');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'manifest.json');
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`wrote ${outPath}`);
  console.log(`  model:     ${manifest.model.name}`);
  console.log(`  runtime:   ${manifest.model.runtime}`);
  console.log(`  numLabels: ${manifest.model.numLabels}`);
  console.log(`  modelFile: ${manifest.model.files.model}`);
  console.log('');
  console.log('reminder: the ONNX model + tokenizer binaries referenced by this manifest');
  console.log('must be exported/copied into public/models/1char/ separately. They are');
  console.log('gitignored and never committed. Run finetune_smoke/export_onnx.py first.');
}

try {
  main();
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
