#!/usr/bin/env node
// 逆生成 CLI: 不足ラベルの日本語投稿を Gemini で合成して埋める（synthetic backfill）。
// 既存の Nostr 実データとは別ファイル（synthetic-labels.json / synthetic-checkpoint.jsonl）
// に書き、synthetic:true / 'syn-' event_id / pubkey 'synthetic' で常に区別できるようにする。
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { LABELS, LABEL_SET_VERSION } from './lib/labels.js';
import { RateLimiter } from './lib/ratelimit.js';
import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from './lib/checkpoint.js';
import { log } from './lib/log.js';
import { labelOne, loadEnvKey } from './lib/labeler.js';
import { callGemini } from './lib/gemini.js';
import { buildLabelingPrompt } from './lib/prompt.js';
import { contentHash } from './lib/text.js';
import {
  computeDeficits, buildSynthesisPrompt, parseSynthesisResponse,
  filterCandidates, makeSyntheticRecord,
} from './lib/synth.js';

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'labels': { type: 'string' },
      'min': { type: 'string', default: '50' },
      'batch': { type: 'string', default: '10' },
      'model': { type: 'string', default: 'gemini-3.1-flash-lite' },
      'rpm': { type: 'string', default: '60' },
      'max-rounds': { type: 'string', default: '8' },
      'verify': { type: 'boolean', default: true },
      'no-verify': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'data-dir': { type: 'string', default: 'data/production' },
      'api-key-env': { type: 'string', default: 'GEMINI_API_KEY' },
    },
    allowPositionals: true,
  });
  return {
    labels: values['labels']
      ? values['labels'].split(',').map((s) => s.trim()).filter(Boolean)
      : null,
    min: Number(values['min']),
    batch: Number(values['batch']),
    model: values['model'],
    rpm: Number(values['rpm']),
    maxRounds: Number(values['max-rounds']),
    verify: values['no-verify'] ? false : values['verify'],
    dryRun: values['dry-run'],
    dataDir: values['data-dir'],
    apiKeyEnv: values['api-key-env'],
  };
}

/** items を event_id で Map にマージ（後勝ち）。 */
function mergeById(map, items) {
  for (const it of items) {
    if (it && it.event_id != null) map.set(it.event_id, it);
  }
}

/** 実データ（gemini-labels.json + checkpoint.jsonl）と既存合成データを読み込む。 */
function loadExisting(labelsDir) {
  const realById = new Map();
  const doc = readJson(join(labelsDir, 'gemini-labels.json'));
  if (doc && Array.isArray(doc.items)) mergeById(realById, doc.items);
  for (const cp of readJsonl(join(labelsDir, 'checkpoint.jsonl'))) {
    if (cp && cp.ok === true && cp.event_id != null) {
      const { ok, ...rest } = cp;
      realById.set(cp.event_id, rest);
    }
  }

  const synthById = new Map();
  const synthDoc = readJson(join(labelsDir, 'synthetic-labels.json'));
  if (synthDoc && Array.isArray(synthDoc.items)) mergeById(synthById, synthDoc.items);
  for (const cp of readJsonl(join(labelsDir, 'synthetic-checkpoint.jsonl'))) {
    if (cp && cp.ok === true && cp.event_id != null) {
      const { ok, ...rest } = cp;
      synthById.set(cp.event_id, rest);
    }
  }
  return { realById, synthById };
}

/** {label: count} を集計する。 */
function countsOf(items) {
  const c = {};
  for (const it of items) {
    if (it && it.label) c[it.label] = (c[it.label] || 0) + 1;
  }
  return c;
}

/** 文体参考用に実投稿を最大 n 件選ぶ（短いものを優先）。 */
function pickExamples(realItems, label, n = 3) {
  const pool = realItems.filter(
    (it) => it.label === label && typeof it.content === 'string' && it.content.trim().length > 0,
  );
  pool.sort((a, b) => a.content.length - b.content.length);
  return pool.slice(0, n).map((it) => it.content);
}

async function main() {
  const cfg = parseCliArgs(process.argv.slice(2));
  const labelsDir = join(cfg.dataDir, 'labels');
  const checkpointPath = join(labelsDir, 'synthetic-checkpoint.jsonl');

  // 既存データから実カウント・合成カウント・seen ハッシュを構築（resume 対応）。
  const { realById, synthById } = loadExisting(labelsDir);
  const realItems = [...realById.values()];
  const realCounts = countsOf(realItems);
  const synthCounts = countsOf([...synthById.values()]);
  const effectiveCounts = {};
  for (const l of LABELS) {
    effectiveCounts[l] = (realCounts[l] || 0) + (synthCounts[l] || 0);
  }

  let deficits;
  try {
    deficits = computeDeficits(effectiveCounts, { min: cfg.min, labels: cfg.labels });
  } catch (err) {
    log.error(String(err?.message || err));
    process.exit(1);
  }
  const todo = deficits.filter((d) => d.need > 0);
  const totalNeed = todo.reduce((s, d) => s + d.need, 0);

  const apiKey = loadEnvKey(cfg.apiKeyEnv);

  if (cfg.dryRun) {
    process.stdout.write('逆生成プラン（dry-run、API呼び出しなし）:\n');
    process.stdout.write(`min=${cfg.min} batch=${cfg.batch} max_rounds=${cfg.maxRounds} model=${cfg.model} verify=${cfg.verify} api_key_present=${!!apiKey}\n`);
    process.stdout.write(`実データ: ${realItems.length} 件 / 既存合成: ${synthById.size} 件\n`);
    process.stdout.write('label  real  synth  need  planned_rounds\n');
    for (const d of deficits) {
      const real = realCounts[d.label] || 0;
      const syn = synthCounts[d.label] || 0;
      const rounds = d.need > 0 ? Math.min(cfg.maxRounds, Math.ceil(d.need / cfg.batch)) : 0;
      process.stdout.write(`${d.label}      ${String(real).padStart(4)}  ${String(syn).padStart(5)}  ${String(d.need).padStart(4)}  ${String(rounds).padStart(4)}\n`);
    }
    process.stdout.write('---\n');
    process.stdout.write(`不足ラベル: ${todo.length} 件 / 必要生成数 合計: ${totalNeed}\n`);
    return;
  }

  if (!apiKey) {
    log.error(`API キーが見つかりません（env: ${cfg.apiKeyEnv} または .env）。`);
    process.exit(1);
  }

  const rateLimiter = new RateLimiter({ rpm: cfg.rpm });
  // 検証（labelOne）用の最小 cfg。
  const labelerCfg = { model: cfg.model, maxRetries: 2 };

  // 重複検出: 実データ + 既存合成データの contentHash。
  const seenHashes = new Set();
  for (const it of realItems) {
    if (typeof it.content === 'string') seenHashes.add(contentHash(it.content));
  }
  for (const it of synthById.values()) {
    if (typeof it.content === 'string') seenHashes.add(contentHash(it.content));
  }

  log.info(`逆生成開始: 不足ラベル=${todo.length} 必要数=${totalNeed} verify=${cfg.verify} model=${cfg.model}`);

  let genCalls = 0;
  let genOk = 0;
  const perLabel = [];

  for (const d of todo) {
    const examples = pickExamples(realItems, d.label);
    let needRemaining = d.need;
    let generated = 0;
    let filterRejected = 0;
    let verifyRejected = 0;
    let round = 0;

    while (needRemaining > 0 && round < cfg.maxRounds) {
      round += 1;
      const prompt = buildSynthesisPrompt(d.label, { count: cfg.batch, examples });
      genCalls += 1;
      const res = await callGemini({ apiKey, model: cfg.model, prompt, rateLimiter });
      if (!res.ok) {
        log.warn(`${d.label} round${round}: 生成呼び出し失敗 (${res.error})`);
        continue;
      }
      genOk += 1;
      const parsedRes = parseSynthesisResponse(res.parsed);
      if (!parsedRes.ok) {
        log.warn(`${d.label} round${round}: 応答パース失敗 (${parsedRes.error})`);
        continue;
      }
      const { accepted, rejected } = filterCandidates(parsedRes.posts, { seenHashes });
      filterRejected += rejected.length;

      for (const content of accepted) {
        if (needRemaining <= 0) break;
        // 採用前に hash を登録（以降のラウンド/ラベルとの重複防止）。
        seenHashes.add(contentHash(content));
        const createdAt = Math.floor(Date.now() / 1000);
        let record;
        if (cfg.verify) {
          // 本番ラベリングプロンプトでラウンドトリップ検証。
          const item = {
            event_id: `syn-${contentHash(content)}`,
            pubkey: 'synthetic',
            created_at: createdAt,
            content,
          };
          const out = await labelOne({
            item,
            prompt: buildLabelingPrompt(content),
            pass: 1,
            cfg: labelerCfg,
            apiKey,
            rateLimiter,
          });
          if (!out.ok || out.labeled.label !== d.label) {
            verifyRejected += 1;
            const got = out.ok ? out.labeled.label : `error: ${out.failure?.reason}`;
            log.info(`${d.label}: 検証棄却 (判定=${got}) 「${content.slice(0, 40)}」`);
            continue;
          }
          record = makeSyntheticRecord(content, d.label, {
            model: cfg.model,
            verified: true,
            confidence: out.labeled.confidence,
            rationale: out.labeled.rationale,
            createdAt,
          });
        } else {
          record = makeSyntheticRecord(content, d.label, {
            model: cfg.model,
            verified: false,
            createdAt,
          });
        }
        // クラッシュ耐性: 1件ごとに即追記。
        appendJsonl(checkpointPath, { ok: true, ...record });
        synthById.set(record.event_id, record);
        generated += 1;
        needRemaining -= 1;
      }
      log.progress(`${d.label}: round ${round}/${cfg.maxRounds} generated=${generated}/${d.need} filter_rej=${filterRejected} verify_rej=${verifyRejected}`);
    }

    if (needRemaining > 0) {
      log.warn(`${d.label}: max-rounds=${cfg.maxRounds} 到達。残り ${needRemaining} 件は未達（再実行で続きから生成されます）`);
    }
    perLabel.push({
      label: d.label,
      have_before: d.have,
      generated,
      verified_rejected: verifyRejected,
      filter_rejected: filterRejected,
      have_after: d.have + generated,
    });
  }

  if (genCalls > 0 && genOk === 0) {
    log.error('全ての Gemini 生成呼び出しが失敗しました。');
    process.exit(1);
  }

  // 出力（実データとは別ファイル。既存合成分も含めて再構築）。
  const allSynthetic = [...synthById.values()];
  const generatedAt = Math.floor(Date.now() / 1000);
  writeJsonAtomic(join(labelsDir, 'synthetic-labels.json'), {
    generated_at: generatedAt,
    model: cfg.model,
    min: cfg.min,
    label_set_version: LABEL_SET_VERSION,
    count: allSynthetic.length,
    items: allSynthetic,
  });

  const totals = {
    deficit_labels: todo.length,
    generated: perLabel.reduce((s, p) => s + p.generated, 0),
    verified_rejected: perLabel.reduce((s, p) => s + p.verified_rejected, 0),
    filter_rejected: perLabel.reduce((s, p) => s + p.filter_rejected, 0),
    gemini_generation_calls: genCalls,
    gemini_generation_ok: genOk,
    synthetic_total: allSynthetic.length,
  };
  writeJsonAtomic(join(labelsDir, 'synthesis-report.json'), {
    generated_at: generatedAt,
    model: cfg.model,
    params: {
      min: cfg.min,
      batch: cfg.batch,
      rpm: cfg.rpm,
      max_rounds: cfg.maxRounds,
      verify: cfg.verify,
      labels: cfg.labels,
    },
    per_label: perLabel,
    totals,
  });

  // stdout サマリ。
  process.stdout.write('=== 逆生成完了 ===\n');
  process.stdout.write(`model:   ${cfg.model}\n`);
  process.stdout.write(`verify:  ${cfg.verify}\n`);
  process.stdout.write('label  before  generated  after  verify_rej  filter_rej\n');
  for (const p of perLabel) {
    process.stdout.write(
      `${p.label}      ${String(p.have_before).padStart(5)}  ${String(p.generated).padStart(9)}  ${String(p.have_after).padStart(5)}  ${String(p.verified_rejected).padStart(10)}  ${String(p.filter_rejected).padStart(10)}\n`,
    );
  }
  process.stdout.write('---\n');
  process.stdout.write(`generated:        ${totals.generated}\n`);
  process.stdout.write(`synthetic_total:  ${totals.synthetic_total}\n`);
  process.stdout.write(`出力先: ${labelsDir}\n`);
}

main().catch((err) => {
  log.error(`致命的エラー: ${err?.stack || err}`);
  process.exit(1);
});
