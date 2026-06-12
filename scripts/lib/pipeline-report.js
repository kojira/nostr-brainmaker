// パイプラインの集計とレポート生成。
import { LABELS } from './labels.js';
import { PipelineState } from './pipeline-state.js';

/** checkpoint レコード列から PipelineState を構築して返す。 */
export function aggregate(records, { labels = LABELS } = {}) {
  return PipelineState.fromCheckpoint(records, { labels });
}

/**
 * checkpoint からの集計サマリ。state と派生数値を返す。
 */
export function aggregateFromCheckpoint(records, { labels = LABELS } = {}) {
  const state = PipelineState.fromCheckpoint(records, { labels });
  return {
    state,
    counts: state.counts(),
    qa: state.qaCounts(),
    total: state.totalLabeled(),
    labelsBelow: (min) => state.labelsBelow(min),
  };
}

/** JSON 直列化可能なパイプラインレポートを構築する。 */
export function buildPipelineReport({ state, stats, minPerLabel, model }) {
  const below = state.labelsBelow(minPerLabel);
  return {
    generated_at_unix: Math.floor(Date.now() / 1000),
    min_per_label: minPerLabel,
    total_labeled: state.totalLabeled(),
    label_counts: state.counts(),
    qa_counts: state.qaCounts(),
    labels_below_target: below,
    labels_below_count: below.length,
    complete: state.isComplete(minPerLabel),
    stats: stats?.snapshot?.() ?? {},
    model,
  };
}

/** 人間可読の進捗文字列を返す。 */
export function renderProgress({ state, stats, minPerLabel, queueSize }) {
  const snap = stats?.snapshot?.() ?? {};
  const below = state.labelsBelow(minPerLabel);
  const lowest10 = below.slice(0, 10).map((b) => `${b.label}:${b.count}`).join(' ');
  const lines = [
    `total_labeled=${state.totalLabeled()}`,
    `raw_fetched=${snap.raw_fetched ?? 0} language_pass=${snap.language_pass ?? 0} language_excluded=${snap.language_excluded ?? 0}`,
    `dedup_skipped=${snap.dedup_skipped ?? 0} queued=${snap.queued ?? 0} queue=${queueSize ?? 0}`,
    `label_success=${snap.label_success ?? 0} label_failure=${snap.label_failure ?? 0}`,
    `labels_below_target(${minPerLabel})=${below.length}`,
    `lowest10: ${lowest10}`,
  ];
  return lines.join('\n');
}
