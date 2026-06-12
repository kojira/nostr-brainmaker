import { describe, it, expect } from 'vitest';
import { PipelineState } from '../scripts/lib/pipeline-state.js';
import { buildPipelineReport, renderProgress, aggregate } from '../scripts/lib/pipeline-report.js';
import { LABELS, QA_LABEL, labelIdOf } from '../scripts/lib/labels.js';
import { Counters } from '../scripts/lib/log.js';

function rec(event_id, label, ok = true, extra = {}) {
  if (!ok) return { ok: false, event_id, reason: 'transport' };
  return {
    ok: true,
    event_id,
    pubkey: `pk-${event_id}`,
    created_at: 1700000000,
    content: `c-${event_id}`,
    label,
    label_id: labelIdOf(label),
    confidence: 0.9,
    rationale: 'x',
    is_uncertain: false,
    pass: 1,
    source: 'fake',
    ...extra,
  };
}

describe('pipeline-report', () => {
  const records = [
    rec('e1', LABELS[0]),
    rec('e2', LABELS[0]),
    rec('e3', LABELS[1]),
    rec('e4', QA_LABEL, true, { label_id: 46 }),
    rec('e5', null, false),
  ];

  it('buildPipelineReport returns correct counts and flags', () => {
    const state = PipelineState.fromCheckpoint(records);
    const stats = new Counters();
    stats.inc('raw_fetched', 5);
    const report = buildPipelineReport({ state, stats, minPerLabel: 2, model: 'm' });
    expect(report.total_labeled).toBe(4); // 3 target + 1 QA
    expect(report.label_counts[LABELS[0]]).toBe(2);
    expect(report.label_counts[LABELS[1]]).toBe(1);
    expect(report.qa_counts[QA_LABEL]).toBe(1);
    // LABELS[0] satisfied at min 2; everything else below
    expect(report.labels_below_target.find((b) => b.label === LABELS[0])).toBeUndefined();
    expect(report.labels_below_count).toBe(45);
    expect(report.complete).toBe(false);
    expect(report.model).toBe('m');
    expect(report.stats.raw_fetched).toBe(5);
  });

  it('aggregate returns a PipelineState', () => {
    const state = aggregate(records);
    expect(state).toBeInstanceOf(PipelineState);
    expect(state.totalLabeled()).toBe(4);
  });

  it('renderProgress includes key numbers', () => {
    const state = PipelineState.fromCheckpoint(records);
    const stats = new Counters();
    stats.inc('raw_fetched', 7);
    stats.inc('language_pass', 6);
    stats.inc('label_success', 4);
    const s = renderProgress({ state, stats, minPerLabel: 2, queueSize: 3 });
    expect(typeof s).toBe('string');
    expect(s).toContain('total_labeled=4');
    expect(s).toContain('raw_fetched=7');
    expect(s).toContain('language_pass=6');
    expect(s).toContain('label_success=4');
    expect(s).toContain('queue=3');
    expect(s).toContain('labels_below_target(2)=45');
  });
});
