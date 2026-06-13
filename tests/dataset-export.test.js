import { describe, it, expect } from 'vitest';
import { buildLabelMap } from '../scripts/lib/labels.js';
import { buildTrainingDataset } from '../scripts/lib/dataset-export.js';

function sourceRecord(record, sourceType, sourceFile, fallbackModel = null, index = 0) {
  return { record, sourceType, sourceFile, fallbackModel, index };
}

describe('dataset-export', () => {
  it('merges real + synthetic records, overwriting duplicate event_id with later records', () => {
    const labelMap = {
      doc: buildLabelMap(),
      labelToId: new Map([
        ...buildLabelMap().labels.map((entry) => [entry.char, entry.id]),
        [buildLabelMap().qa.char, buildLabelMap().qa.id],
      ]),
    };
    const built = buildTrainingDataset({
      labelMap,
      realRecords: [
        sourceRecord({
          event_id: 'dup-1',
          content: '最初のラベル',
          label: '愛',
          label_id: 0,
          source: 'gemini-old',
          created_at: 10,
        }, 'real', 'gemini-labels.json', 'gemini-old', 0),
        sourceRecord({
          content: '欠番でも書き出す',
          label: '猫',
          source: 'gemini-old',
          created_at: 11,
        }, 'real', 'gemini-labels.json', 'gemini-old', 1),
      ],
      syntheticRecords: [
        sourceRecord({
          event_id: 'dup-1',
          content: 'checkpoint が勝つ',
          label: '欲',
          label_id: 1,
          source: 'gemini-new',
          created_at: 12,
        }, 'real', 'checkpoint.jsonl', 'gemini-new', 0),
        sourceRecord({
          event_id: 'syn-1',
          content: '合成データ',
          label: '犬',
          source: 'synthetic:gemini-synth',
          synthetic: true,
          created_at: 13,
        }, 'synthetic', 'synthetic-checkpoint.jsonl', 'gemini-synth', 0),
        sourceRecord({
          event_id: 'bad',
          content: 'これは落とす',
          label: '存在しない',
          created_at: 14,
        }, 'synthetic', 'synthetic-checkpoint.jsonl', 'gemini-synth', 1),
      ],
    });

    expect(built.rows).toHaveLength(3);
    expect(built.rows.find((row) => row.event_id === 'dup-1')).toMatchObject({
      content: 'checkpoint が勝つ',
      label: '欲',
      label_id: 1,
      source_type: 'real',
      source_model: 'gemini-new',
      source_file: 'checkpoint.jsonl',
    });
    expect(built.rows.find((row) => row.label === '猫').event_id).toMatch(/^real-missing-/);
    expect(built.rows.find((row) => row.event_id === 'syn-1')).toMatchObject({
      source_type: 'synthetic',
      source_model: 'gemini-synth',
      synthetic: true,
    });
    expect(built.summary.total_count).toBe(3);
    expect(built.summary.source_type_counts).toEqual({ real: 2, synthetic: 1 });
    expect(built.summary.duplicate_event_ids_overwritten).toBe(1);
    expect(built.summary.missing_event_ids_assigned).toBe(1);
    expect(built.summary.skipped_records.invalid_label).toBe(1);
  });
});
