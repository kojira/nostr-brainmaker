// Gemini generateContent クライアント。リトライ・バックオフ・タイムアウト付き。

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** 5xx か。 */
function isServerError(status) {
  return status >= 500 && status <= 599;
}

/** Retry-After ヘッダ（秒）を ms に。なければ null。 */
function parseRetryAfter(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const v = headers.get('retry-after');
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return Math.floor(secs * 1000);
  return null;
}

/** full jitter 付き指数バックオフの待機 ms を計算。 */
function backoffDelay(attempt, { base, factor, max }) {
  const exp = Math.min(max, base * Math.pow(factor, attempt));
  return Math.floor(Math.random() * exp);
}

/**
 * candidates[0].content.parts[].text を連結して返す。
 */
function extractText(data) {
  try {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  } catch {
    return '';
  }
}

/**
 * Gemini を呼ぶ。HTTP 200 かつ本文が JSON としてパースできたときのみ ok=true。
 * 429/5xx/ネットワークエラーは指数バックオフ + full jitter でリトライ。
 *
 * @returns {Promise<{ok:boolean, text:string, parsed:any, usage:any,
 *                     attempts:Array<{attempt,status_code,response_text}>, error:(string|null)}>}
 */
export async function callGemini({
  apiKey,
  model,
  prompt,
  timeoutMs = 30000,
  maxRetries = 5,
  rateLimiter,
  fetchImpl,
  backoffBaseMs = 1000,
  backoffFactor = 2,
  backoffMaxMs = 60000,
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey || '')}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  };

  const attempts = [];
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (rateLimiter && typeof rateLimiter.acquire === 'function') {
      await rateLimiter.acquire();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status = 0;
    let responseText = '';
    let headers = null;

    try {
      const resp = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      status = resp.status;
      headers = resp.headers;
      responseText = await resp.text();
    } catch (err) {
      // ネットワーク/タイムアウト/abort。
      lastError = err && err.name === 'AbortError' ? 'timeout' : `network_error: ${err?.message || err}`;
      attempts.push({ attempt, status_code: 0, response_text: String(lastError) });
      clearTimeout(timer);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, backoffDelay(attempt, { base: backoffBaseMs, factor: backoffFactor, max: backoffMaxMs })));
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }

    attempts.push({ attempt, status_code: status, response_text: responseText });

    if (status === 200) {
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        lastError = `invalid_outer_json: ${e?.message || e}`;
        // 200 だが本文が壊れている → リトライ対象としない（モデル応答の問題）。
        return { ok: false, text: '', parsed: null, usage: null, attempts, error: lastError };
      }
      const text = extractText(data);
      const usage = data?.usageMetadata || null;
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        lastError = `invalid_model_json: ${e?.message || e}`;
        return { ok: false, text, parsed: null, usage, attempts, error: lastError };
      }
      return { ok: true, text, parsed, usage, attempts, error: null };
    }

    // リトライ可能なステータスか。
    if (status === 429 || isServerError(status)) {
      lastError = `http_${status}`;
      if (attempt < maxRetries) {
        const retryAfter = parseRetryAfter(headers);
        const delay = retryAfter != null
          ? retryAfter
          : backoffDelay(attempt, { base: backoffBaseMs, factor: backoffFactor, max: backoffMaxMs });
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      break;
    }

    // それ以外の 4xx は即時失敗（リトライしても無駄）。
    lastError = `http_${status}`;
    return { ok: false, text: '', parsed: null, usage: null, attempts, error: lastError };
  }

  return { ok: false, text: '', parsed: null, usage: null, attempts, error: lastError || 'exhausted_retries' };
}
