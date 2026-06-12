#!/usr/bin/env node
// 収集 CLI: 複数リレーから kind:1 日本語ノートを集め、フィルタ/サンプリングして承認集合に。
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimplePool } from 'nostr-tools/pool';
import { RELAYS, timeSlices } from './lib/relays.js';
import { cleanText, contentHash } from './lib/text.js';
import { detectJapanese } from './lib/japanese.js';
import { buildLabelMap } from './lib/labels.js';
import { appendJsonl, readJsonl, writeJsonAtomic } from './lib/checkpoint.js';
import { log, Counters } from './lib/log.js';

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'raw-target': { type: 'string', default: '7000' },
      'target': { type: 'string', default: '2000' },
      'per-author-cap': { type: 'string', default: '10' },
      'raw-per-author-cap': { type: 'string', default: '25' },
      'window-days': { type: 'string', default: '45' },
      'slice-days': { type: 'string', default: '3' },
      'query-limit': { type: 'string', default: '500' },
      'relays': { type: 'string' },
      'out-dir': { type: 'string', default: 'data/production' },
      'timeout-ms': { type: 'string', default: '8000' },
      'max-pages': { type: 'string', default: '8' },
      'resume': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  return {
    rawTarget: Number(values['raw-target']),
    target: Number(values['target']),
    perAuthorCap: Number(values['per-author-cap']),
    rawPerAuthorCap: Number(values['raw-per-author-cap']),
    windowDays: Number(values['window-days']),
    sliceDays: Number(values['slice-days']),
    queryLimit: Number(values['query-limit']),
    relays: values['relays'] ? values['relays'].split(',').map((s) => s.trim()).filter(Boolean) : RELAYS.slice(),
    outDir: values['out-dir'],
    timeoutMs: Number(values['timeout-ms']),
    maxPages: Number(values['max-pages']),
    resume: values['resume'],
    dryRun: values['dry-run'],
  };
}

/** 1ページ分の bounded query（src/nostr.js queryPage をミラー）。 */
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

/** メンション/リポストのみ（実テキストが無い）か判定。 */
function isMentionOrRepostOnly(content) {
  const cleaned = cleanText(content).replace(/\s+/g, '');
  // clean 後（URL/nostr/npub除去後）に文字が残らないなら中身なし。
  if (cleaned.length === 0) return true;
  return false;
}

/** スパム/低品質ヒューリスティック。理由配列を返す（空なら問題なし）。 */
function spamReasons(content) {
  const reasons = [];
  const urlCount = (String(content).match(/https?:\/\/\S+/g) || []).length;
  const hashCount = (String(content).match(/[#＃][^\s#＃]+/g) || []).length;
  const cleanLen = cleanText(content).trim().length;
  if (urlCount > 2) reasons.push('too_many_urls');
  if (hashCount > 5) reasons.push('too_many_hashtags');
  if (cleanLen < 4) reasons.push('too_short_after_clean');
  // アフィリエイト/宣伝ボイラープレートの簡易検出。
  if (/(アフィリエイト|期間限定|今すぐ|クリック|登録はこちら|無料登録|稼げる|副業で|\bPR\b|\[PR\]|【PR】)/i.test(content)) {
    reasons.push('promo_boilerplate');
  }
  return reasons;
}

async function collectRaw(cfg, existingIds) {
  const slices = timeSlices({ windowDays: cfg.windowDays, sliceDays: cfg.sliceDays });
  const pool = new SimplePool();
  const rawMap = new Map(); // event_id -> { event_id, pubkey, created_at, content, relay:Set }
  const perAuthor = new Map(); // pubkey -> count (raw)
  const counters = new Counters();

  // resume: 既存 raw をマップに読み込む。
  for (const ev of existingIds.values()) {
    rawMap.set(ev.event_id, { ...ev, relay: new Set(ev.relay || []) });
    perAuthor.set(ev.pubkey, (perAuthor.get(ev.pubkey) || 0) + 1);
  }

  log.info(`スライス数: ${slices.length}, リレー数: ${cfg.relays.length}, raw目標: ${cfg.rawTarget}`);

  try {
    outer:
    for (let si = 0; si < slices.length; si++) {
      const { sinceSec, untilSec } = slices[si];
      for (const relay of cfg.relays) {
        let until = untilSec;
        for (let page = 0; page < cfg.maxPages; page++) {
          const filter = { kinds: [1], since: sinceSec, until, limit: cfg.queryLimit };
          let events = [];
          try {
            events = await queryPage(pool, [relay], filter, cfg.timeoutMs);
          } catch (err) {
            log.warn(`relay query 失敗 ${relay} slice${si} page${page}: ${err?.message || err}`);
            break; // このリレー/スライスは諦めて次へ。
          }
          events = events || [];

          let added = 0;
          let oldest = until;
          for (const ev of events) {
            if (!ev || typeof ev.created_at !== 'number') continue;
            if (ev.created_at < sinceSec || ev.created_at > until) continue;
            if (ev.created_at < oldest) oldest = ev.created_at;

            const content = ev.content || '';
            if (!content.trim()) { counters.inc('skipped_empty'); continue; }
            if (isMentionOrRepostOnly(content)) { counters.inc('skipped_mention_only'); continue; }

            const existing = rawMap.get(ev.id);
            if (existing) {
              existing.relay.add(relay);
              continue;
            }
            // raw per-author cap。
            const authCount = perAuthor.get(ev.pubkey) || 0;
            if (authCount >= cfg.rawPerAuthorCap) { counters.inc('skipped_author_cap'); continue; }

            rawMap.set(ev.id, {
              event_id: ev.id,
              pubkey: ev.pubkey,
              created_at: ev.created_at,
              content,
              relay: new Set([relay]),
            });
            perAuthor.set(ev.pubkey, authCount + 1);
            added++;
          }

          log.progress(`raw=${rawMap.size} slice${si + 1}/${slices.length} ${relay} page${page + 1} (+${added})`);

          if (rawMap.size >= cfg.rawTarget) break outer;
          if (events.length < cfg.queryLimit || added === 0) break;
          const next = oldest - 1;
          if (next < sinceSec || next >= until) break;
          until = next;
        }
      }
    }
  } finally {
    try { pool.close(cfg.relays); } catch { /* ignore */ }
  }

  return { rawMap, counters };
}

/** フィルタ + 多様性サンプリングを行い、samples 配列と report 用集計を返す。 */
export function filterAndSample(rawList, cfg) {
  const counters = new Counters();
  const lang = { franc_jpn: 0, franc_und: 0, franc_other: 0 };

  // a. 近似重複除去（contentHash、最古を代表として残す）。
  const byHash = new Map(); // hash -> representative item
  const hashFreq = new Map(); // hash -> count（ボイラープレート検出用）
  for (const item of rawList) {
    const h = contentHash(item.content);
    hashFreq.set(h, (hashFreq.get(h) || 0) + 1);
    const rep = byHash.get(h);
    if (!rep) {
      // relay は raw 由来（配列 or Set どちらもありうる）なので Set に正規化。
      byHash.set(h, { ...item, relay: new Set(item.relay || []), _hash: h, _dupCount: 1, _authors: new Set([item.pubkey]) });
    } else {
      rep._dupCount += 1;
      rep._authors.add(item.pubkey);
      // 代表は最古（created_at 最小）。relay をマージ。
      for (const r of item.relay || []) rep.relay.add(r);
      if (item.created_at < rep.created_at) {
        rep.created_at = item.created_at;
        rep.event_id = item.event_id;
        rep.pubkey = item.pubkey;
        rep.content = item.content;
      }
    }
  }
  counters.set('after_event_dedup', rawList.length);
  counters.set('after_content_dedup', byHash.size);

  const classified = []; // {item, status, reasons}
  for (const rep of byHash.values()) {
    const reasons = [];
    let status = 'approved';

    // 近似重複の代表で、重複が多数（複数著者にまたがる）ならボイラープレート疑い。
    if (rep._dupCount > 1) reasons.push('near_dup_representative');
    if (rep._dupCount >= 5 && rep._authors.size >= 3) {
      reasons.push('boilerplate_high_freq');
      status = 'review';
    }

    // b. 言語判定。
    const det = detectJapanese(rep.content);
    if (det.francLang === 'jpn') lang.franc_jpn += 1;
    else if (det.francLang === 'und') lang.franc_und += 1;
    else lang.franc_other += 1;

    if (!det.isJapanese) {
      counters.inc('language_excluded');
      classified.push({ item: rep, status: 'excluded', reasons: [det.excludeReason || 'not_japanese'] });
      continue;
    }
    if (det.reasons.includes('borderline')) {
      reasons.push('borderline_language');
      status = 'review';
    }

    // c. スパム/低品質。
    const sr = spamReasons(rep.content);
    if (sr.length) {
      counters.inc('spam_excluded');
      // 強い宣伝/URLスパムは除外、軽度はレビュー。
      if (sr.includes('promo_boilerplate') || sr.includes('too_many_urls')) {
        classified.push({ item: rep, status: 'excluded', reasons: sr });
        continue;
      }
      reasons.push(...sr);
      status = 'review';
    }

    if (rep._dupCount > 1 && status === 'approved') {
      // 近似重複代表は念のためレビュー扱い。
      status = 'review';
    }

    classified.push({ item: rep, status, reasons });
  }

  // d. 多様性サンプリング: approved 候補を著者ごとにラウンドロビンで採用。
  //    target に満たなければ review 候補からバックフィルする（excluded は決して採用しない）。
  //    著者ごと上限（authorTaken）と採用数（state.count）は両プールで共有し、
  //    多様性とラウンドロビンの挙動を維持したまま不足分のみ補う。
  const groupByAuthor = (list) => {
    const m = new Map();
    for (const c of list) {
      if (!m.has(c.item.pubkey)) m.set(c.item.pubkey, []);
      m.get(c.item.pubkey).push(c);
    }
    // 各著者内は新しい順。
    for (const arr of m.values()) {
      arr.sort((a, b) => b.item.created_at - a.item.created_at);
    }
    return m;
  };

  const approvedSet = new Set(); // event_id
  const authorTaken = new Map(); // 著者ごと採用数（プール横断で共有 → 上限を保つ）
  const state = { count: 0 };

  // ラウンドロビンで target まで採用。approvedSet / authorTaken / state を更新する。
  const roundRobinTake = (byAuthor) => {
    const authorList = [...byAuthor.keys()];
    let round = 0;
    let progress = true;
    while (state.count < cfg.target && progress) {
      progress = false;
      for (const author of authorList) {
        if (state.count >= cfg.target) break;
        const taken = authorTaken.get(author) || 0;
        if (taken >= cfg.perAuthorCap) continue;
        const arr = byAuthor.get(author);
        if (round >= arr.length) continue;
        const c = arr[round];
        approvedSet.add(c.item.event_id);
        authorTaken.set(author, taken + 1);
        state.count += 1;
        progress = true;
      }
      round += 1;
    }
  };

  // Tier 1: approved 分類の候補を優先採用。
  roundRobinTake(groupByAuthor(classified.filter((c) => c.status === 'approved')));
  // Tier 2: target に満たなければ review 候補からバックフィル。
  let backfilled = 0;
  if (state.count < cfg.target) {
    const before = state.count;
    roundRobinTake(groupByAuthor(classified.filter((c) => c.status === 'review')));
    backfilled = state.count - before;
  }

  // 最終 status 割り当て: approvedSet 内は approved、それ以外の非 excluded は review。
  // review 候補がバックフィルで採用されれば approved に昇格、未採用の approved 候補は review に降格。
  const samples = [];
  const topAuthorCounts = new Map();
  for (const c of classified) {
    if (c.status === 'excluded') continue; // excluded は samples に含めない。
    const finalStatus = approvedSet.has(c.item.event_id) ? 'approved' : 'review';
    if (finalStatus === 'approved') {
      topAuthorCounts.set(c.item.pubkey, (topAuthorCounts.get(c.item.pubkey) || 0) + 1);
    }
    samples.push({
      event_id: c.item.event_id,
      pubkey: c.item.pubkey,
      created_at: c.item.created_at,
      content: c.item.content,
      relay: [...c.item.relay],
      review_status: finalStatus,
    });
  }

  const approved = samples.filter((s) => s.review_status === 'approved').length;
  const review = samples.filter((s) => s.review_status === 'review').length;
  const excludedTotal = classified.filter((c) => c.status === 'excluded').length;
  counters.set('approved', approved);
  counters.set('review', review);
  counters.set('excluded_total', excludedTotal);
  counters.set('approved_backfilled', backfilled);

  const topAuthors = [...topAuthorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([pubkey, count]) => ({ pubkey, count }));
  const maxPerAuthor = topAuthors.length ? topAuthors[0].count : 0;

  return {
    samples,
    counters,
    lang,
    perAuthor: {
      unique_authors: topAuthorCounts.size,
      max_per_author_in_approved: maxPerAuthor,
      top_authors: topAuthors,
    },
  };
}

async function main() {
  const cfg = parseCliArgs(process.argv.slice(2));
  const slices = timeSlices({ windowDays: cfg.windowDays, sliceDays: cfg.sliceDays });

  if (cfg.dryRun) {
    const plan = {
      mode: 'dry-run',
      relays: cfg.relays,
      slices: slices.length,
      window_days: cfg.windowDays,
      slice_days: cfg.sliceDays,
      raw_target: cfg.rawTarget,
      target: cfg.target,
      per_author_cap: cfg.perAuthorCap,
      raw_per_author_cap: cfg.rawPerAuthorCap,
      query_limit: cfg.queryLimit,
      out_dir: cfg.outDir,
    };
    process.stdout.write('収集プラン（dry-run、ネットワーク呼び出しなし）:\n');
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    process.stdout.write(`時間スライス（新しい順）:\n`);
    slices.forEach((s, i) => {
      process.stdout.write(`  [${i}] ${new Date(s.sinceSec * 1000).toISOString()} 〜 ${new Date(s.untilSec * 1000).toISOString()}\n`);
    });
    return;
  }

  const rawPath = join(cfg.outDir, 'raw', 'raw-notes.jsonl');

  // resume: 既存 raw を読む。
  const existing = new Map();
  if (cfg.resume) {
    for (const obj of readJsonl(rawPath)) {
      if (obj && obj.event_id) existing.set(obj.event_id, obj);
    }
    log.info(`resume: 既存 raw ${existing.size} 件をロード`);
  }

  const { rawMap, counters: rawCounters } = await collectRaw(cfg, existing);
  log.info(`raw 収集完了: ${rawMap.size} 件`);

  // RAW を保存（resume 時は新規分のみ追記）。
  const rawList = [];
  for (const item of rawMap.values()) {
    const out = {
      event_id: item.event_id,
      pubkey: item.pubkey,
      created_at: item.created_at,
      content: item.content,
      relay: [...item.relay],
    };
    rawList.push(out);
    if (!existing.has(item.event_id)) {
      appendJsonl(rawPath, out);
    }
  }

  // フィルタ + サンプリング。
  const { samples, counters: fsCounters, lang, perAuthor } = filterAndSample(rawList, cfg);

  // approved-notes.json（pilot と同一スキーマ）。
  const approvedDoc = {
    pilot_name: 'production-collect',
    source_relays: cfg.relays,
    selection_policy: {
      window_days: cfg.windowDays,
      target: cfg.target,
      per_author_cap: cfg.perAuthorCap,
      raw_target: cfg.rawTarget,
      raw_per_author_cap: cfg.rawPerAuthorCap,
      dedupe: ['event_id', 'normalized_content'],
      language_heuristics: [
        '日本語文字5字以上',
        'かな比率>=0.12 または CJK比率>=0.35',
        'franc 副信号で中国語/韓国語-only を除外',
      ],
      manual_exclusions: [
        '宣伝/アフィリエイトボイラープレート',
        'URL過多/ハッシュタグ過多',
        '中国語/韓国語-only 文面',
        'メンション/リポストのみの短文',
      ],
    },
    samples,
  };
  writeJsonAtomic(join(cfg.outDir, 'approved-notes.json'), approvedDoc);

  // label_map.json。
  writeJsonAtomic(join(cfg.outDir, 'label_map.json'), buildLabelMap());

  // collection-report.json。
  const report = {
    generated_at_unix: Math.floor(Date.now() / 1000),
    relays: cfg.relays,
    window_days: cfg.windowDays,
    slice_days: cfg.sliceDays,
    counts: {
      raw_collected: rawMap.size,
      after_event_dedup: fsCounters.get('after_event_dedup'),
      after_content_dedup: fsCounters.get('after_content_dedup'),
      language_excluded: fsCounters.get('language_excluded'),
      spam_excluded: fsCounters.get('spam_excluded'),
      approved: fsCounters.get('approved'),
      approved_backfilled: fsCounters.get('approved_backfilled'),
      review: fsCounters.get('review'),
      excluded_total: fsCounters.get('excluded_total'),
    },
    per_author: perAuthor,
    language: lang,
    slices: slices.length,
    raw_skips: rawCounters.snapshot(),
  };
  writeJsonAtomic(join(cfg.outDir, 'collection-report.json'), report);

  // stdout サマリ。
  process.stdout.write('=== 収集完了 ===\n');
  process.stdout.write(`raw_collected:       ${rawMap.size}\n`);
  process.stdout.write(`after_content_dedup: ${fsCounters.get('after_content_dedup')}\n`);
  process.stdout.write(`language_excluded:   ${fsCounters.get('language_excluded')}\n`);
  process.stdout.write(`spam_excluded:       ${fsCounters.get('spam_excluded')}\n`);
  process.stdout.write(`approved:            ${fsCounters.get('approved')}\n`);
  process.stdout.write(`  (うち review からのバックフィル: ${fsCounters.get('approved_backfilled')})\n`);
  process.stdout.write(`review:              ${fsCounters.get('review')}\n`);
  process.stdout.write(`excluded_total:      ${fsCounters.get('excluded_total')}\n`);
  process.stdout.write(`unique_authors(appr):${perAuthor.unique_authors}\n`);
  process.stdout.write(`出力先: ${cfg.outDir}\n`);
}

// スクリプトとして直接実行されたときのみ収集を走らせる（import 時は副作用なし）。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    log.error(`致命的エラー: ${err?.stack || err}`);
    process.exit(1);
  });
}
