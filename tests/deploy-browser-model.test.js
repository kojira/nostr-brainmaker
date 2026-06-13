import { describe, it, expect } from 'vitest';
import {
  parseDeployArgs,
  resolveModelArtifact,
  expectedAssets,
  looksLikeCheckpoint,
  summarizeVerification,
  DEFAULT_OPSET,
} from '../scripts/lib/deploy-browser-model.js';

describe('parseDeployArgs', () => {
  it('parses the run-dir positional and defaults to q8 production mode', () => {
    const o = parseDeployArgs(['finetune_smoke/train-output/run-x']);
    expect(o.runDir).toBe('finetune_smoke/train-output/run-x');
    expect(o.mode).toBe('q8');
    expect(o.skipExport).toBe(false);
    expect(o.dryRun).toBe(false);
    expect(o.opset).toBe(DEFAULT_OPSET);
    expect(o.python).toBeNull();
  });

  it('parses flags in any order (--dev-q4 is a non-production dev mode)', () => {
    const o = parseDeployArgs(['--dev-q4', 'run-x', '--skip-export', '--opset', '17', '--python', 'python3.11', '--dry-run']);
    expect(o.runDir).toBe('run-x');
    expect(o.mode).toBe('q4');
    expect(o.skipExport).toBe(true);
    expect(o.opset).toBe(17);
    expect(o.python).toBe('python3.11');
    expect(o.dryRun).toBe(true);
  });

  it('--q8 overrides an earlier --dev-fp32 back to production for clarity', () => {
    expect(parseDeployArgs(['--dev-fp32', '--q8', 'r']).mode).toBe('q8');
  });

  it('sets help and tolerates a missing run-dir', () => {
    expect(parseDeployArgs(['--help']).help).toBe(true);
    expect(parseDeployArgs([]).runDir).toBeNull();
  });

  it('throws on unknown flags and non-integer opset', () => {
    expect(() => parseDeployArgs(['--nope'])).toThrow(/unknown option/);
    expect(() => parseDeployArgs(['--opset', 'x', 'r'])).toThrow(/opset/);
  });
});

describe('resolveModelArtifact', () => {
  // Production path: q8 only. onnx/model_quantized.onnx served as dtype 'q8'.
  it('defaults to the q8 production model with dtype q8', () => {
    expect(resolveModelArtifact({ quantizedExists: true }))
      .toEqual({ modelFile: 'onnx/model_quantized.onnx', dtype: 'q8' });
    expect(resolveModelArtifact({ mode: 'q8', quantizedExists: true }))
      .toEqual({ modelFile: 'onnx/model_quantized.onnx', dtype: 'q8' });
  });

  it('throws when the production q8 model is missing (no fp32/q4 fallback)', () => {
    expect(() => resolveModelArtifact({ mode: 'q8', quantizedExists: false })).toThrow(/model_quantized\.onnx/);
  });

  // Non-production dev modes below — reachable only via explicit --dev-* flags.
  it('points at the 4-bit model with dtype q4 (dev only)', () => {
    expect(resolveModelArtifact({ mode: 'q4', q4Exists: true }))
      .toEqual({ modelFile: 'onnx/model_q4.onnx', dtype: 'q4' });
  });

  it('throws when dev q4 requested but not produced', () => {
    expect(() => resolveModelArtifact({ mode: 'q4', q4Exists: false }))
      .toThrow(/model_q4\.onnx/);
  });

  it('points at the fp32 model with dtype fp32 (dev only)', () => {
    expect(resolveModelArtifact({ mode: 'fp32', fp32Exists: true }))
      .toEqual({ modelFile: 'onnx/model.onnx', dtype: 'fp32' });
  });

  it('throws when dev fp32 model is missing', () => {
    expect(() => resolveModelArtifact({ mode: 'fp32', fp32Exists: false })).toThrow(/model\.onnx/);
  });
});

describe('expectedAssets', () => {
  it('lists the full q8 production runtime asset set as required', () => {
    const a = expectedAssets();
    expect(a.required).toContain('manifest.json');
    expect(a.required).toContain('config.json');
    expect(a.required).toContain('label_map.json');
    expect(a.required).toContain('special_tokens_map.json');
    expect(a.required).toContain('onnx/model_quantized.onnx');
    expect(a.required).toContain('tokenizer.json');
    expect(a.required).toContain('tokenizer_config.json');
    expect(a.required).toContain('onnx/config.json');
    expect(a.recommended).toEqual([]);
  });

  it('threads a custom (non-production dev) model file into required', () => {
    expect(expectedAssets({ modelFile: 'onnx/model_q4.onnx' }).required)
      .toContain('onnx/model_q4.onnx');
  });
});

describe('looksLikeCheckpoint', () => {
  it('accepts safetensors or pytorch_model.bin with a config', () => {
    expect(looksLikeCheckpoint(['config.json', 'model.safetensors', 'tokenizer.json'])).toBe(true);
    expect(looksLikeCheckpoint(['config.json', 'pytorch_model.bin'])).toBe(true);
  });

  it('rejects dirs missing weights or config', () => {
    expect(looksLikeCheckpoint(['config.json'])).toBe(false);
    expect(looksLikeCheckpoint(['model.safetensors'])).toBe(false);
    expect(looksLikeCheckpoint([])).toBe(false);
  });
});

describe('summarizeVerification', () => {
  const assets = expectedAssets();

  it('ok when every required file is present', () => {
    const present = new Set([...assets.required, ...assets.recommended]);
    const r = summarizeVerification(assets, (f) => present.has(f));
    expect(r.ok).toBe(true);
    expect(r.missingRequired).toEqual([]);
    expect(r.missingRecommended).toEqual([]);
  });

  it('not ok and lists the missing required file', () => {
    const present = new Set(assets.required.filter((f) => f !== 'onnx/model_quantized.onnx'));
    const r = summarizeVerification(assets, (f) => present.has(f));
    expect(r.ok).toBe(false);
    expect(r.missingRequired).toContain('onnx/model_quantized.onnx');
  });

  it('stays ok but reports missing recommended files', () => {
    const present = new Set(assets.required);
    const r = summarizeVerification(assets, (f) => present.has(f));
    expect(r.ok).toBe(true);
    expect(r.missingRecommended).toEqual([]);
  });
});
