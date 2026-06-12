// Pure text-analysis helpers. No DOM / network here so they are easy to test.

// Common English + a handful of Japanese function words / fillers we don't want
// dominating the visualization.
export const STOPWORDS = new Set([
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'so', 'as', 'of', 'at',
  'by', 'for', 'with', 'about', 'to', 'from', 'in', 'on', 'out', 'up', 'down',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
  'have', 'has', 'had', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'my',
  'your', 'this', 'that', 'these', 'those', 'not', 'no', 'yes', 'just', 'can',
  'will', 'would', 'should', 'could', 'there', 'here', 'what', 'who', 'how',
  'rt', 'im', 'dont', 'http', 'https', 'www', 'com',
  // Japanese particles / very common fillers
  'の', 'に', 'は', 'を', 'た', 'が', 'で', 'て', 'と', 'し', 'れ', 'さ', 'ある',
  'いる', 'も', 'する', 'から', 'な', 'こと', 'として', 'い', 'や', 'れる', 'など',
  'なっ', 'ない', 'この', 'ため', 'その', 'あっ', 'よう', 'また', 'もの', 'という',
  'あり', 'まで', 'られ', 'なる', 'へ', 'か', 'だ', 'これ', 'によって', 'により',
  'おり', 'より', 'による', 'ず', 'なり', 'られる', 'において', 'ば', 'なかっ',
  'なく', 'しかし', 'について', 'せ', 'だっ', 'その後', 'できる', 'それ', 'う',
  'ので', 'なお', 'のみ', 'でき', 'き', 'つ', 'における', 'および', 'いう', 'さらに',
  'でも', 'ら', 'たり', 'その他', 'に関する', 'たち', 'ます', 'ん', 'なら', 'に対して',
  'です', 'ました', 'ね', 'よ', 'です', 'ます', 'って', 'てる', 'けど', 'みたい',
  'そう', 'ちゃう', 'です', 'した', 'ので', 'だけ', 'って', 'たい', 'てた', 'です',
]);

const URL_RE = /https?:\/\/\S+/g;
const NOSTR_RE = /\bnostr:\S+/gi;
const MENTION_RE = /\bnpub1[a-z0-9]+/gi;
// Hiragana, katakana, kanji, and full-width katakana.
const JP_RE = /[぀-ゟ゠-ヿ一-龯ｦ-ﾟ]+/g;
// Latin / digit word-ish chunks (keep hashtags-ish words).
const LATIN_RE = /[a-zA-Z][a-zA-Z0-9'’]*/g;

/**
 * Strip URLs, nostr: links, raw npub mentions so they don't pollute frequencies.
 */
export function cleanText(text) {
  return String(text || '')
    .replace(URL_RE, ' ')
    .replace(NOSTR_RE, ' ')
    .replace(MENTION_RE, ' ');
}

/**
 * Heuristic tokenizer.
 * - Latin words are lowercased.
 * - Japanese: extract contiguous JP runs, and for longer runs also emit
 *   character bigrams so meaningful "word-ish" chunks surface, since we have
 *   no morphological analyzer in the browser.
 */
export function tokenize(text) {
  const clean = cleanText(text);
  const tokens = [];

  for (const m of clean.matchAll(LATIN_RE)) {
    const w = m[0].toLowerCase();
    if (w.length >= 2) tokens.push(w);
  }

  for (const m of clean.matchAll(JP_RE)) {
    const run = m[0];
    if (run.length === 1) {
      // single kana/kanji is usually noise unless it's a standalone kanji word
      if (/[一-龯]/.test(run)) tokens.push(run);
      continue;
    }
    // Whole run as a token (captures real words / compounds).
    tokens.push(run);
    // Bigrams give finer-grained signal for long runs.
    if (run.length >= 3) {
      for (let i = 0; i < run.length - 1; i++) {
        tokens.push(run.slice(i, i + 2));
      }
    }
  }

  return tokens;
}

export function isStopword(token) {
  return STOPWORDS.has(token);
}

/**
 * Count token frequencies, dropping stopwords.
 * Returns a Map(token -> count).
 */
export function countFrequencies(tokens) {
  const counts = new Map();
  for (const t of tokens) {
    if (isStopword(t)) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return counts;
}

/**
 * Top N terms from raw text, as [{ term, count }], sorted by count desc.
 * Bigram-vs-fullword overlap is reduced: a bigram is dropped if it is fully
 * contained in a more frequent longer term.
 */
export function topTerms(text, n = 30) {
  const counts = countFrequencies(tokenize(text));
  let entries = [...counts.entries()]
    .map(([term, count]) => ({ term, count }))
    .filter((e) => e.count >= 2 || /[一-龯]/.test(e.term) || e.term.length >= 4)
    .sort((a, b) => b.count - a.count || b.term.length - a.term.length);

  // Drop short JP bigrams that are subsumed by a stronger longer term.
  const strong = entries.filter((e) => e.term.length >= 3);
  entries = entries.filter((e) => {
    if (e.term.length !== 2) return true;
    return !strong.some((s) => s.count >= e.count && s.term !== e.term && s.term.includes(e.term));
  });

  return entries.slice(0, n);
}

// Keyword lexicon → category. Used to color/place words into brain regions.
const CATEGORY_LEXICON = {
  愛情: ['好き', '愛', 'love', '推し', 'かわいい', '可愛', 'すき', 'ありがと', '感謝', 'happy', '嬉し', '幸せ'],
  仕事: ['仕事', '開発', 'work', 'code', 'コード', 'バグ', 'bug', 'pr', 'リリース', 'deploy', 'project', 'タスク', '会議', 'ai', 'プログラ'],
  欲望: ['食べ', '飯', 'ご飯', '酒', 'ビール', 'coffee', 'コーヒー', '寝', '眠', 'sleep', '欲しい', 'お金', 'sats', 'btc', 'bitcoin', 'nostr'],
  遊び: ['ゲーム', 'game', '遊', 'music', '音楽', 'アニメ', '映画', '旅行', '楽し', 'fun', 'play'],
  悩み: ['疲れ', 'つかれ', '不安', '心配', 'やばい', 'つらい', '辛い', '無理', 'しんど', 'tired', 'sad', '悲し', 'ストレス', '泣'],
};

export function categorize(term) {
  const lower = term.toLowerCase();
  for (const [cat, words] of Object.entries(CATEGORY_LEXICON)) {
    if (words.some((w) => lower.includes(w.toLowerCase()) || term.includes(w))) {
      return cat;
    }
  }
  return 'その他';
}

/**
 * Build the structured "brain" model used for rendering.
 * Returns { terms: [{term, count, category, weight}], categories: {cat: total}, total }.
 */
export function buildBrainModel(text, n = 24) {
  const terms = topTerms(text, n);
  const max = terms.length ? terms[0].count : 1;
  const categories = {};
  const enriched = terms.map((t) => {
    const category = categorize(t.term);
    categories[category] = (categories[category] || 0) + t.count;
    return { ...t, category, weight: t.count / max };
  });
  const total = enriched.reduce((s, t) => s + t.count, 0);
  return { terms: enriched, categories, total };
}
