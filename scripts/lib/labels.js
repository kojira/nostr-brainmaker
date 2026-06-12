// 46ラベルの「1文字」分類セット（+ QA専用ラベル 分類不能=46）。
// このファイルが唯一の真実のソース。プロンプト・スキーマ・検証はここを参照する。

/** 46文字のラベル（順序が label_id 0..45 を定義する）。 */
export const LABELS = [
  '愛', '欲', '悪', '遊', 'H', '秘', '食', '友', '悩', '休',
  '嘘', '家', '妄', '想', '気', '無', '恐', '敬', '好', '逃',
  '怒', '抱', '寂', '楽', '嫌', '苦', '虜', '疑', '告', '疲',
  '忘', '敵', '餌', '学', '泣', '羨', '癒', '幸', '妬', '変',
  '貧', '謎', '仏', '犬', '猫', '国',
];

/** QA専用ラベル（ラベリング時のみ許可されるエスケープハッチ）。 */
export const QA_LABEL = '分類不能';
export const QA_LABEL_ID = 46;

/** char -> 定義文（QAラベルも含む）。 */
export const LABEL_DEFS = {
  '愛': '愛情・親愛・やさしさ・会いたさ',
  '欲': '欲望・ほしさ・手に入れたい気持ち',
  '悪': '攻撃性・悪意・意地の悪さ',
  '遊': '遊び・娯楽・楽しみたい気分',
  'H': '性的な関心・下ネタ寄りの欲望',
  '秘': '秘密・隠し事・内緒',
  '食': '食べること・飲食そのもの',
  '友': '友人・仲間・誰かとのつながり',
  '悩': '不安・悩み・迷い',
  '休': '休息・眠い・休みたい',
  '嘘': 'ごまかし・虚勢・本音を隠す感じ',
  '家': '家・家庭・帰る場所',
  '妄': '妄想・誇張・飛躍した想像',
  '想': '思い・考え・しみじみした気持ち',
  '気': '気分・ノリ・空気感',
  '無': '虚無・何もない・どうでもよさ',
  '恐': '恐れ・ビビり・怖さ',
  '敬': '尊敬・礼儀・うやまい',
  '好': '好意・好き・好み',
  '逃': '逃げたい・避けたい・離れたい',
  '怒': '怒り・いらだち',
  '抱': '抱きしめたい・包みたい・密着したい',
  '寂': 'さみしさ・心細さ',
  '楽': '楽さ・気楽さ・ラクしたい',
  '嫌': '嫌悪・拒否感・うんざり',
  '苦': '苦しさ・しんどさ・つらさ',
  '虜': '夢中・とりこ・強く惹かれて離れない',
  '疑': '疑い・不信・半信半疑',
  '告': '告白・伝達・はっきり言いたい',
  '疲': '疲労・消耗',
  '忘': '忘れたい・忘れていた・記憶の抜け',
  '敵': '敵対・対立・相手を敵とみなす',
  '餌': 'エサ・釣り・食わせる/食いつく比喩',
  '学': '勉強・学び・理解したい',
  '泣': '泣きたい・感極まる・しんみり',
  '羨': 'うらやましさ',
  '癒': '癒やし・なごみ',
  '幸': '幸福・うれしさ・満たされ感',
  '妬': '嫉妬・ねたみ',
  '変': '変さ・奇妙さ・クセの強さ',
  '貧': '貧しさ・不足・余裕のなさ',
  '謎': '意味不明・不可解',
  '仏': '慈悲・悟り・落ち着き',
  '犬': '犬っぽさ・忠犬・犬への関心',
  '猫': '猫っぽさ・猫への関心・気まぐれ',
  '国': '国家・社会・公共への意識',
  [QA_LABEL]: '上のどれにも素直に当てはまらない、または文脈不足',
};

/** ラベルセットのバージョン文字列。 */
export const LABEL_SET_VERSION = 'observed-46-plus-unclassifiable';

/** id -> char（0..45 + 46:分類不能）。 */
export const ID_TO_LABEL = (() => {
  const m = {};
  LABELS.forEach((c, i) => { m[i] = c; });
  m[QA_LABEL_ID] = QA_LABEL;
  return m;
})();

/** char -> id。 */
export const LABEL_TO_ID = (() => {
  const m = {};
  LABELS.forEach((c, i) => { m[c] = i; });
  m[QA_LABEL] = QA_LABEL_ID;
  return m;
})();

/**
 * ラベル文字を正規化する。全角Ｈ→半角H、前後空白除去。
 */
export function normalizeLabelChar(s) {
  return String(s == null ? '' : s).trim().replace(/Ｈ/g, 'H');
}

/**
 * ラベルが有効か。allowQA=true のとき 分類不能 も許可。
 */
export function isValidLabel(label, { allowQA = false } = {}) {
  const c = normalizeLabelChar(label);
  if (c === QA_LABEL) return !!allowQA;
  return Object.prototype.hasOwnProperty.call(LABEL_TO_ID, c) && LABELS.includes(c);
}

/**
 * ラベル文字に対応する label_id を返す。未知なら -1。
 */
export function labelIdOf(label) {
  const c = normalizeLabelChar(label);
  return Object.prototype.hasOwnProperty.call(LABEL_TO_ID, c) ? LABEL_TO_ID[c] : -1;
}

/**
 * プロンプト用の「- id: char = def」行（0..46、分類不能を含む）を生成。
 */
export function buildLabelListText() {
  const lines = LABELS.map((c, i) => `- ${i}: ${c} = ${LABEL_DEFS[c]}`);
  lines.push(`- ${QA_LABEL_ID}: ${QA_LABEL} = ${LABEL_DEFS[QA_LABEL]}`);
  return lines.join('\n');
}

/**
 * 配布用のラベルマップ（label_map.json に書き出す）。
 */
export function buildLabelMap() {
  return {
    version: LABEL_SET_VERSION,
    count: 46,
    labels: LABELS.map((c, i) => ({ id: i, char: c, def: LABEL_DEFS[c] })),
    qa: { id: QA_LABEL_ID, char: QA_LABEL, def: LABEL_DEFS[QA_LABEL] },
  };
}
