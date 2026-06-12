import { describe, it, expect } from 'vitest';
import { PipelineState } from '../scripts/lib/pipeline-state.js';
import { LABELS, QA_LABEL, labelIdOf } from '../scripts/lib/labels.js';

function mkLabeled(event_id, label, extra = {}) {
  return {
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

describe('PipelineState', () => {
  it('counts() has all 46 labels at 0 initially', () => {
    const s = new PipelineState();
    const c = s.counts();
    expect(Object.keys(c).length).toBe(46);
    expect(Object.keys(c)).toEqual(LABELS);
    for (const l of LABELS) expect(c[l]).toBe(0);
    expect(s.totalLabeled()).toBe(0);
  });

  it('recordLabeled increments the right label', () => {
    const s = new PipelineState();
    s.recordLabeled(mkLabeled('e1', LABELS[0]));
    s.recordLabeled(mkLabeled('e2', LABELS[0]));
    s.recordLabeled(mkLabeled('e3', LABELS[5]));
    expect(s.counts()[LABELS[0]]).toBe(2);
    expect(s.counts()[LABELS[5]]).toBe(1);
    expect(s.totalLabeled()).toBe(3);
    expect(s.hasSeen('e1')).toBe(true);
  });

  it('relabel moves count from old to new label', () => {
    const s = new PipelineState();
    s.recordLabeled(mkLabeled('e1', LABELS[0]));
    expect(s.counts()[LABELS[0]]).toBe(1);
    s.recordLabeled(mkLabeled('e1', LABELS[1]));
    expect(s.counts()[LABELS[0]]).toBe(0);
    expect(s.counts()[LABELS[1]]).toBe(1);
    expect(s.totalLabeled()).toBe(1);
  });

  it('QA label does not count toward completion', () => {
    const s = new PipelineState();
    s.recordLabeled(mkLabeled('e1', QA_LABEL, { label_id: 46 }));
    expect(s.counts()[LABELS[0]]).toBe(0);
    expect(s.qaCounts()[QA_LABEL]).toBe(1);
    expect(s.totalLabeled()).toBe(1);
    // QA does not satisfy any target label
    expect(s.isComplete(1)).toBe(false);
  });

  it('fromCheckpoint applies last-ok-wins and marks seen', () => {
    const records = [
      mkLabeled('e1', LABELS[0]).event_id ? { ok: true, ...mkLabeled('e1', LABELS[0]) } : null,
      { ok: true, ...mkLabeled('e1', LABELS[2]) }, // relabel -> last wins
      { ok: false, event_id: 'e2', reason: 'transport' },
    ].filter(Boolean);
    const s = PipelineState.fromCheckpoint(records);
    expect(s.counts()[LABELS[0]]).toBe(0);
    expect(s.counts()[LABELS[2]]).toBe(1);
    expect(s.totalLabeled()).toBe(1);
    expect(s.hasSeen('e1')).toBe(true);
    // ok:false also marked seen (won't be relabeled)
    expect(s.hasSeen('e2')).toBe(true);
  });

  it('labelsBelow / isComplete respect min', () => {
    const s = new PipelineState();
    s.recordLabeled(mkLabeled('e1', LABELS[0]));
    s.recordLabeled(mkLabeled('e2', LABELS[0]));
    const below = s.labelsBelow(2);
    // LABELS[0] has 2 -> not below; all others (45) below
    expect(below.length).toBe(45);
    expect(below.find((b) => b.label === LABELS[0])).toBeUndefined();
    // ascending by count
    for (let i = 1; i < below.length; i++) {
      expect(below[i].count).toBeGreaterThanOrEqual(below[i - 1].count);
    }
    expect(s.isComplete(2)).toBe(false);
    expect(s.isComplete(0)).toBe(true);
  });

  it('fromCheckpoint with countExisting:false does NOT seed completion counts (fresh run)', () => {
    const records = [
      { ok: true, ...mkLabeled('e1', LABELS[0]) },
      { ok: true, ...mkLabeled('e2', LABELS[0]) },
      { ok: false, event_id: 'e3', reason: 'transport' },
    ];
    const s = PipelineState.fromCheckpoint(records, { countExisting: false });
    // completion counts start at zero — existing artifacts are not a seed
    expect(s.counts()[LABELS[0]]).toBe(0);
    expect(s.isComplete(1)).toBe(false);
    // but items are preserved for output and ids are deduped (non-destructive)
    expect(s.totalLabeled()).toBe(2);
    expect(s.hasSeen('e1')).toBe(true);
    expect(s.hasSeen('e2')).toBe(true);
    expect(s.hasSeen('e3')).toBe(true);
    expect(s.labeledByEvent.get('e1').label).toBe(LABELS[0]);
  });

  it('fromCheckpoint default (countExisting:true) DOES seed completion counts (opt-in reuse)', () => {
    const records = [
      { ok: true, ...mkLabeled('e1', LABELS[0]) },
      { ok: true, ...mkLabeled('e2', LABELS[0]) },
    ];
    const s = PipelineState.fromCheckpoint(records, { countExisting: true });
    expect(s.counts()[LABELS[0]]).toBe(2);
    // seeded label has reached its target (other labels remain below, so the
    // overall run is not yet complete — isComplete checks all 46 labels)
    expect(s.labelsBelow(2).find((b) => b.label === LABELS[0])).toBeUndefined();
  });

  it('seedLabeled(countExisting:false) preserves + dedups without counting; fresh labels still count', () => {
    const s = new PipelineState();
    s.seedLabeled(mkLabeled('e1', LABELS[0]), { countExisting: false });
    expect(s.counts()[LABELS[0]]).toBe(0);
    expect(s.totalLabeled()).toBe(1);
    expect(s.hasSeen('e1')).toBe(true);
    // a real (this-run) label still counts toward the target
    s.recordLabeled(mkLabeled('e2', LABELS[0]));
    expect(s.counts()[LABELS[0]]).toBe(1);
  });
});
