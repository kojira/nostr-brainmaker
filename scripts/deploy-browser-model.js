#!/usr/bin/env node
// Operator-friendly, end-to-end deploy of a trained 1-char classifier run into the
// browser model directory (public/models/1char/). One command drives the whole flow:
//
//   1. validate the trained run-dir (the deploy is BLOCKED without one),
//   2. export ONNX + tokenizer with finetune_smoke/export_onnx.py (skippable),
//   3. build manifest.json with scripts/build-model-manifest.js,
//   4. verify every file the browser fetches at runtime actually landed.
//
// Usage (run from the repo root):
//   node scripts/deploy-browser-model.js <train-output-run-dir> [options]
//   npm run model:deploy -- <train-output-run-dir> [options]
//
// Production is q4-only: by default this exports the fp32 model (needed as the
// quantizer input) then the 4-bit weight-only model, and deploys the q4 artifact
// (manifest dtype 'q4', model.files.model -> onnx/model_q4.onnx). There is no
// fp32/q8 production fallback — a missing q4 artifact is a hard error.
//
// Options:
//   --q4             export + deploy the 4-bit model (the production default)
//   --dev-q8         DEV ONLY: deploy the int8 model (manifest dtype q8,
//                    model.files.model -> onnx/model_quantized.onnx)
//   --dev-fp32       DEV ONLY: deploy the unquantized fp32 model
//   --skip-export    skip export_onnx.py; assume assets are already in the out dir
//                    (just (re)build the manifest and verify)
//   --opset <n>      ONNX opset for the export (default 14)
//   --python <bin>   python executable for the export. Resolution order:
//                    --python, then $PYTHON, then
//                    finetune_smoke/.venv-export/bin/python (if it exists),
//                    then python3.
//   --dry-run        print the plan (every command) and exit; touch nothing
//   -h, --help       show this help
//
// NOTE: the ONNX/tokenizer binaries written under public/models/1char/ are
// gitignored and never committed — only the README + manifest.example.json are
// tracked. This script produces those local-only binaries; it does not commit.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseDeployArgs,
  resolveModelArtifact,
  expectedAssets,
  looksLikeCheckpoint,
  summarizeVerification,
} from './lib/deploy-browser-model.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const OUT_DIR = join(REPO_ROOT, 'public/models/1char');
const EXPORT_SCRIPT = join(REPO_ROOT, 'finetune_smoke/export_onnx.py');
const MANIFEST_SCRIPT = join(REPO_ROOT, 'scripts/build-model-manifest.js');
const VENV_EXPORT_PYTHON = join(REPO_ROOT, 'finetune_smoke/.venv-export/bin/python');

// Choose the python interpreter for the ONNX export step. Resolution order:
//   1. --python <bin>            (explicit override)
//   2. $PYTHON                   (env override)
//   3. finetune_smoke/.venv-export/bin/python, if it exists (known-good export
//      env on this Mac: Python 3.13; the system python3 is 3.9, too old for
//      onnxruntime 1.20.1 which needs Python >=3.10)
//   4. "python3"                 (fallback)
function resolveExportPython(optsPython) {
  if (optsPython) return optsPython;
  if (process.env.PYTHON) return process.env.PYTHON;
  if (existsSync(VENV_EXPORT_PYTHON)) return VENV_EXPORT_PYTHON;
  return 'python3';
}

const HELP = `deploy-browser-model — export + manifest + verify a trained run into public/models/1char/

  node scripts/deploy-browser-model.js <train-output-run-dir> [options]
  npm run model:deploy -- <train-output-run-dir> [options]

Options:
  --q4             export + deploy the 4-bit model (manifest dtype q4; default)
  --dev-q8         DEV ONLY: deploy the int8 model (manifest dtype q8)
  --dev-fp32       DEV ONLY: deploy the unquantized fp32 model
  --skip-export    skip the ONNX export; just (re)build manifest + verify
  --opset <n>      ONNX opset for the export (default 14)
  --python <bin>   python executable for the export. Resolution order:
                   --python > $PYTHON > finetune_smoke/.venv-export/bin/python
                   (if present) > python3
  --dry-run        print the plan and exit
  -h, --help       show this help

Blocker: a trained run-dir (HF checkpoint: config.json + model.safetensors) must
exist. There is none committed in this repo — produce one with
finetune_smoke/train_production.py first. Exported binaries stay gitignored.`;

function logStep(n, msg) {
  console.log(`\n[deploy] step ${n}: ${msg}`);
}

// Run a child command, streaming its output. Returns the exit code (0 = ok).
function run(cmd, args, label) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit' });
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      console.error(`error: ${label}: command not found: ${cmd}`);
      return 127;
    }
    console.error(`error: ${label}: ${res.error.message}`);
    return 1;
  }
  return res.status == null ? 1 : res.status;
}

function fail(msg, code = 1) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

function main() {
  let opts;
  try {
    opts = parseDeployArgs(process.argv.slice(2));
  } catch (err) {
    fail(err.message);
  }

  if (opts.help) {
    console.log(HELP);
    return;
  }
  if (!opts.runDir) {
    console.error(HELP);
    process.exit(1);
  }

  const python = resolveExportPython(opts.python);
  const runDirAbs = join(REPO_ROOT, opts.runDir);
  const mode = opts.mode === 'q8'
    ? 'int8 quantized — DEV ONLY (dtype q8)'
    : opts.mode === 'fp32'
      ? 'unquantized — DEV ONLY (fp32)'
      : '4-bit weight-only (dtype q4)';

  // ---- step 1: validate the run-dir (the blocker) -------------------------
  logStep(1, `validate run-dir (${opts.runDir})`);
  if (!existsSync(runDirAbs) || !statSync(runDirAbs).isDirectory()) {
    fail(
      `run-dir not found: ${opts.runDir}\n`
      + '  A trained checkpoint must exist before deploying. None is committed in\n'
      + '  this repo — produce one with finetune_smoke/train_production.py, e.g.:\n'
      + '    python3 finetune_smoke/train_production.py \\\n'
      + '      --output-dir finetune_smoke/train-output/run-$(date +%Y%m%d-%H%M%S)',
      2,
    );
  }
  const runDirFiles = readdirSync(runDirAbs);
  if (!opts.skipExport && !looksLikeCheckpoint(runDirFiles)) {
    fail(
      `run-dir does not look like a trained HF checkpoint: ${opts.runDir}\n`
      + '  Expected config.json + model.safetensors (or pytorch_model.bin).\n'
      + `  Found: ${runDirFiles.join(', ') || '(empty)'}\n`
      + '  Re-run training, or pass --skip-export if the ONNX assets are already exported.',
      2,
    );
  }
  console.log(`  ok — deploying as: ${mode}`);

  // ---- plan the commands --------------------------------------------------
  // The fp32 export always runs (it is the input the quantizer reads); for q4/q8
  // we additionally ask export_onnx.py to emit the quantized artifact.
  const exportArgs = [EXPORT_SCRIPT, '--run-dir', opts.runDir, '--opset', String(opts.opset)];
  if (opts.mode === 'q4') exportArgs.push('--q4');
  else if (opts.mode === 'q8') exportArgs.push('--quantize');

  if (opts.dryRun) {
    console.log('\n[deploy] --dry-run: planned commands (nothing executed):');
    if (opts.skipExport) {
      console.log('  (export skipped via --skip-export)');
    } else {
      console.log(`  $ ${python} ${exportArgs.join(' ')}`);
    }
    const plannedModel = opts.mode === 'q8'
      ? 'onnx/model_quantized.onnx'
      : opts.mode === 'fp32'
        ? 'onnx/model.onnx'
        : 'onnx/model_q4.onnx';
    const plannedDtype = opts.mode === 'q8' ? 'q8' : opts.mode === 'fp32' ? 'fp32' : 'q4';
    const manifestArgs = [MANIFEST_SCRIPT, opts.runDir, '--dtype', plannedDtype, '--model-file', plannedModel];
    console.log(`  $ node ${manifestArgs.join(' ')}`);
    console.log('  then verify required files under public/models/1char/:');
    for (const f of expectedAssets({ modelFile: plannedModel }).required) {
      console.log(`    - ${f}`);
    }
    return;
  }

  // ---- step 2: export ONNX ------------------------------------------------
  if (opts.skipExport) {
    logStep(2, 'export ONNX — SKIPPED (--skip-export)');
  } else {
    logStep(2, `export ONNX via ${python} export_onnx.py`);
    const code = run(python, exportArgs, 'ONNX export');
    if (code === 2) {
      fail(
        'ONNX export dependencies are missing. Install them and retry:\n'
        + '    pip install -r finetune_smoke/requirements-export.txt',
        2,
      );
    }
    if (code !== 0) fail(`ONNX export failed (exit ${code})`, code);
  }

  // ---- decide which artifact the manifest points at -----------------------
  const q4Exists = existsSync(join(OUT_DIR, 'onnx/model_q4.onnx'));
  const fp32Exists = existsSync(join(OUT_DIR, 'onnx/model.onnx'));
  const quantizedExists = existsSync(join(OUT_DIR, 'onnx/model_quantized.onnx'));
  let artifact;
  try {
    artifact = resolveModelArtifact({ mode: opts.mode, q4Exists, fp32Exists, quantizedExists });
  } catch (err) {
    fail(err.message);
  }

  // ---- step 3: build the manifest -----------------------------------------
  logStep(3, `build manifest -> ${artifact.modelFile}${artifact.dtype ? ` (dtype ${artifact.dtype})` : ''}`);
  const manifestArgs = [MANIFEST_SCRIPT, opts.runDir, '--model-file', artifact.modelFile];
  if (artifact.dtype) manifestArgs.push('--dtype', artifact.dtype);
  const mcode = run('node', manifestArgs, 'manifest build');
  if (mcode !== 0) fail(`manifest build failed (exit ${mcode})`, mcode);

  // ---- step 4: verify the browser asset set -------------------------------
  logStep(4, 'verify browser assets in public/models/1char/');
  const assets = expectedAssets({ modelFile: artifact.modelFile });
  const report = summarizeVerification(assets, (f) => existsSync(join(OUT_DIR, f)));
  for (const r of report.required) console.log(`  [${r.present ? ' ok ' : 'MISS'}] ${r.file}`);
  for (const r of report.recommended) console.log(`  [${r.present ? ' ok ' : 'warn'}] ${r.file} (recommended)`);

  if (report.missingRecommended.length) {
    console.log(`\n  note: missing recommended files: ${report.missingRecommended.join(', ')}`);
    console.log('  transformers.js may still work, but check the export copied the tokenizer/label map.');
  }
  if (!report.ok) {
    fail(
      `deploy incomplete — missing required files: ${report.missingRequired.join(', ')}\n`
      + '  Re-run the export (without --skip-export) so the binaries land in public/models/1char/.',
    );
  }

  console.log('\n[deploy] done. public/models/1char/ now has the manifest + binaries the browser fetches.');
  console.log('  The model/tokenizer binaries are gitignored and must NOT be committed.');
  console.log('  Verify locally with:  npm run dev   (then load a profile)');
}

try {
  main();
} catch (err) {
  fail(err.message);
}
