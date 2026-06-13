import { describe, it, expect } from 'vitest';
import labelMapData from '../data/production/label_map.json';
import { buildBrowserManifest } from '../scripts/lib/model-manifest.js';
import { validateManifest } from '../src/classifier/manifest.js';

describe('buildBrowserManifest', () => {
  it('builds a valid manifest with inline label map', () => {
    const m = buildBrowserManifest({ labelMap: labelMapData, files: { model: 'model.onnx' } });
    expect(validateManifest(m).ok).toBe(true);
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

  it('defaults to the transformers.js layout', () => {
    const m = buildBrowserManifest({ labelMap: labelMapData });
    expect(m.model.runtime).toBe('transformers.js');
    expect(m.model.files.model).toBe('onnx/model.onnx');
    expect(m.model.dtype).toBeUndefined();
    expect(validateManifest(m).ok).toBe(true);
  });

  it('threads runtime, files, and dtype options through', () => {
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
