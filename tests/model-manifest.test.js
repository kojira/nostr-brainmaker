import { describe, it, expect } from 'vitest';
import labelMapData from '../data/production/label_map.json';
import { buildBrowserManifest } from '../scripts/lib/model-manifest.js';
import { validateManifest } from '../src/classifier/manifest.js';

describe('buildBrowserManifest', () => {
  it('builds a valid manifest with inline label map', () => {
    const m = buildBrowserManifest({
      labelMap: labelMapData,
      files: { model: 'onnx/model_q4.onnx' },
      dtype: 'q4',
    });
    expect(validateManifest(m).ok).toBe(true);
    expect(m.model.files.model).toBe('onnx/model_q4.onnx');
    expect(m.model.dtype).toBe('q4');
    expect(m.model.numLabels).toBe(47);
    expect(m.schemaVersion).toBe(1);
  });

  it('builds a valid manifest from run metadata with metrics mapping', () => {
    const m = buildBrowserManifest({
      runMetadata: { model: 'ruri-v3-pt-30m', results: { eval_accuracy: 0.8 } },
    });
    expect(validateManifest(m).ok).toBe(true);
    expect(m.model.name).toBe('ruri-v3-pt-30m');
    expect(m.labelMapPath).toBeTruthy();
    expect(m.labelMap).toBeUndefined();
    expect(m.metrics.accuracy).toBe(0.8);
  });

  it('defaults to the transformers.js layout with the q4 production model', () => {
    const m = buildBrowserManifest({ labelMap: labelMapData });
    expect(m.model.runtime).toBe('transformers.js');
    // Production browser model is the 4-bit weight-only artifact.
    expect(m.model.files.model).toBe('onnx/model_q4.onnx');
    expect(validateManifest(m).ok).toBe(true);
  });

  it('threads runtime, files, and dtype options through', () => {
    // Non-production alternative: int8 q8 model_quantized.onnx (dev only).
    const m = buildBrowserManifest({
      labelMap: labelMapData,
      runtime: 'onnx',
      files: { model: 'onnx/model_quantized.onnx' },
      dtype: 'q8',
    });
    expect(m.model.runtime).toBe('onnx');
    expect(m.model.files.model).toBe('onnx/model_quantized.onnx');
    expect(m.model.dtype).toBe('q8');
    expect(validateManifest(m).ok).toBe(true);
  });
});
