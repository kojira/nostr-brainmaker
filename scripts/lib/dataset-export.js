import { basename, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readJson, readJsonl, writeJsonAtomic } from './checkpoint.js';
import { contentHash } from './text.js';

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function timestamp() {
  return new Date().toISOString();
}

function loadLabelMap(labelMapPath) {
  const doc = readJson(labelMapPath);
  if (!doc || !Array.isArray(doc.labels)) {
    throw new Error(`label_map.json を読めません: ${labelMapPath}`);
  }
  const labelToId = new Map();
  for (const entry of doc.labels) {
    if (entry && entry.char != null && entry.id != null) {
      labelToId.set(String(entry.char), Number(entry.id));
    }
  }
  if (doc.qa && doc.qa.char != null && doc.qa.id != null) {
    labelToId.set(String(doc.qa.char), Number(doc.qa.id));
  }
  return { doc, labelToId };
}

function inferSourceModel(record, fallbackModel) {
  if (typeof record?.source === 'string' && record.source.startsWith('synthetic:')) {
    return record.source.slice('synthetic:'.length) || fallbackModel || 'unknown';
  }
  if (typeof record?.source === 'string' && record.source.trim()) return record.source.trim();
  if (typeof fallbackModel === 'string' && fallbackModel.trim()) return fallbackModel.trim();
  return 'unknown';
}

function inferSource(record, sourceType, fallbackModel) {
  if (typeof record?.source === 'string' && record.source.trim()) return record.source.trim();
  const model = inferSourceModel(record, fallbackModel);
  return sourceType === 'synthetic' ? `synthetic:${model}` : model;
}

function normalizeRecord(record, {
  sourceType,
  fallbackModel,
  sourceFile,
  labelToId,
  index,
}) {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'invalid_record' };
  const content = typeof record.content === 'string' ? record.content.trim() : '';
  if (!content) return { ok: false, reason: 'missing_content' };
  const label = typeof record.label === 'string' ? record.label.trim() : '';
  if (!labelToId.has(label)) return { ok: false, reason: 'invalid_label' };
  const canonicalLabelId = labelToId.get(label);
  let eventId = typeof record.event_id === 'string' ? record.event_id.trim() : '';
  const missingEventId = !eventId;
  if (!eventId) {
    eventId = `${sourceType}-missing-${contentHash(`${label}\n${content}`)}`;
  }
  const source = inferSource(record, sourceType, fallbackModel);
  const sourceModel = inferSourceModel(record, fallbackModel);
  return {
    ok: true,
    dedupeKey: eventId,
    missingEventId,
    normalized: {
      content,
      label,
      label_id: canonicalLabelId,
      source_type: sourceType,
      event_id: eventId,
      source_model: sourceModel,
      source,
      source_file: sourceFile,
      source_record_index: index,
      created_at: Number.isFinite(Number(record.created_at)) ? Number(record.created_at) : null,
      pubkey: typeof record.pubkey === 'string' ? record.pubkey : null,
      confidence: Number.isFinite(Number(record.confidence)) ? Number(record.confidence) : null,
      rationale: typeof record.rationale === 'string' ? record.rationale : null,
      is_uncertain: record.is_uncertain === true,
      pass: Number.isFinite(Number(record.pass)) ? Number(record.pass) : null,
      verified: record.verified === true,
      synthetic: sourceType === 'synthetic' || record.synthetic === true,
    },
  };
}

function pushSourceRecords(records, docPath, sourceType, rawDoc, rawRecords) {
  const sourceFile = basename(docPath);
  rawRecords.forEach((record, index) => {
    records.push({
      record,
      sourceType,
      sourceFile,
      fallbackModel: rawDoc?.model || null,
      index,
    });
  });
}

function loadSourceRecords({ labelsDir, jsonFile, checkpointFile, sourceType }) {
  const records = [];
  const jsonPath = join(labelsDir, jsonFile);
  const checkpointPath = join(labelsDir, checkpointFile);
  const jsonDoc = readJson(jsonPath);
  const checkpointRows = readJsonl(checkpointPath)
    .filter((row) => row && row.ok === true)
    .map((row) => {
      const { ok, ...rest } = row;
      return rest;
    });

  if (jsonDoc && Array.isArray(jsonDoc.items)) {
    pushSourceRecords(records, jsonPath, sourceType, jsonDoc, jsonDoc.items);
  }
  if (checkpointRows.length > 0) {
    pushSourceRecords(records, checkpointPath, sourceType, jsonDoc, checkpointRows);
  }
  return {
    jsonPath,
    checkpointPath,
    jsonPresent: !!jsonDoc,
    checkpointPresent: checkpointRows.length > 0,
    records,
  };
}

export function buildTrainingDataset({
  labelMap,
  realRecords,
  syntheticRecords,
}) {
  const merged = new Map();
  const summary = {
    total_count: 0,
    source_type_counts: { real: 0, synthetic: 0 },
    label_counts: {},
    input_counts: { real: realRecords.length, synthetic: syntheticRecords.length },
    skipped_records: {
      invalid_record: 0,
      missing_content: 0,
      invalid_label: 0,
    },
    duplicate_event_ids_overwritten: 0,
    missing_event_ids_assigned: 0,
  };

  const allRecords = [...realRecords, ...syntheticRecords];
  for (const item of allRecords) {
    const normalized = normalizeRecord(item.record, {
      sourceType: item.sourceType,
      fallbackModel: item.fallbackModel,
      sourceFile: item.sourceFile,
      labelToId: labelMap.labelToId,
      index: item.index,
    });
    if (!normalized.ok) {
      summary.skipped_records[normalized.reason] = (summary.skipped_records[normalized.reason] || 0) + 1;
      continue;
    }
    if (normalized.missingEventId) summary.missing_event_ids_assigned += 1;
    if (merged.has(normalized.dedupeKey)) summary.duplicate_event_ids_overwritten += 1;
    merged.set(normalized.dedupeKey, normalized.normalized);
  }

  const rows = [...merged.values()].sort((a, b) => {
    const tA = a.created_at ?? Number.MAX_SAFE_INTEGER;
    const tB = b.created_at ?? Number.MAX_SAFE_INTEGER;
    if (tA !== tB) return tA - tB;
    return a.event_id.localeCompare(b.event_id);
  });

  for (const row of rows) {
    summary.total_count += 1;
    summary.source_type_counts[row.source_type] += 1;
    const key = row.label;
    const counts = summary.label_counts[key] || {
      label: row.label,
      label_id: row.label_id,
      real: 0,
      synthetic: 0,
      total: 0,
    };
    counts[row.source_type] += 1;
    counts.total += 1;
    summary.label_counts[key] = counts;
  }

  return {
    rows,
    summary: {
      ...summary,
      label_counts: Object.values(summary.label_counts).sort((a, b) => a.label_id - b.label_id),
    },
  };
}

export function exportTrainingDataset({
  dataDir = 'data/production',
  outDir = join(dataDir, 'training'),
} = {}) {
  const labelsDir = join(dataDir, 'labels');
  const labelMapPath = join(dataDir, 'label_map.json');
  const labelMap = loadLabelMap(labelMapPath);
  const real = loadSourceRecords({
    labelsDir,
    jsonFile: 'gemini-labels.json',
    checkpointFile: 'checkpoint.jsonl',
    sourceType: 'real',
  });
  const synthetic = loadSourceRecords({
    labelsDir,
    jsonFile: 'synthetic-labels.json',
    checkpointFile: 'synthetic-checkpoint.jsonl',
    sourceType: 'synthetic',
  });

  const built = buildTrainingDataset({
    labelMap,
    realRecords: real.records,
    syntheticRecords: synthetic.records,
  });

  const absOutDir = resolve(outDir);
  ensureDir(absOutDir);
  const datasetPath = join(absOutDir, 'dataset.jsonl');
  const summaryPath = join(absOutDir, 'summary.json');
  const manifestPath = join(absOutDir, 'manifest.json');

  const datasetJsonl = built.rows.map((row) => JSON.stringify(row)).join('\n');
  writeFileSync(datasetPath, datasetJsonl ? `${datasetJsonl}\n` : '', 'utf8');

  const generatedAt = timestamp();
  const summary = {
    generated_at: generatedAt,
    data_dir: resolve(dataDir),
    dataset_path: resolve(datasetPath),
    ...built.summary,
  };
  const manifest = {
    generated_at: generatedAt,
    label_map: {
      path: resolve(labelMapPath),
      version: labelMap.doc.version || null,
      count: labelMap.doc.count || null,
    },
    inputs: {
      real: {
        json: resolve(real.jsonPath),
        checkpoint: resolve(real.checkpointPath),
        records_seen: real.records.length,
        json_present: real.jsonPresent,
        checkpoint_present: real.checkpointPresent,
      },
      synthetic: {
        json: resolve(synthetic.jsonPath),
        checkpoint: resolve(synthetic.checkpointPath),
        records_seen: synthetic.records.length,
        json_present: synthetic.jsonPresent,
        checkpoint_present: synthetic.checkpointPresent,
      },
    },
    outputs: {
      dataset: resolve(datasetPath),
      summary: resolve(summaryPath),
      manifest: resolve(manifestPath),
    },
    counts: {
      total: summary.total_count,
      real: summary.source_type_counts.real,
      synthetic: summary.source_type_counts.synthetic,
      duplicate_event_ids_overwritten: summary.duplicate_event_ids_overwritten,
      missing_event_ids_assigned: summary.missing_event_ids_assigned,
    },
  };

  writeJsonAtomic(summaryPath, summary);
  writeJsonAtomic(manifestPath, manifest);

  return {
    datasetPath: resolve(datasetPath),
    summaryPath: resolve(summaryPath),
    manifestPath: resolve(manifestPath),
    summary,
    manifest,
  };
}
