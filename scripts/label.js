#!/usr/bin/env node
// ラベリング CLI: 承認ノートを Gemini で46ラベルセットに分類する（2パス精緻化対応）。
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { buildLabelingPrompt, buildRefinementPrompt } from './lib/prompt.js';
import { LABEL_SET_VERSION } from './lib/labels.js';
import { RateLimiter, runPool } from './lib/ratelimit.js';
import { appendJsonl, readJson, writeJsonAtomic, readJsonl } from './lib/checkpoint.js';
import { log, Counters } from './lib/log.js';
import { labelOne, loadEnvKey } from './lib/labeler.js';

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'input': { type: 'string', default: 'data/production/approved-notes.json' },
      'out-dir': { type: 'string', default: 'data/production/labels' },
      'model': { type: 'string', default: 'gemini-3.1-flash-lite' },
      'concurrency': { type: 'string', default: '5' },
      'rpm': { type: 'string', default: '60' },
      'limit': { type: 'string', default: '0' },
      'min-confidence': { type: 'string', default: '0.6' },
      'refine': { type: 'boolean', default: true },
      'no-refine': { type: 'boolean', default: false },
      'max-retries': { type: 'string', default: '5' },
      'api-key-env': { type: 'string', default: 'GEMINI_API_KEY' },
      'resume': { type: 'boolean', default: true },
      'no-resume': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  return {
    input: values['input'],
    outDir: values['out-dir'],
    model: values['model'],
    concurrency: Number(values['concurrency']),
    rpm: Number(values['rpm']),
    limit: Number(values['limit']),
    minConfidence: Number(values['min-confidence']),
    refine: values['no-refine'] ? false : values['refine'],
    maxRetries: Number(values['max-retries']),
    apiKeyEnv: values['api-key-env'],
    resume: values['no-resume'] ? false : values['resume'],
    dryRun: values['dry-run'],
  };
}

async function main() {
  const cfg = parseCliArgs(process.argv.slice(2));
  const logPath = join(cfg.outDir, 'gemini-labeling-log.jsonl');
  const checkpointPath = join(cfg.outDir, 'checkpoint.jsonl');

  // 入力ロード。
  const doc = readJson(cfg.input);
  const allSamples = doc && Array.isArray(doc.samples) ? doc.samples : [];
  let todo = allSamples.filter((s) => s.review_status === 'approved');
  if (cfg.limit > 0) todo = todo.slice(0, cfg.limit);

  // resume: 完了済み event_id を除外。
  const doneItems = new Map();
  if (cfg.resume) {
    for (const cp of readJsonl(checkpointPath)) {
      if (cp && cp.ok === true && cp.event_id) doneItems.set(cp.event_id, cp);
    }
  }
  const remaining = todo.filter((s) => !doneItems.has(s.event_id));

  // API キー（dry-run では不要）。
  const apiKey = loadEnvKey(cfg.apiKeyEnv);

  if (cfg.dryRun) {
    process.stdout.write('ラベリング設定（dry-run、API呼び出しなし）:\n');
    process.stdout.write(JSON.stringify({
      mode: 'dry-run',
      input: cfg.input,
      input_exists: !!doc,
      out_dir: cfg.outDir,
      model: cfg.model,
      concurrency: cfg.concurrency,
      rpm: cfg.rpm,
      min_confidence: cfg.minConfidence,
      refine: cfg.refine,
      max_retries: cfg.maxRetries,
      api_key_env: cfg.apiKeyEnv,
      api_key_present: !!apiKey,
      approved_total: todo.length,
      already_done: doneItems.size,
      todo_count: remaining.length,
    }, null, 2) + '\n');
    return;
  }

  if (!apiKey) {
    log.error(`API キーが見つかりません（env: ${cfg.apiKeyEnv} または .env）。`);
    process.exit(1);
  }

  if (!doc) {
    log.error(`入力ファイルが見つかりません: ${cfg.input}`);
    process.exit(1);
  }

  const rateLimiter = new RateLimiter({ rpm: cfg.rpm });
  const counters = new Counters();

  // 既存の labeled（resume）を保持。
  const labeledById = new Map();
  for (const cp of doneItems.values()) {
    // checkpoint 行は labeled フィールドを含む。
    const { ok, ...rest } = cp;
    labeledById.set(cp.event_id, rest);
  }

  log.info(`PASS1: approved=${todo.length} done=${doneItems.size} todo=${remaining.length}`);

  // === PASS 1 ===
  let processed = 0;
  await runPool(remaining, async (item) => {
    const prompt = buildLabelingPrompt(item.content);
    const out = await labelOne({ item, prompt, pass: 1, cfg, apiKey, rateLimiter });
    appendJsonl(logPath, out.logLine);
    if (out.ok) {
      labeledById.set(item.event_id, out.labeled);
      appendJsonl(checkpointPath, { event_id: item.event_id, ok: true, ...out.labeled });
      counters.inc('labeled');
    } else {
      counters.inc('failures');
      appendJsonl(checkpointPath, { event_id: item.event_id, ok: false, reason: out.failure.reason });
      counters.failuresList = counters.failuresList || [];
      counters.failuresList.push(out.failure);
    }
  }, {
    concurrency: cfg.concurrency,
    onItem: () => {
      processed += 1;
      if (processed % 25 === 0) log.progress(`pass1 ${processed}/${remaining.length}`);
    },
  });

  // === PASS 2（精緻化）===
  let pass2Count = 0;
  if (cfg.refine) {
    const lowConf = [...labeledById.values()].filter(
      (it) => (Number(it.confidence) < cfg.minConfidence) || it.is_uncertain === true,
    );
    log.info(`PASS2: 再検討対象 ${lowConf.length} 件`);
    let p2 = 0;
    await runPool(lowConf, async (it) => {
      const prompt = buildRefinementPrompt(it.content, it.label);
      const out = await labelOne({
        item: it,
        prompt,
        pass: 2,
        cfg,
        apiKey,
        rateLimiter,
      });
      appendJsonl(logPath, out.logLine);
      if (out.ok) {
        // 上書き更新（pass:2）。
        labeledById.set(it.event_id, out.labeled);
        appendJsonl(checkpointPath, { event_id: it.event_id, ok: true, ...out.labeled });
        pass2Count += 1;
      }
      // 失敗時は pass1 の結果を維持。
    }, {
      concurrency: cfg.concurrency,
      onItem: () => {
        p2 += 1;
        if (p2 % 25 === 0) log.progress(`pass2 ${p2}/${lowConf.length}`);
      },
    });
  }

  // === 出力組み立て ===
  const items = [...labeledById.values()].map((it) => ({
    event_id: it.event_id,
    pubkey: it.pubkey,
    created_at: it.created_at,
    content: it.content,
    label: it.label,
    label_id: it.label_id,
    confidence: it.confidence,
    rationale: it.rationale,
    is_uncertain: it.is_uncertain,
    pass: it.pass,
    source: it.source,
  }));

  const failuresList = counters.failuresList || [];

  // gemini-labels.json（pilot と同一スキーマ）。
  writeJsonAtomic(join(cfg.outDir, 'gemini-labels.json'), {
    model: cfg.model,
    label_set_version: LABEL_SET_VERSION,
    count: items.length,
    failures: failuresList.length,
    items,
  });

  // failures。
  writeJsonAtomic(join(cfg.outDir, 'gemini-labeling-failures.json'), {
    count: failuresList.length,
    items: failuresList,
  });

  // labeling-report.json。
  const labelCounts = {};
  let confSum = 0;
  let confMin = Infinity;
  let uncertainCount = 0;
  const buckets = { '0.0-0.6': 0, '0.6-0.8': 0, '0.8-1.0': 0 };
  let needsHuman = 0;
  for (const it of items) {
    labelCounts[it.label] = (labelCounts[it.label] || 0) + 1;
    const c = Number(it.confidence);
    confSum += c;
    confMin = Math.min(confMin, c);
    if (it.is_uncertain) uncertainCount += 1;
    if (c < 0.6) buckets['0.0-0.6'] += 1;
    else if (c < 0.8) buckets['0.6-0.8'] += 1;
    else buckets['0.8-1.0'] += 1;
    if (c < cfg.minConfidence || it.is_uncertain) needsHuman += 1;
  }

  writeJsonAtomic(join(cfg.outDir, 'labeling-report.json'), {
    generated_at_unix: Math.floor(Date.now() / 1000),
    model: cfg.model,
    total: todo.length,
    labeled: items.length,
    failures: failuresList.length,
    label_counts: labelCounts,
    confidence: {
      mean: items.length ? confSum / items.length : 0,
      min: items.length ? confMin : 0,
      buckets,
    },
    uncertain_count: uncertainCount,
    pass2_count: pass2Count,
    needs_human_review_count: needsHuman,
  });

  // stdout サマリ。
  process.stdout.write('=== ラベリング完了 ===\n');
  process.stdout.write(`model:               ${cfg.model}\n`);
  process.stdout.write(`approved_total:      ${todo.length}\n`);
  process.stdout.write(`labeled:             ${items.length}\n`);
  process.stdout.write(`failures:            ${failuresList.length}\n`);
  process.stdout.write(`pass2_refined:       ${pass2Count}\n`);
  process.stdout.write(`needs_human_review:  ${needsHuman}\n`);
  process.stdout.write(`出力先: ${cfg.outDir}\n`);
}

main().catch((err) => {
  log.error(`致命的エラー: ${err?.stack || err}`);
  process.exit(1);
});
