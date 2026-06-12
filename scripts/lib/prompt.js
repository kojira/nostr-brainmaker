// Gemini ラベリングプロンプトの組み立て。ラベル一覧は labels.js を単一ソースとする。
import { buildLabelListText } from './labels.js';

/** タスクのヘッダ行（1パス目）。 */
export const TASK_HEADER =
  '次のNostr投稿に対して、頭の中を最もよく表す1文字ラベルを1つだけ選んでください。';

/** 判断ルールのブロック。 */
export const JUDGE_RULES = [
  '判断ルール:',
  '- まず内容の中心感情/欲求/関心を1つに要約する',
  '- 食べ物そのものは 食、疲れている/休みたいは 休 or 疲、学び/技術理解は 学、不可解さは 謎',
  '- 特定の既存ラベルに無理に寄せにくければ 分類不能 を使う',
  '- 出力はJSONのみ。説明文やコードブロックは禁止',
].join('\n');

/** JSON スキーマブロック。 */
export const SCHEMA_BLOCK = [
  'JSON schema:',
  '{',
  '  "label": "ラベル文字",',
  '  "label_id": 0,',
  '  "confidence": 0.0,',
  '  "rationale": "日本語1-2文",',
  '  "is_uncertain": false',
  '}',
].join('\n');

/**
 * 1パス目のラベリングプロンプトを組み立てる（pilot と同一構造）。
 */
export function buildLabelingPrompt(content) {
  return [
    TASK_HEADER,
    '',
    'ラベル一覧:',
    buildLabelListText(),
    '',
    JUDGE_RULES,
    '',
    SCHEMA_BLOCK,
    '',
    '投稿本文:',
    String(content == null ? '' : content),
  ].join('\n');
}

/**
 * 2パス目（再検討）プロンプト。低信頼/不確実ケースを再評価させる。
 * 1回目の推定 pass1Label を提示し、2-3の最有力候補を比較して最終1ラベルを決めさせる。
 */
export function buildRefinementPrompt(content, pass1Label) {
  const header = [
    'これは低信頼または不確実と判定されたNostr投稿の再検討です。',
    `1回目の推定ラベルは「${pass1Label}」でした。`,
    'もう一度内容を慎重に読み、別のラベルがより適切でないかを検討してください。',
    '最有力候補を2〜3個挙げて比較したうえで、最終的に最も適切な1文字ラベルを1つだけ確定してください。',
  ].join('\n');

  return [
    header,
    '',
    'ラベル一覧:',
    buildLabelListText(),
    '',
    JUDGE_RULES,
    '',
    SCHEMA_BLOCK,
    '',
    '投稿本文:',
    String(content == null ? '' : content),
  ].join('\n');
}
