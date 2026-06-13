// Browser model manifest schema + loader. Pure logic plus an injectable fetch.

export const MANIFEST_SCHEMA_VERSION = 1;
export const DEFAULT_MODEL_BASE = 'models/1char/';

export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') {
    return { ok: false, errors: ['manifest is not an object'] };
  }
  if (m.schemaVersion !== 1) {
    errors.push('schemaVersion must be 1');
  }
  if (!m.model || typeof m.model !== 'object') {
    errors.push('model must be an object');
  } else {
    const model = m.model;
    if (model.runtime !== 'onnx' && model.runtime !== 'transformers.js') {
      errors.push("model.runtime must be 'onnx' or 'transformers.js'");
    }
    if (!model.files || typeof model.files !== 'object') {
      errors.push('model.files must be an object');
    } else if (typeof model.files.model !== 'string' || model.files.model.length === 0) {
      errors.push('model.files.model must be a non-empty string');
    }
    if (!Number.isInteger(model.maxLength) || model.maxLength <= 0) {
      errors.push('model.maxLength must be an integer > 0');
    }
    if (!Number.isInteger(model.numLabels) || model.numLabels <= 0) {
      errors.push('model.numLabels must be an integer > 0');
    }
  }
  const hasInlineMap = m.labelMap && typeof m.labelMap === 'object';
  const hasMapPath = typeof m.labelMapPath === 'string' && m.labelMapPath.length > 0;
  if (!hasInlineMap && !hasMapPath) {
    errors.push('either labelMap (object) or labelMapPath (non-empty string) is required');
  }
  if (errors.length) {
    return { ok: false, errors };
  }
  return { ok: true, manifest: m };
}

export async function loadManifest({ basePath = DEFAULT_MODEL_BASE, baseUrl = '/', fetchImpl = fetch } = {}) {
  const url = baseUrl + basePath + 'manifest.json';
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      return { present: false };
    }
    const json = await res.json();
    const validated = validateManifest(json);
    if (!validated.ok) {
      return { present: false, error: validated.errors.join('; ') };
    }
    return { present: true, manifest: validated.manifest, basePath, baseUrl };
  } catch (err) {
    return { present: false, error: String(err) };
  }
}

export async function loadLabelMap(loaded, { fetchImpl = fetch } = {}) {
  if (loaded.manifest.labelMap && typeof loaded.manifest.labelMap === 'object') {
    return loaded.manifest.labelMap;
  }
  const url = loaded.baseUrl + loaded.basePath + loaded.manifest.labelMapPath;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error('failed to load label map: ' + url);
  }
  return res.json();
}
