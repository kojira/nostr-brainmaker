import { describe, it, expect } from 'vitest';
import { callGemini } from '../scripts/lib/gemini.js';

function makeResponse(status, bodyObj, headers = {}) {
  return {
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => (typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj)),
  };
}

function geminiPayload(jsonText) {
  return {
    candidates: [{ content: { parts: [{ text: jsonText }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  };
}

const VALID_LABEL = JSON.stringify({ label: '愛', label_id: 0, confidence: 0.9, rationale: 'x', is_uncertain: false });

describe('callGemini', () => {
  it('returns ok + parsed on a 200 with candidates payload', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return makeResponse(200, geminiPayload(VALID_LABEL));
    };
    const res = await callGemini({ apiKey: 'k', model: 'm', prompt: 'p', fetchImpl, backoffBaseMs: 1 });
    expect(res.ok).toBe(true);
    expect(res.parsed.label).toBe('愛');
    expect(res.usage.promptTokenCount).toBe(10);
    expect(calls).toBe(1);
    expect(res.attempts.length).toBe(1);
  });

  it('retries on 429 then succeeds', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return makeResponse(429, { error: 'rate' });
      return makeResponse(200, geminiPayload(VALID_LABEL));
    };
    const res = await callGemini({ apiKey: 'k', model: 'm', prompt: 'p', fetchImpl, backoffBaseMs: 1, backoffMaxMs: 5 });
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
    expect(res.attempts.length).toBe(2);
    expect(res.attempts[0].status_code).toBe(429);
  });

  it('returns ok:false after exhausting retries on persistent 500', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return makeResponse(500, { error: 'boom' });
    };
    const res = await callGemini({ apiKey: 'k', model: 'm', prompt: 'p', fetchImpl, maxRetries: 3, backoffBaseMs: 1, backoffMaxMs: 5 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('http_500');
    expect(calls).toBe(4); // attempt 0..3
    expect(res.attempts.length).toBe(4);
  });

  it('honors Retry-After header', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return makeResponse(429, { error: 'rate' }, { 'retry-after': '0' });
      return makeResponse(200, geminiPayload(VALID_LABEL));
    };
    const res = await callGemini({ apiKey: 'k', model: 'm', prompt: 'p', fetchImpl, backoffBaseMs: 1 });
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
  });
});
