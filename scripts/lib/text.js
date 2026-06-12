// テキスト前処理・ハッシュ・文字比率ヘルパー。
// URL/nostr/npub の除去は src/analyze.js の正規表現をミラーする。
import { createHash } from 'node:crypto';

const URL_RE = /https?:\/\/\S+/g;
const NOSTR_RE = /\bnostr:\S+/gi;
const MENTION_RE = /\bnpub1[a-z0-9]+/gi;

// ひらがな・カタカナ（全角カナ含む）。
const KANA_RE = /[぀-ゟ゠-ヿｦ-ﾟ]/g;
// 漢字。
const KANJI_RE = /[一-龯]/g;
// 半角ラテン小文字（lowercase 後に数える）。
const LATIN_RE = /[a-z]/g;

/**
 * URL・nostr: リンク・npub メンションを空白に置換する。
 */
export function cleanText(t) {
  return String(t || '')
    .replace(URL_RE, ' ')
    .replace(NOSTR_RE, ' ')
    .replace(MENTION_RE, ' ');
}

/**
 * ハッシュ/近似重複検出用の正規化：clean → 空白圧縮 → lowercase → 記号除去。
 */
export function normalizeContent(t) {
  const clean = cleanText(t);
  return clean
    .toLowerCase()
    // 記号・句読点・絵文字などを除去（英数字とCJK/かなは残す）。
    .replace(/[^0-9a-z぀-ヿ㐀-鿿ｦ-ﾟ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 正規化済み内容の sha256 hex。
 */
export function contentHash(t) {
  return createHash('sha256').update(normalizeContent(t), 'utf8').digest('hex');
}

/**
 * cleanText 上で算出する文字比率。
 * Kana = ひらがな/カタカナ（全角カナ含む）, CJK = 漢字+かな, latin = a-z。
 */
export function charRatios(t) {
  const clean = cleanText(t);
  const length = clean.length;
  if (length === 0) {
    return { length: 0, kanaRatio: 0, cjkRatio: 0, latinRatio: 0 };
  }
  const kana = (clean.match(KANA_RE) || []).length;
  const kanji = (clean.match(KANJI_RE) || []).length;
  const latin = (clean.toLowerCase().match(LATIN_RE) || []).length;
  const cjk = kana + kanji;
  return {
    length,
    kanaRatio: kana / length,
    cjkRatio: cjk / length,
    latinRatio: latin / length,
  };
}
