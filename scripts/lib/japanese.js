// 日本語判定ヒューリスティック。文字比率を主信号、franc を副信号として使う。
import { franc } from 'franc';
import { cleanText, charRatios } from './text.js';

// franc が「自信を持って非日本語」と判断したと見なす言語コード。
// 'und'（短すぎ/不明）は除外理由にしない。
const NON_JP_CONFIDENT = new Set(['cmn', 'kor', 'eng', 'rus', 'spa', 'fra', 'deu', 'por', 'ita', 'tha', 'vie', 'ind']);

/**
 * 内容が日本語サンプルとして適切かを判定する。
 * @returns {{isJapanese:boolean, kanaRatio:number, cjkRatio:number, length:number,
 *            latinRatio:number, francLang:string, reasons:string[], excludeReason:(string|null)}}
 */
export function detectJapanese(content, { minLength = 5, kanaMin = 0.12, cjkMin = 0.35 } = {}) {
  const { length, kanaRatio, cjkRatio, latinRatio } = charRatios(content);
  const reasons = [];
  let excludeReason = null;
  let isJapanese = false;

  // franc は元の content（cleanText 前）に対して掛ける（言語検出は記号に強い）。
  const francLang = franc(String(content || ''));

  // 短すぎ。
  if (length < minLength) {
    return {
      isJapanese: false,
      kanaRatio, cjkRatio, length, latinRatio,
      francLang,
      reasons: ['too_short'],
      excludeReason: 'too_short',
    };
  }

  // ヒューリスティック受理条件。
  const heuristicAccept = kanaRatio >= kanaMin || cjkRatio >= cjkMin;

  if (!heuristicAccept) {
    // ラテンのみ / URLのみ / 絵文字のみ など。
    reasons.push('not_japanese');
    return {
      isJapanese: false,
      kanaRatio, cjkRatio, length, latinRatio,
      francLang,
      reasons,
      excludeReason: 'not_japanese',
    };
  }

  isJapanese = true;

  // 境界線フラグ（レビューキュー用）：kanaRatio が kanaMin の ±0.04 以内。
  if (Math.abs(kanaRatio - kanaMin) <= 0.04) {
    reasons.push('borderline');
  }

  // 副信号 franc：かな比率0 かつ franc が自信を持って非日本語なら救済除外。
  // （CJK比率で通過した中国語/韓国語-only 文面を弾く）。
  if (kanaRatio === 0 && francLang !== 'jpn' && francLang !== 'und' && NON_JP_CONFIDENT.has(francLang)) {
    isJapanese = false;
    excludeReason = 'franc_non_jp';
    reasons.push('franc_non_jp');
  }

  return {
    isJapanese,
    kanaRatio, cjkRatio, length, latinRatio,
    francLang,
    reasons,
    excludeReason,
  };
}
