import { describe, it, expect } from 'vitest';
import { validateManifest, loadManifest } from '../src/classifier/manifest.js';

function goodManifest() {
  return {
    schemaVersion: 1,
    model: {
      name: 'ruri-v3-pt-30m-1char',
      runtime: 'onnx',
      files: { model: 'model.onnx', tokenizer: 'tokenizer.json' },
      maxLength: 256,
      numLabels: 47,
    },
    labelMapPath: 'label_map.json',
  };
}

describe('validateManifest', () => {
  it('accepts a good manifest', () => {
    expect(validateManifest(goodManifest()).ok).toBe(true);
  });

  it('rejects missing schemaVersion', () => {
    const m = goodManifest();
    delete m.schemaVersion;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('rejects wrong runtime', () => {
    const m = goodManifest();
    m.model.runtime = 'tensorflow';
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('rejects missing files.model', () => {
    const m = goodManifest();
    delete m.model.files.model;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('rejects missing both labelMap and labelMapPath', () => {
    const m = goodManifest();
    delete m.labelMapPath;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('rejects non-integer maxLength', () => {
    const m = goodManifest();
    m.model.maxLength = 12.5;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe('loadManifest', () => {
  it('returns present:false when fetch is not ok', async () => {
    const res = await loadManifest({ fetchImpl: async () => ({ ok: false }) });
    expect(res.present).toBe(false);
  });

  it('returns present:true with a valid manifest', async () => {
    const m = goodManifest();
    const res = await loadManifest({ fetchImpl: async () => ({ ok: true, json: async () => m }) });
    expect(res.present).toBe(true);
    expect(res.manifest).toEqual(m);
  });

  it('returns present:false with error when fetch throws', async () => {
    const res = await loadManifest({
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    expect(res.present).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('returns present:false with error for an invalid manifest', async () => {
    const res = await loadManifest({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
    expect(res.present).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
