import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCliArgs, mergeExistingLabels } from '../scripts/pipeline.js';
import { PipelineState } from '../scripts/lib/pipeline-state.js';
import { LABELS } from '../scripts/lib/labels.js';

function writeLabelsJson(items) {
  const dir = mkdtempSync(join(tmpdir(), 'pipe-seed-'));
  const p = join(dir, 'gemini-labels.json');
  writeFileSync(p, JSON.stringify({ items }));
  return p;
}

describe('pipeline seed-existing-labels behavior', () => {
  it('CLI default does NOT enable seeding existing labels', () => {
    const cfg = parseCliArgs([]);
    expect(cfg.seedExistingLabels).toBe(false);
  });

  it('--seed-existing-labels opts into reuse', () => {
    const cfg = parseCliArgs(['--seed-existing-labels']);
    expect(cfg.seedExistingLabels).toBe(true);
  });

  it('default (countExisting:false) preserves existing gemini-labels.json items but does not count them', () => {
    const p = writeLabelsJson([
      { event_id: 'g1', label: LABELS[0], content: 'a' },
      { event_id: 'g2', label: LABELS[0], content: 'b' },
    ]);
    const s = new PipelineState();
    mergeExistingLabels(s, p, { countExisting: false });
    // not used as a completion seed
    expect(s.counts()[LABELS[0]]).toBe(0);
    expect(s.isComplete(1)).toBe(false);
    // preserved + deduped
    expect(s.totalLabeled()).toBe(2);
    expect(s.hasSeen('g1')).toBe(true);
    expect(s.hasSeen('g2')).toBe(true);
  });

  it('opt-in (countExisting:true) seeds completion counts from gemini-labels.json', () => {
    const p = writeLabelsJson([
      { event_id: 'g1', label: LABELS[0], content: 'a' },
      { event_id: 'g2', label: LABELS[0], content: 'b' },
    ]);
    const s = new PipelineState();
    mergeExistingLabels(s, p, { countExisting: true });
    expect(s.counts()[LABELS[0]]).toBe(2);
    // seeded label has reached its target (other labels remain below, so the
    // overall run is not yet complete — isComplete checks all 46 labels)
    expect(s.labelsBelow(2).find((b) => b.label === LABELS[0])).toBeUndefined();
  });
});
