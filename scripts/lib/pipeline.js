// オーケストレータ: source を逐次取り込み、言語/重複でフィルタし、ワーカーでラベリング。
import { AsyncQueue, QUEUE_DONE } from './async-queue.js';
import { PipelineState } from './pipeline-state.js';
import { detectJapanese } from './japanese.js';
import { Counters } from './log.js';

/**
 * パイプライン本体。
 * @returns {Promise<{state, stats, complete}>}
 */
export async function runPipeline({
  source,
  labelItem,
  state,
  stats = new Counters(),
  minPerLabel = 50,
  concurrency = 5,
  detect = detectJapanese,
  highWaterMark = 200,
  hooks = {},
} = {}) {
  if (!source) throw new Error('runPipeline: source is required');
  if (typeof labelItem !== 'function') throw new Error('runPipeline: labelItem is required');
  if (!(state instanceof PipelineState)) throw new Error('runPipeline: state (PipelineState) is required');

  const queue = new AsyncQueue({ highWaterMark });

  // PRODUCER。
  const producer = (async () => {
    try {
      for await (const note of source) {
        if (state.isComplete(minPerLabel)) break;
        stats.inc('raw_fetched');

        const det = detect(note.content);
        if (!det.isJapanese) {
          stats.inc('language_excluded');
          continue;
        }
        stats.inc('language_pass');

        if (state.hasSeen(note.event_id)) {
          stats.inc('dedup_skipped');
          continue;
        }
        state.markSeen(note.event_id);
        stats.inc('queued');
        await queue.push(note);
        hooks.onProgress?.({ stats, queueSize: queue.size, state });
      }
    } finally {
      queue.close();
    }
  })();

  // WORKERS。
  const workerCount = Math.max(1, Math.floor(concurrency));
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push((async () => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const note = await queue.pull();
        if (note === QUEUE_DONE) return;
        const res = await labelItem(note);
        if (res && res.ok) {
          state.recordLabeled(res.labeled);
          stats.inc('label_success');
          hooks.onLabeled?.({ event_id: res.labeled.event_id, ok: true, ...res.labeled });
        } else {
          stats.inc('label_failure');
          hooks.onFailure?.(res?.failure);
          hooks.onLabeled?.({ event_id: note.event_id, ok: false, reason: res?.failure?.reason });
        }
        hooks.onProgress?.({ stats, queueSize: queue.size, state });
      }
    })());
  }

  await Promise.all([producer, ...workers]);
  return { state, stats, complete: state.isComplete(minPerLabel) };
}
