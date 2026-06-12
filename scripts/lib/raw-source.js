// パイプライン向けのソースジェネレータ: raw JSONL ファイル / リレー / 連結。
import { SimplePool } from 'nostr-tools/pool';
import { RELAYS, timeSlices } from './relays.js';
import { cleanText } from './text.js';
import { readJsonl, appendJsonl } from './checkpoint.js';
import { log } from './log.js';

/** raw-notes.jsonl を1行ずつ読み、各ノートを yield する。ファイルが無ければ何も出さない。 */
export async function* rawFileSource(path) {
  for (const note of readJsonl(path)) {
    if (note && note.event_id) yield note;
  }
}

/** メンション/リポストのみ（実テキストが無い）か判定。 */
function isMentionOrRepostOnly(content) {
  const cleaned = cleanText(content).replace(/\s+/g, '');
  return cleaned.length === 0;
}

/** 1ページ分の bounded query（collect.js queryPage をミラー）。 */
async function queryPage(pool, relays, filter, timeoutMs) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve([]), timeoutMs + 1500);
  });
  try {
    return await Promise.race([
      pool.querySync(relays, filter, { maxWait: timeoutMs }),
      guard,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * リレーから kind:1 ノートを逐次取得して yield する（collect.js collectRaw をミラー）。
 * cfg.rawAppendPath があれば新規ノートを追記する。テストでは使われない。
 */
export async function* relaySource(cfg = {}) {
  const relays = cfg.relays && cfg.relays.length ? cfg.relays : RELAYS.slice();
  const windowDays = Number(cfg.windowDays || 120);
  const sliceDays = Number(cfg.sliceDays || 3);
  const queryLimit = Number(cfg.queryLimit || 500);
  const timeoutMs = Number(cfg.timeoutMs || 8000);
  const maxPages = Number(cfg.maxPages || 8);
  const rawPerAuthorCap = Number(cfg.rawPerAuthorCap || 25);
  const rawAppendPath = cfg.rawAppendPath;

  const slices = timeSlices({ windowDays, sliceDays });
  const pool = new SimplePool();
  const seen = new Set();
  const perAuthor = new Map();

  log.info(`relaySource: スライス数=${slices.length} リレー数=${relays.length}`);

  try {
    for (let si = 0; si < slices.length; si++) {
      const { sinceSec, untilSec } = slices[si];
      for (const relay of relays) {
        let until = untilSec;
        for (let page = 0; page < maxPages; page++) {
          const filter = { kinds: [1], since: sinceSec, until, limit: queryLimit };
          let events = [];
          try {
            events = await queryPage(pool, [relay], filter, timeoutMs);
          } catch (err) {
            log.warn(`relay query 失敗 ${relay} slice${si} page${page}: ${err?.message || err}`);
            break;
          }
          events = events || [];

          let added = 0;
          let oldest = until;
          for (const ev of events) {
            if (!ev || typeof ev.created_at !== 'number') continue;
            if (ev.created_at < sinceSec || ev.created_at > until) continue;
            if (ev.created_at < oldest) oldest = ev.created_at;

            const content = ev.content || '';
            if (!content.trim()) continue;
            if (isMentionOrRepostOnly(content)) continue;
            if (seen.has(ev.id)) continue;

            const authCount = perAuthor.get(ev.pubkey) || 0;
            if (authCount >= rawPerAuthorCap) continue;

            seen.add(ev.id);
            perAuthor.set(ev.pubkey, authCount + 1);
            added++;

            const note = {
              event_id: ev.id,
              pubkey: ev.pubkey,
              created_at: ev.created_at,
              content,
              relay: [relay],
            };
            if (rawAppendPath) {
              try { appendJsonl(rawAppendPath, note); } catch { /* ignore */ }
            }
            yield note;
          }

          log.progress(`relaySource seen=${seen.size} slice${si + 1}/${slices.length} ${relay} page${page + 1} (+${added})`);

          if (events.length < queryLimit || added === 0) break;
          const next = oldest - 1;
          if (next < sinceSec || next >= until) break;
          until = next;
        }
      }
    }
  } finally {
    try { pool.close(relays); } catch { /* ignore */ }
  }
}

/** 複数の async iterable を順に連結して yield する。 */
export async function* concatSources(...sources) {
  for (const src of sources) {
    if (!src) continue;
    for await (const item of src) {
      yield item;
    }
  }
}
