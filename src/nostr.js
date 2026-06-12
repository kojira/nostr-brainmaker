// Nostr input decoding + relay fetching (client-side only).
import { SimplePool } from 'nostr-tools/pool';
import * as nip19 from 'nostr-tools/nip19';

export const DEFAULT_RELAYS = [
  'wss://yabu.me',
  'wss://r.kojira.io',
  'wss://x.kojira.io',
];

/**
 * Resolve any of npub / hex pubkey / nprofile into { pubkey, relays }.
 * `relays` are extra relay hints embedded in an nprofile (may be empty).
 * Throws on invalid input.
 */
export function resolveInput(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new Error('入力が空です。npub / hex / nprofile を入力してください。');

  // bare hex pubkey
  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    return { pubkey: input.toLowerCase(), relays: [] };
  }

  let decoded;
  try {
    decoded = nip19.decode(input);
  } catch {
    throw new Error('デコードできませんでした。npub / hex / nprofile を確認してください。');
  }

  if (decoded.type === 'npub') {
    return { pubkey: decoded.data, relays: [] };
  }
  if (decoded.type === 'nprofile') {
    return { pubkey: decoded.data.pubkey, relays: decoded.data.relays || [] };
  }
  throw new Error(`対応していない形式です: ${decoded.type}（npub / hex / nprofile に対応）`);
}

/**
 * Fetch kind:1 notes authored by `pubkey` within the last `days` days.
 * Returns { events, relays } where events are sorted newest-first and deduped.
 * `onProgress(msg)` is optional.
 */
export async function fetchRecentNotes(pubkey, { days = 7, relays, limit = 500, timeoutMs = 8000, onProgress } = {}) {
  const usedRelays = (relays && relays.length ? relays : DEFAULT_RELAYS).slice(0, 8);
  const since = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const pool = new SimplePool();

  onProgress?.(`${usedRelays.length} 個のリレーに問い合わせ中…`);

  const filter = { kinds: [1], authors: [pubkey], since, limit };
  const seen = new Map();

  try {
    const events = await Promise.race([
      pool.querySync(usedRelays, filter, { maxWait: timeoutMs }),
      new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs + 1500)),
    ]);
    for (const ev of events || []) {
      if (ev && ev.created_at >= since) seen.set(ev.id, ev);
    }
  } finally {
    try { pool.close(usedRelays); } catch { /* ignore */ }
  }

  const deduped = [...seen.values()].sort((a, b) => b.created_at - a.created_at);
  return { events: deduped, relays: usedRelays };
}

/**
 * Try to fetch the author's profile (kind:0) for display.
 * Returns parsed metadata object or null.
 */
export async function fetchProfile(pubkey, { relays, timeoutMs = 6000 } = {}) {
  const usedRelays = (relays && relays.length ? relays : DEFAULT_RELAYS).slice(0, 6);
  const pool = new SimplePool();
  try {
    const ev = await Promise.race([
      pool.get(usedRelays, { kinds: [0], authors: [pubkey] }),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!ev) return null;
    try { return JSON.parse(ev.content); } catch { return null; }
  } finally {
    try { pool.close(usedRelays); } catch { /* ignore */ }
  }
}

export function npubOf(pubkey) {
  try { return nip19.npubEncode(pubkey); } catch { return pubkey; }
}

/**
 * Feature-detect a NIP-07 browser extension (window.nostr.getPublicKey).
 * `win` defaults to the global window; pass an object in tests.
 */
export function hasNip07(win = (typeof window !== 'undefined' ? window : undefined)) {
  return !!(win && win.nostr && typeof win.nostr.getPublicKey === 'function');
}

/**
 * Validate a hex pubkey returned by a NIP-07 extension and return both its
 * hex and npub forms. Throws a friendly (Japanese) error on bad input.
 */
export function normalizeNip07Pubkey(hex) {
  const s = String(hex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) {
    throw new Error('拡張機能から不正な公開鍵が返されました。');
  }
  return { hex: s, npub: npubOf(s) };
}

/**
 * Obtain the public key from a NIP-07 extension via window.nostr.getPublicKey().
 * Returns { hex, npub }. Throws a friendly (Japanese) error if no extension is
 * present or the request is rejected.
 */
export async function getNip07PublicKey(win = (typeof window !== 'undefined' ? window : undefined)) {
  if (!hasNip07(win)) {
    throw new Error('NIP-07 拡張機能が見つかりません。Alby や nos2x などをインストールしてから再度お試しください。');
  }
  let hex;
  try {
    hex = await win.nostr.getPublicKey();
  } catch {
    throw new Error('拡張機能から公開鍵を取得できませんでした（許可が拒否された可能性があります）。');
  }
  return normalizeNip07Pubkey(hex);
}
