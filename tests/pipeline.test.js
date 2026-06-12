import { describe, it, expect } from 'vitest';
import { runPipeline } from '../scripts/lib/pipeline.js';
import { PipelineState } from '../scripts/lib/pipeline-state.js';
import { LABELS, labelIdOf } from '../scripts/lib/labels.js';

// 決定的な言語判定: 'EN:' 始まりは非日本語扱い。
const fakeDetect = (c) => ({ isJapanese: !String(c).startsWith('EN:') });

// content から決定的にラベルを割り当てる labelItem ファクトリ。
function makeFakeLabeler(labelOf) {
  return async (note) => {
    const label = labelOf(note);
    return {
      ok: true,
      labeled: {
        event_id: note.event_id,
        pubkey: note.pubkey,
        created_at: note.created_at,
        content: note.content,
        label,
        label_id: labelIdOf(label),
        confidence: 0.9,
        rationale: 'x',
        is_uncertain: false,
        pass: 1,
        source: 'fake',
      },
    };
  };
}

function mkNote(id, content, label) {
  return { event_id: id, pubkey: `pk-${id}`, created_at: 1700000000, content, _label: label };
}

describe('runPipeline', () => {
  it('(a) excludes non-Japanese notes and never labels them', async () => {
    const notes = [
      mkNote('j1', 'これは日本語', LABELS[0]),
      mkNote('e1', 'EN: hello world', LABELS[1]),
      mkNote('e2', 'EN: another', LABELS[2]),
    ];
    const labeled = [];
    const state = new PipelineState();
    const res = await runPipeline({
      source: notes,
      labelItem: makeFakeLabeler((n) => n._label),
      state,
      minPerLabel: 1000, // never complete early
      concurrency: 2,
      detect: fakeDetect,
      hooks: { onLabeled: (rec) => labeled.push(rec) },
    });
    expect(res.stats.get('language_excluded')).toBe(2);
    expect(res.stats.get('language_pass')).toBe(1);
    expect(state.totalLabeled()).toBe(1);
    expect(labeled.map((r) => r.event_id)).toEqual(['j1']);
    // none of the excluded ids labeled
    expect(labeled.some((r) => r.event_id.startsWith('e'))).toBe(false);
  });

  it('(b) dedups duplicate event_ids', async () => {
    const notes = [
      mkNote('d1', 'あ', LABELS[0]),
      mkNote('d1', 'あ', LABELS[0]), // duplicate id
      mkNote('d2', 'い', LABELS[1]),
    ];
    const state = new PipelineState();
    const res = await runPipeline({
      source: notes,
      labelItem: makeFakeLabeler((n) => n._label),
      state,
      minPerLabel: 1000,
      concurrency: 3,
      detect: fakeDetect,
    });
    expect(res.stats.get('dedup_skipped')).toBe(1);
    expect(state.totalLabeled()).toBe(2);
  });

  it('(c) does not relabel pre-seeded events', async () => {
    const state = new PipelineState();
    // pre-seed s1 with LABELS[3]
    state.recordLabeled({
      event_id: 's1', pubkey: 'pk', created_at: 1, content: 'seed',
      label: LABELS[3], label_id: labelIdOf(LABELS[3]), confidence: 0.9,
      rationale: 'x', is_uncertain: false, pass: 1, source: 'seed',
    });
    const notes = [
      mkNote('s1', 'あ', LABELS[0]), // seeded -> must be skipped
      mkNote('new1', 'い', LABELS[1]),
    ];
    const labeled = [];
    const res = await runPipeline({
      source: notes,
      labelItem: makeFakeLabeler((n) => n._label),
      state,
      minPerLabel: 1000,
      concurrency: 2,
      detect: fakeDetect,
      hooks: { onLabeled: (rec) => labeled.push(rec) },
    });
    expect(res.stats.get('dedup_skipped')).toBe(1);
    // s1 retains its seeded label LABELS[3], not relabeled to LABELS[0]
    expect(state.labeledByEvent.get('s1').label).toBe(LABELS[3]);
    expect(labeled.map((r) => r.event_id)).toEqual(['new1']);
    expect(state.totalLabeled()).toBe(2);
  });

  it('(d) completes when every label reaches min', async () => {
    const min = 2;
    const notes = [];
    let n = 0;
    // 2 notes per label across all 46 labels
    for (let rep = 0; rep < min; rep++) {
      for (let i = 0; i < LABELS.length; i++) {
        notes.push(mkNote(`c${n++}`, 'あ', LABELS[i]));
      }
    }
    const state = new PipelineState();
    const res = await runPipeline({
      source: notes,
      labelItem: makeFakeLabeler((nt) => nt._label),
      state,
      minPerLabel: min,
      concurrency: 5,
      detect: fakeDetect,
    });
    expect(res.complete).toBe(true);
    const counts = state.counts();
    for (const l of LABELS) expect(counts[l]).toBeGreaterThanOrEqual(min);
  });

  it('(e) does not cap/discard items above min (no-cap)', async () => {
    const min = 2;
    const notes = [];
    // 10 notes all for LABELS[0], placed first
    for (let i = 0; i < 10; i++) notes.push(mkNote(`a${i}`, 'あ', LABELS[0]));
    const state = new PipelineState();
    const labeled = [];
    const res = await runPipeline({
      source: notes,
      labelItem: makeFakeLabeler((n) => n._label),
      state,
      minPerLabel: min,
      concurrency: 1, // deterministic: all 10 queued/labeled before producer stops
      detect: fakeDetect,
      hooks: { onLabeled: (rec) => labeled.push(rec) },
    });
    // every labeled record looks right
    expect(labeled.length).toBe(state.totalLabeled());
    for (const r of labeled) {
      expect(r.ok).toBe(true);
      expect(r.label).toBe(LABELS[0]);
    }
    // no discarding: label_success equals totalLabeled (no seeding)
    expect(res.stats.get('label_success')).toBe(state.totalLabeled());
    // the single label exceeds min (not capped at 2)
    expect(state.counts()[LABELS[0]]).toBeGreaterThan(min);
  });
});
