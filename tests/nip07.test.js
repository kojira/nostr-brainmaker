import { describe, it, expect } from 'vitest';
import { hasNip07, normalizeNip07Pubkey, getNip07PublicKey } from '../src/nostr.js';

const HEX = 'a'.repeat(64);

describe('hasNip07', () => {
  it('detects a usable window.nostr', () => {
    expect(hasNip07({ nostr: { getPublicKey: () => {} } })).toBe(true);
  });
  it('is false when window.nostr or getPublicKey is missing', () => {
    expect(hasNip07(undefined)).toBe(false);
    expect(hasNip07({})).toBe(false);
    expect(hasNip07({ nostr: {} })).toBe(false);
    expect(hasNip07({ nostr: { getPublicKey: 'nope' } })).toBe(false);
  });
});

describe('normalizeNip07Pubkey', () => {
  it('accepts a 64-char hex pubkey and returns hex + npub', () => {
    const out = normalizeNip07Pubkey(HEX);
    expect(out.hex).toBe(HEX);
    expect(out.npub.startsWith('npub1')).toBe(true);
  });
  it('lowercases and trims', () => {
    expect(normalizeNip07Pubkey(`  ${'A'.repeat(64)} `).hex).toBe(HEX);
  });
  it('rejects invalid input', () => {
    expect(() => normalizeNip07Pubkey('')).toThrow();
    expect(() => normalizeNip07Pubkey('xyz')).toThrow();
    expect(() => normalizeNip07Pubkey('a'.repeat(63))).toThrow();
  });
});

describe('getNip07PublicKey', () => {
  it('throws a friendly error without an extension', async () => {
    await expect(getNip07PublicKey({})).rejects.toThrow(/NIP-07/);
  });
  it('returns the normalized pubkey from the extension', async () => {
    const win = { nostr: { getPublicKey: async () => HEX } };
    const out = await getNip07PublicKey(win);
    expect(out.hex).toBe(HEX);
    expect(out.npub.startsWith('npub1')).toBe(true);
  });
  it('wraps a rejected request in a friendly error', async () => {
    const win = { nostr: { getPublicKey: async () => { throw new Error('denied'); } } };
    await expect(getNip07PublicKey(win)).rejects.toThrow(/取得できませんでした/);
  });
});
