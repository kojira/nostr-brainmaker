// 共有ラベラ: 1件を Gemini で処理する labelOne と .env ローダ、ファクトリ。
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { callGemini } from './gemini.js';
import { validateGeminiOutput } from './schema.js';
import { normalizeLabelChar, labelIdOf } from './labels.js';
import { buildLabelingPrompt } from './prompt.js';
import { log } from './log.js';

/** 最小の .env ローダ（dotenv 依存なし）。KEY=VALUE 行のみ解釈。 */
export function loadEnvKey(name) {
  if (process.env[name]) return process.env[name];
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return undefined;
  try {
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq < 0) continue;
      const k = s.slice(0, eq).trim();
      let v = s.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (k === name) return v;
    }
  } catch { /* ignore */ }
  return undefined;
}

/**
 * 1件を Gemini で処理する。validate に失敗したらリトライ（新規リクエスト）。
 * @returns {Promise<{ok, labeled?, failure?, logLine}>}
 */
export async function labelOne({ item, prompt, pass, cfg, apiKey, rateLimiter }) {
  let lastAttempts = [];
  let lastReason = 'unknown';

  for (let r = 0; r <= cfg.maxRetries; r++) {
    const res = await callGemini({
      apiKey,
      model: cfg.model,
      prompt,
      maxRetries: cfg.maxRetries,
      rateLimiter,
    });
    lastAttempts = res.attempts;

    if (!res.ok) {
      lastReason = res.error || 'transport_failed';
      // transport は callGemini 内でリトライ済み。ここでは即失敗扱い。
      break;
    }

    const v = validateGeminiOutput(res.parsed, { allowQA: true });
    if (v.valid) {
      const label = normalizeLabelChar(res.parsed.label);
      const labeled = {
        event_id: item.event_id,
        pubkey: item.pubkey,
        created_at: item.created_at,
        content: item.content,
        label,
        label_id: labelIdOf(label), // マップを信頼してモデルの id を上書き。
        confidence: Number(res.parsed.confidence),
        rationale: String(res.parsed.rationale || ''),
        is_uncertain: !!res.parsed.is_uncertain,
        pass,
        source: cfg.model,
      };
      const logLine = {
        event_id: item.event_id,
        ok: true,
        prompt,
        attempts: res.attempts,
        raw: res.text,
        pass,
      };
      return { ok: true, labeled, logLine };
    }

    // validate 失敗 → リトライ（新規リクエスト）。
    lastReason = `validation_failed: ${v.errors.join('; ')}`;
    log.warn(`validate 失敗 ${item.event_id} retry${r}: ${v.errors.join('; ')}`);
  }

  const logLine = {
    event_id: item.event_id,
    ok: false,
    prompt,
    attempts: lastAttempts,
    raw: '',
    pass,
  };
  return {
    ok: false,
    failure: { event_id: item.event_id, reason: lastReason, attempts: lastAttempts },
    logLine,
  };
}

/**
 * pipeline 用の labelItem ファクトリ。pass1 のラベリングプロンプトを使う。
 * @returns {(item) => Promise<{ok, labeled?, failure?, logLine}>}
 */
export function makeGeminiLabeler({ cfg, apiKey, rateLimiter }) {
  return async (item) =>
    await labelOne({
      item,
      prompt: buildLabelingPrompt(item.content),
      pass: 1,
      cfg,
      apiKey,
      rateLimiter,
    });
}
