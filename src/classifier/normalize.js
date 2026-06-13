// Input normalization for the trained 1-char classifier.
// MUST stay in sync with training-time preprocessing and browser inference.
const URL_RE = /https?:\/\/\S+/g;
const NOSTR_RE = /\bnostr:\S+/gi;
const MENTION_RE = /\bnpub1[a-z0-9]+/gi;

export function normalizeForClassifier(text) {
  return String(text || '')
    .replace(URL_RE, ' ')
    .replace(NOSTR_RE, ' ')
    .replace(MENTION_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
