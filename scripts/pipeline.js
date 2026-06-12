#!/usr/bin/env node
// エンドツーエンド・パイプライン CLI: raw（+任意でリレー）から逐次ラベリングし、
// 各ラベルが min に達するまで進めて出力を再構築する。
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RateLimiter } from './lib/ratelimit.js';
import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from './lib/checkpoint.js';
import { log, Counters } from './lib/log.js';
import { LABEL_SET_VERSION } from './lib/labels.js';
import { PipelineState } from './lib/pipeline-state.js';
import { runPipeline } from './lib/pipeline.js';
import { rawFileSource, relaySource, concatSources } from './lib/raw-source.js';
import { makeGeminiLabeler, loadEnvKey } from './lib/labeler.js';
import { buildPipelineReport, renderProgress } from './lib/pipeline-report.js';
import { RELAYS } from './lib/relays.js';

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'min': { type: 'string', default: '50' },
      'concurrency': { type: 'string', default: '5' },
      'rpm': { type: 'string', default: '60' },
      'out-dir': { type: 'string', default: 'data/production' },
      'raw': { type: 'string', default: 'data/production/raw/raw-notes.jsonl' },
      'model': { type: 'string', default: 'gemini-3.1-flash-lite' },
      'max-retries': { type: 'string', default: '5' },
      'api-key-env': { type: 'string', default: 'GEMINI_API_KEY' },
      'high-water-mark': { type: 'string', default: '200' },
      'allow-network': { type: 'boolean', default: false },
      'resume': { type: 'boolean', default: true },
      'no-resume': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'window-days': { type: 'string', default: '120' },
      'slice-days': { type: 'string', default: '3' },
      'query-limit': { type: 'string', default: '500' },
      'timeout-ms': { type: 'string', default: '8000' },
      'max-pages': { type: 'string', default: '8' },
      'relays': { type: 'string' },
      'raw-per-author-cap': { type: 'string', default: '25' },
    },
    allowPositionals: true,
  });
  return {
    min: Number(values['min']),
    concurrency: Number(values['concurrency']),
    rpm: Number(values['rpm']),
    outDir: values['out-dir'],
    raw: values['raw'],
    model: values['model'],
    maxRetries: Number(values['max-retries']),
    apiKeyEnv: values['api-key-env'],
    highWaterMark: Number(values['high-water-mark']),
    allowNetwork: values['allow-network'],
    resume: values['no-resume'] ? false : values['resume'],
    dryRun: values['dry-run'],
    windowDays: Number(values['window-days']),
    sliceDays: Number(values['slice-days']),
    queryLimit: Number(values['query-limit']),
    timeoutMs: Number(values['timeout-ms']),
    maxPages: Number(values['max-pages']),
    relays: values['relays'] ? values['relays'].split(',').map((s) => s.trim()).filter(Boolean) : RELAYS.slice(),
    rawPerAuthorCap: Number(values['raw-per-author-cap']),
  };
}

/** state を既存の gemini-labels.json から（未登録分のみ）補完する。 */
function mergeExistingLabels(state, labelsJsonPath) {
  const doc = readJson(labelsJsonPath);
  if (!doc || !Array.isArray(doc.items)) return;
  for (const it of doc.items) {
    if (!it || it.event_id == null) continue;
    if (state.labeledByEvent.has(it.event_id)) continue;
    state.recordLabeled(it);
  }
}

/** labeled レコードを gemini-labels.json の item 形に正規化する。 */
function toItemShape(it) {
  return {
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
  };
}

/** state + qa から labeling-report.json を組み立てる。 */
function buildLabelingReport(state, { model, minPerLabel, failures }) {
  const items = state.labeledItems();
  const labelCounts = { ...state.counts(), ...state.qaCounts() };
  let confSum = 0;
  let confMin = Infinity;
  let uncertainCount = 0;
  let pass2Count = 0;
  let needsHuman = 0;
  const buckets = { '0.0-0.6': 0, '0.6-0.8': 0, '0.8-1.0': 0 };
  for (const it of items) {
    const c = Number(it.confidence);
    confSum += c;
    confMin = Math.min(confMin, c);
    if (it.is_uncertain) uncertainCount += 1;
    if (it.pass === 2) pass2Count += 1;
    if (c < 0.6) buckets['0.0-0.6'] += 1;
    else if (c < 0.8) buckets['0.6-0.8'] += 1;
    else buckets['0.8-1.0'] += 1;
    if (c < 0.6 || it.is_uncertain) needsHuman += 1;
  }
  return {
    generated_at_unix: Math.floor(Date.now() / 1000),
    model,
    total: items.length,
    labeled: items.length,
    failures: failures.length,
    label_counts: labelCounts,
    confidence: {
      mean: items.length ? confSum / items.length : 0,
      min: items.length ? confMin : 0,
      buckets,
    },
    uncertain_count: uncertainCount,
    pass2_count: pass2Count,
    needs_human_review_count: needsHuman,
    min_per_label: minPerLabel,
  };
}

export async function main() {
  const cfg = parseCliArgs(process.argv.slice(2));
  const labelsDir = join(cfg.outDir, 'labels');
  const checkpointPath = join(labelsDir, 'checkpoint.jsonl');
  const logPath = join(labelsDir, 'gemini-labeling-log.jsonl');
  const labelsJsonPath = join(labelsDir, 'gemini-labels.json');
  const minPerLabel = cfg.min;

  // state シード。
  const state = cfg.resume
    ? PipelineState.fromCheckpoint(readJsonl(checkpointPath))
    : new PipelineState();
  // 既存の gemini-labels.json をマージ（未登録分のみ、seen にもする）。
  mergeExistingLabels(state, labelsJsonPath);

  if (cfg.dryRun) {
    const below = state.labelsBelow(minPerLabel);
    const plan = {
      mode: 'dry-run',
      min: minPerLabel,
      concurrency: cfg.concurrency,
      already_labeled_total: state.totalLabeled(),
      labels_below_count: below.length,
      labels_below_target: below,
      raw_file: cfg.raw,
      raw_file_exists: existsSync(cfg.raw),
      allow_network: cfg.allowNetwork,
      out_dir: cfg.outDir,
    };
    process.stdout.write('パイプラインプラン（dry-run、API/ネットワーク呼び出しなし）:\n');
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    process.stdout.write(renderProgress({ state, stats: new Counters(), minPerLabel, queueSize: 0 }) + '\n');
    return;
  }

  const apiKey = loadEnvKey(cfg.apiKeyEnv);
  if (!apiKey) {
    log.error(`API キーが見つかりません（env: ${cfg.apiKeyEnv} または .env）。`);
    process.exit(1);
  }

  // ソース構築。
  let source = rawFileSource(cfg.raw);
  if (cfg.allowNetwork) {
    source = concatSources(
      rawFileSource(cfg.raw),
      relaySource({
        relays: cfg.relays,
        windowDays: cfg.windowDays,
        sliceDays: cfg.sliceDays,
        queryLimit: cfg.queryLimit,
        timeoutMs: cfg.timeoutMs,
        maxPages: cfg.maxPages,
        rawPerAuthorCap: cfg.rawPerAuthorCap,
        rawAppendPath: cfg.raw,
      }),
    );
  }

  const rateLimiter = new RateLimiter({ rpm: cfg.rpm });
  const labelItem = makeGeminiLabeler({
    cfg: { model: cfg.model, maxRetries: cfg.maxRetries },
    apiKey,
    rateLimiter,
  });

  const failures = [];
  let processedSinceLog = 0;
  const stats = new Counters();

  const hooks = {
    onLabeled: (rec) => {
      appendJsonl(checkpointPath, rec);
      appendJsonl(logPath, { event_id: rec.event_id, ok: rec.ok, pass: rec.pass ?? 1 });
    },
    onFailure: (failure) => {
      if (failure) failures.push(failure);
    },
    onProgress: ({ state: st, stats: sn, queueSize }) => {
      processedSinceLog += 1;
      if (processedSinceLog % 25 === 0) {
        log.progress(renderProgress({ state: st, stats: sn, minPerLabel, queueSize }));
      }
    },
  };

  log.info(`pipeline 開始: min=${minPerLabel} already=${state.totalLabeled()} allow_network=${cfg.allowNetwork}`);

  const result = await runPipeline({
    source,
    labelItem,
    state,
    stats,
    minPerLabel,
    concurrency: cfg.concurrency,
    highWaterMark: cfg.highWaterMark,
    hooks,
  });

  // 出力を FULL state から再構築。
  writeJsonAtomic(labelsJsonPath, {
    model: cfg.model,
    label_set_version: LABEL_SET_VERSION,
    count: state.totalLabeled(),
    failures: failures.length,
    items: state.labeledItems().map(toItemShape),
  });

  writeJsonAtomic(join(labelsDir, 'labeling-report.json'),
    buildLabelingReport(state, { model: cfg.model, minPerLabel, failures }));

  writeJsonAtomic(join(labelsDir, 'pipeline-report.json'),
    buildPipelineReport({ state, stats, minPerLabel, model: cfg.model }));

  writeJsonAtomic(join(labelsDir, 'gemini-labeling-failures.json'), {
    count: failures.length,
    items: failures,
  });

  // stdout サマリ。
  process.stdout.write('=== パイプライン完了 ===\n');
  process.stdout.write(renderProgress({ state, stats, minPerLabel, queueSize: 0 }) + '\n');
  const below = state.labelsBelow(minPerLabel);
  process.stdout.write(`complete: ${result.complete}\n`);
  process.stdout.write(`total_labeled: ${state.totalLabeled()}\n`);
  process.stdout.write(`labels_below_target(${minPerLabel}): ${below.length}\n`);
  process.stdout.write(`failures: ${failures.length}\n`);
  process.stdout.write(`出力先: ${labelsDir}\n`);
}

// 直接実行時のみ走らせる（import 時は副作用なし）。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    log.error(`致命的エラー: ${err?.stack || err}`);
    process.exit(1);
  });
}
