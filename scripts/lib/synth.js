// 逆生成（synthetic backfill）の純ロジック。I/O・ネットワークなし。
// 不足ラベルの計算 → 生成プロンプト組み立て → 応答パース → 候補フィルタ →
// 学習データ互換レコード化、をすべて純関数として提供する。
import {
  LABELS, LABEL_DEFS, labelIdOf, isValidLabel, normalizeLabelChar, buildLabelListText,
} from './labels.js';
import { contentHash } from './text.js';
import { detectJapanese } from './japanese.js';

/**
 * ラベルごとの不足数を計算する。
 * counts は {ラベル文字: 件数}（欠けているラベルは 0 扱い）。
 * labels を指定するとそのラベルだけに限定する（need 0 でも結果に含める。
 * 無効なラベルは throw）。未指定なら have < min の全ラベル。
 * @returns {Array<{label:string, label_id:number, have:number, need:number}>} need 降順。
 */
export function computeDeficits(counts, { min = 50, labels = null } = {}) {
  let targets;
  if (labels) {
    targets = labels.map((l) => {
      const c = normalizeLabelChar(l);
      if (!isValidLabel(c)) throw new Error(`無効なラベル: ${l}`);
      return c;
    });
  } else {
    targets = LABELS;
  }
  const out = [];
  for (const label of targets) {
    const have = Number((counts && counts[label]) || 0);
    const need = Math.max(0, min - have);
    if (labels || need > 0) {
      out.push({ label, label_id: labelIdOf(label), have, need });
    }
  }
  // need 降順、同値は label_id 昇順（決定的な順序）。
  out.sort((a, b) => b.need - a.need || a.label_id - b.label_id);
  return out;
}

/**
 * 指定ラベルの投稿を count 件逆生成させる日本語プロンプトを組み立てる。
 * examples は文体の参考（実投稿）として最大 examples.length 件まで埋め込む。
 */
export function buildSynthesisPrompt(label, { count, examples = [] } = {}) {
  const c = normalizeLabelChar(label);
  if (!isValidLabel(c)) throw new Error(`無効なラベル: ${label}`);
  const def = LABEL_DEFS[c];

  const lines = [
    'あなたは日本語のSNS（Nostr）投稿を書く生成器です。',
    `次の「頭の中ラベル」が支配的な心理状態として明確に読み取れる、リアルで多様な短い投稿を${count}件書いてください。`,
    '',
    `対象ラベル: ${c} = ${def}`,
    '',
    '文体・制約:',
    '- 1〜120文字程度の日本語。SNSの独り言・つぶやき口調（カジュアル、口語、絵文字や顔文字は控えめなら可）',
    '- ハッシュタグの乱用は禁止。ユーザー名・URL・宣伝文は入れない',
    '- 話題・言い回し・長さをばらけさせる（同じパターンの繰り返し禁止）',
    '',
    '重要: 以下の全ラベル一覧のうち、書いた投稿が対象ラベル以外のラベルにより自然に分類されてはいけません。',
    '対象ラベルが最も支配的に読み取れる文面にしてください。',
    '',
    'ラベル一覧:',
    buildLabelListText(),
  ];

  if (Array.isArray(examples) && examples.length > 0) {
    lines.push('', '文体の参考（実際の投稿。コピーや改変流用は禁止。雰囲気・口調だけ参考にする）:');
    for (const ex of examples) {
      lines.push(`- ${String(ex).replace(/\s+/g, ' ').trim()}`);
    }
  }

  lines.push(
    '',
    '出力は次のJSONのみ。説明文やコードブロックは禁止:',
    '{"posts": ["投稿1", "投稿2", ...]}',
  );
  return lines.join('\n');
}

/**
 * 逆生成応答（callGemini の parsed）をパースする。
 * {posts:[...]} の文字列要素のみ受理し、trim して空文字を捨てる。
 * @returns {{ok:boolean, posts:string[], error:(string|null)}}
 */
export function parseSynthesisResponse(parsed) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.posts)) {
    return { ok: false, posts: [], error: 'invalid_posts' };
  }
  const posts = parsed.posts
    .filter((p) => typeof p === 'string')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (posts.length === 0) {
    return { ok: false, posts: [], error: 'empty_posts' };
  }
  return { ok: true, posts, error: null };
}

/**
 * 生成候補をフィルタする：長さ・日本語判定・重複（バッチ内 + seenHashes）。
 * seenHashes は contentHash(text)（内部で normalizeContent 済み）の Set。
 * @returns {{accepted:string[], rejected:Array<{content:string, reason:string}>}}
 */
export function filterCandidates(candidates, { seenHashes = new Set(), minLen = 5, maxLen = 200 } = {}) {
  const accepted = [];
  const rejected = [];
  const batchHashes = new Set();
  for (const raw of candidates || []) {
    const content = String(raw == null ? '' : raw).trim();
    if (content.length < minLen) {
      rejected.push({ content, reason: 'too_short' });
      continue;
    }
    if (content.length > maxLen) {
      rejected.push({ content, reason: 'too_long' });
      continue;
    }
    const jp = detectJapanese(content, { minLength: minLen });
    if (!jp.isJapanese) {
      rejected.push({ content, reason: jp.excludeReason || 'not_japanese' });
      continue;
    }
    const h = contentHash(content);
    if (seenHashes.has(h) || batchHashes.has(h)) {
      rejected.push({ content, reason: 'duplicate' });
      continue;
    }
    batchHashes.add(h);
    accepted.push(content);
  }
  return { accepted, rejected };
}

/**
 * 逆生成投稿を labeled レコード互換の形にする。
 * 合成データの目印: event_id は 'syn-' プレフィックス、pubkey は 'synthetic'、
 * source は 'synthetic:<model>'、synthetic:true、verified を持つ。
 * createdAt（unix 秒）は呼び出し側が渡す（この関数は Date を見ない）。
 */
export function makeSyntheticRecord(content, label, {
  model, verified, confidence = null, rationale = null, createdAt,
} = {}) {
  const c = normalizeLabelChar(label);
  return {
    event_id: `syn-${contentHash(content)}`,
    pubkey: 'synthetic',
    created_at: createdAt,
    content,
    label: c,
    label_id: labelIdOf(c),
    confidence: confidence == null ? 0.9 : Number(confidence),
    rationale: rationale || '逆生成（synthetic）',
    is_uncertain: false,
    pass: 1,
    source: `synthetic:${model}`,
    synthetic: true,
    verified: !!verified,
  };
}
