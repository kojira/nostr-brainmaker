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
  it('parses the run-dir positional and defaults', () => {
    const o = parseDeployArgs(['finetune_smoke/train-output/run-x']);
    expect(o.runDir).toBe('finetune_smoke/train-output/run-x');
    expect(o.quantize).toBe(false);
    expect(o.skipExport).toBe(false);
    expect(o.dryRun).toBe(false);
    expect(o.opset).toBe(DEFAULT_OPSET);
    expect(o.python).toBeNull();
  });

  it('parses flags in any order', () => {
    const o = parseDeployArgs(['--quantize', 'run-x', '--skip-export', '--opset', '17', '--python', 'python3.11', '--dry-run']);
    expect(o.runDir).toBe('run-x');
    expect(o.quantize).toBe(true);
    expect(o.skipExport).toBe(true);
    expect(o.opset).toBe(17);
    expect(o.python).toBe('python3.11');
    expect(o.dryRun).toBe(true);
  });

  it('--fp32 overrides an earlier --quantize for clarity', () => {
    expect(parseDeployArgs(['--quantize', '--fp32', 'r']).quantize).toBe(false);
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
  it('defaults to fp32 with no dtype hint', () => {
    expect(resolveModelArtifact({ fp32Exists: true })).toEqual({ modelFile: 'onnx/model.onnx', dtype: null });
  });

  it('points at the quantized model with dtype q8', () => {
    expect(resolveModelArtifact({ quantize: true, quantizedExists: true }))
      .toEqual({ modelFile: 'onnx/model_quantized.onnx', dtype: 'q8' });
  });

  it('throws when quantized requested but not produced', () => {
    expect(() => resolveModelArtifact({ quantize: true, quantizedExists: false }))
      .toThrow(/model_quantized\.onnx/);
  });

  it('throws when fp32 model is missing', () => {
    expect(() => resolveModelArtifact({ fp32Exists: false })).toThrow(/model\.onnx/);
  });
});

describe('expectedAssets', () => {
  it('lists the full fp32 runtime asset set as required', () => {
    const a = expectedAssets();
    expect(a.required).toContain('manifest.json');
    expect(a.required).toContain('config.json');
    expect(a.required).toContain('label_map.json');
    expect(a.required).toContain('special_tokens_map.json');
    expect(a.required).toContain('onnx/model.onnx');
    expect(a.required).toContain('tokenizer.json');
    expect(a.required).toContain('tokenizer_config.json');
    expect(a.required).toContain('onnx/config.json');
    expect(a.recommended).toEqual([]);
  });

  it('threads a custom (quantized) model file into required', () => {
    expect(expectedAssets({ modelFile: 'onnx/model_quantized.onnx' }).required)
      .toContain('onnx/model_quantized.onnx');
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
    const present = new Set(assets.required.filter((f) => f !== 'onnx/model.onnx'));
    const r = summarizeVerification(assets, (f) => present.has(f));
    expect(r.ok).toBe(false);
    expect(r.missingRequired).toContain('onnx/model.onnx');
  });

  it('stays ok but reports missing recommended files', () => {
    const present = new Set(assets.required);
    const r = summarizeVerification(assets, (f) => present.has(f));
    expect(r.ok).toBe(true);
    expect(r.missingRecommended).toEqual([]);
  });
});
