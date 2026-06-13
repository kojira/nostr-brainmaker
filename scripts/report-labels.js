#!/usr/bin/env node
// レポート/集計 CLI: checkpoint と gemini-labels.json から進捗を集計して表示/書き出し。
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readJson, readJsonl, writeJsonAtomic } from './lib/checkpoint.js';
import { log } from './lib/log.js';
import { LABELS, QA_LABEL, ID_TO_LABEL, LABEL_TO_ID, labelIdOf } from './lib/labels.js';
import { PipelineState } from './lib/pipeline-state.js';
import { buildPipelineReport } from './lib/pipeline-report.js';

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'checkpoint': { type: 'string', default: 'data/production/labels/checkpoint.jsonl' },
      'labels-json': { type: 'string', default: 'data/production/labels/gemini-labels.json' },
      'synthetic-json': { type: 'string', default: 'data/production/labels/synthetic-labels.json' },
      'min': { type: 'string', default: '50' },
      'out': { type: 'string' },
      'json': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  return {
    checkpoint: values['checkpoint'],
    labelsJson: values['labels-json'],
    syntheticJson: values['synthetic-json'],
    min: Number(values['min']),
    out: values['out'],
    json: values['json'],
  };
}

/** synthetic-labels.json があれば {label: count} を返す。なければ null。 */
function loadSyntheticCounts(syntheticJsonPath) {
  const doc = readJson(syntheticJsonPath);
  if (!doc || !Array.isArray(doc.items)) return null;
  const counts = {};
  for (const it of doc.items) {
    if (!it || !it.label) continue;
    counts[it.label] = (counts[it.label] || 0) + 1;
  }
  return counts;
}

/** 既存 gemini-labels.json を未登録分のみ state にマージ。 */
function mergeExistingLabels(state, labelsJsonPath) {
  const doc = readJson(labelsJsonPath);
  if (!doc || !Array.isArray(doc.items)) return;
  for (const it of doc.items) {
    if (!it || it.event_id == null) continue;
    if (state.labeledByEvent.has(it.event_id)) continue;
    state.recordLabeled(it);
  }
}

export async function main() {
  const cfg = parseCliArgs(process.argv.slice(2));
  const minPerLabel = cfg.min;

  const state = PipelineState.fromCheckpoint(readJsonl(cfg.checkpoint));
  mergeExistingLabels(state, cfg.labelsJson);

  if (cfg.json || cfg.out) {
    const report = buildPipelineReport({ state, stats: undefined, minPerLabel, model: undefined });
    if (cfg.out) {
      writeJsonAtomic(cfg.out, report);
      process.stdout.write(`書き出し: ${cfg.out}\n`);
    }
    if (cfg.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    }
    return;
  }

  // 可読テーブル。synthetic-labels.json があれば real/synth/total を併記する。
  const counts = state.counts();
  const synthCounts = loadSyntheticCounts(cfg.syntheticJson);
  const below = state.labelsBelow(minPerLabel);
  const belowSet = new Set(below.map((b) => b.label));

  process.stdout.write('=== ラベル集計 ===\n');
  process.stdout.write(`min_per_label: ${minPerLabel}\n`);
  if (synthCounts) {
    // status は real+synthetic の合計に対して判定（synthetic は不足の埋め草なので）。
    const belowCombined = [];
    process.stdout.write('id  char   real  synth  total  status\n');
    for (const label of LABELS) {
      const id = labelIdOf(label);
      const real = counts[label] || 0;
      const syn = synthCounts[label] || 0;
      const total = real + syn;
      let status = 'OK';
      if (total < minPerLabel) {
        status = `need ${minPerLabel - total}`;
        belowCombined.push({ label, count: total });
      }
      process.stdout.write(`${String(id).padStart(2)}  ${label}    ${String(real).padStart(5)}  ${String(syn).padStart(5)}  ${String(total).padStart(5)}  ${status}\n`);
    }
    const qa = state.qaCounts();
    const qaCount = qa[QA_LABEL] || 0;
    const totalSynthetic = Object.values(synthCounts).reduce((s, n) => s + n, 0);
    process.stdout.write('---\n');
    process.stdout.write(`total_labeled(real): ${state.totalLabeled()}\n`);
    process.stdout.write(`total_synthetic:     ${totalSynthetic}\n`);
    process.stdout.write(`labels_below_target(${minPerLabel}, real): ${below.length}\n`);
    if (below.length) {
      process.stdout.write(`  ${below.map((b) => `${b.label}:${b.count}`).join(' ')}\n`);
    }
    process.stdout.write(`labels_below_target(${minPerLabel}, real+synthetic): ${belowCombined.length}\n`);
    if (belowCombined.length) {
      process.stdout.write(`  ${belowCombined.map((b) => `${b.label}:${b.count}`).join(' ')}\n`);
    }
    process.stdout.write(`QA(${QA_LABEL}): ${qaCount}\n`);
    process.stdout.write(`complete(real): ${state.isComplete(minPerLabel)}\n`);
    process.stdout.write(`complete(real+synthetic): ${belowCombined.length === 0}\n`);
    return;
  }

  process.stdout.write('id  char  count  status\n');
  for (const label of LABELS) {
    const id = labelIdOf(label);
    const count = counts[label] || 0;
    const status = belowSet.has(label) ? `need ${minPerLabel - count}` : 'OK';
    process.stdout.write(`${String(id).padStart(2)}  ${label}    ${String(count).padStart(5)}  ${status}\n`);
  }
  const qa = state.qaCounts();
  const qaCount = qa[QA_LABEL] || 0;
  process.stdout.write('---\n');
  process.stdout.write(`total_labeled: ${state.totalLabeled()}\n`);
  process.stdout.write(`labels_below_target(${minPerLabel}): ${below.length}\n`);
  if (below.length) {
    process.stdout.write(`  ${below.map((b) => `${b.label}:${b.count}`).join(' ')}\n`);
  }
  process.stdout.write(`QA(${QA_LABEL}): ${qaCount}\n`);
  process.stdout.write(`complete: ${state.isComplete(minPerLabel)}\n`);
  // ID_TO_LABEL / LABEL_TO_ID も参照可能（id 整合確認用）。
  void ID_TO_LABEL; void LABEL_TO_ID;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    log.error(`致命的エラー: ${err?.stack || err}`);
    process.exit(1);
  });
}
