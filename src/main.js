import { resolveInput, fetchRecentNotes, fetchProfile, npubOf, hasNip07, getNip07PublicKey } from './nostr.js';
import { rangeLabel, activeDayStats, formatDate } from './daterange.js';
import { renderBrainFromPosts, exportCanvas } from './brain.js';
import { createClassifier } from './classifier/adapter.js';
import { registerDefaultBackends } from './classifier/backends/transformersjs.js';

const $ = (id) => document.getElementById(id);
const input = $('npub-input');
const goBtn = $('go-btn');
const nip07Btn = $('nip07-btn');
const exportBtn = $('export-btn');
const statusEl = $('status');
const metaEl = $('meta');
const canvas = $('brain-canvas');
const daysSel = $('days');

let lastName = 'anonymous';

registerDefaultBackends();
const classifier = createClassifier({ baseUrl: import.meta.env.BASE_URL });

// Lazily initialize the (heavy) browser model only when analysis actually runs.
// Eager init at module load caused mobile browsers to crash before use.
let classifierReady = null;
function ensureClassifierReady() {
  if (!classifierReady) {
    classifierReady = classifier.init();
  }
  return classifierReady;
}

function setStatus(msg, kind = 'info') {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function requireClassifierReady() {
  const state = await ensureClassifierReady();
  if (state !== 'ready') {
    throw new Error(`学習済み分類器を初期化できません: ${classifier.reason || 'unknown error'}`);
  }
}

async function run() {
  goBtn.disabled = true;
  exportBtn.disabled = true;
  metaEl.innerHTML = '';
  try {
    const days = Number(daysSel.value) || 7;
    setStatus('分類器を確認中…');
    await requireClassifierReady();

    setStatus('入力を解析中…');
    const { pubkey, relays } = resolveInput(input.value);

    setStatus('プロフィールとノートを取得中…');
    const [profile, result] = await Promise.all([
      fetchProfile(pubkey, { relays }).catch(() => null),
      fetchRecentNotes(pubkey, { days, relays, onProgress: setStatus }),
    ]);

    const { events, relays: usedRelays } = result;
    lastName = profile?.display_name || profile?.name || npubOf(pubkey).slice(0, 12) + '…';

    if (!events.length) {
      setStatus(`直近 ${days} 日間のノートが見つかりませんでした。別のリレーや期間を試してください。`, 'warn');
      renderEmpty();
      describe({ pubkey, usedRelays, events, days, profile, classification: null });
      return;
    }

    setStatus('投稿を分類中…');
    const classification = await classifier.classifyPosts(events.map((e) => e.content));
    renderBrainFromPosts(canvas, classification.perPost, {
      name: lastName,
      footer: `${classification.posts} posts · ${days}d · nostr-brainmaker`,
    });

    setStatus(`完成！ ${classification.posts} 件の投稿を 1投稿=1文字 で可視化しました。`, 'ok');
    exportBtn.disabled = false;
    describe({ pubkey, usedRelays, events, days, profile, classification });
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), 'error');
    renderEmpty(err.message || 'エラーが発生しました');
  } finally {
    goBtn.disabled = false;
  }
}

function renderEmpty(message = 'ノートが見つかりませんでした') {
  const ctx = canvas.getContext('2d');
  canvas.width = 1000;
  canvas.height = 1000;
  ctx.fillStyle = '#fff7fb';
  ctx.fillRect(0, 0, 1000, 1000);
  ctx.fillStyle = '#b08a96';
  ctx.textAlign = 'center';
  ctx.font = '500 30px system-ui, sans-serif';
  ctx.fillText(message, 500, 500);
}

function describe({ pubkey, usedRelays, events, days, profile, classification = null }) {
  const requestedRange = rangeLabel(days);
  const stats = activeDayStats(events);
  const activeLine = stats
    ? `<li><b>投稿のあった期間:</b> ${escapeHtml(formatDate(stats.firstSec * 1000))} 〜 ${escapeHtml(formatDate(stats.lastSec * 1000))}（${stats.activeDays} 日に投稿）</li>`
    : '';

  const modeLine = `<li><b>分類器:</b> ${escapeHtml(classifier.manifest?.model?.name || 'unknown')}（${classification ? `${classification.posts} 投稿を分類` : '待機中'}）</li>`;
  const errorLine = '';
  const labelList = classification && classification.labels.length
    ? classification.labels.map((label) => `<li><b>${escapeHtml(label.char)}</b> ${label.count} 件</li>`).join('')
    : '<li>分類対象の投稿はありません</li>';

  metaEl.innerHTML = `
    <div class="meta-card">
      <h3>取得したデータ</h3>
      <ul>
        <li><b>著者:</b> ${escapeHtml(profile?.display_name || profile?.name || '(プロフィール無し)')} <code>${escapeHtml(npubOf(pubkey))}</code></li>
        <li><b>ノート数:</b> ${events.length} 件（直近 ${days} 日間）</li>
        ${modeLine}
        ${errorLine}
        <li><b>対象期間（直近 ${days} 日間）:</b> ${escapeHtml(requestedRange)}</li>
        ${activeLine}
        <li><b>問い合わせたリレー:</b><br>${usedRelays.map((r) => `<code>${escapeHtml(r)}</code>`).join(' ')}</li>
      </ul>
      <h3>ラベル件数</h3>
      <ul class="label-counts">${labelList}</ul>
    </div>`;
}

async function useNip07() {
  nip07Btn.disabled = true;
  const original = nip07Btn.textContent;
  nip07Btn.textContent = '取得中…';
  try {
    setStatus('NIP-07 拡張機能から公開鍵を取得中…');
    const { npub } = await getNip07PublicKey();
    input.value = npub;
    setStatus('公開鍵を取得しました。脳内を解析します…', 'ok');
    await run();
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), 'error');
  } finally {
    nip07Btn.disabled = false;
    nip07Btn.textContent = original;
  }
}

goBtn.addEventListener('click', run);
nip07Btn.addEventListener('click', useNip07);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') run();
});

if (!hasNip07()) {
  nip07Btn.title = 'NIP-07 対応のブラウザ拡張機能が必要です';
}
exportBtn.addEventListener('click', () => {
  const safe = lastName.replace(/[^\w぀-ヿ一-鿿-]/g, '_').slice(0, 24) || 'nostr';
  exportCanvas(canvas, `nostr-brain-${safe}.png`);
});

const params = new URLSearchParams(location.search);
const pre = params.get('npub') || params.get('pubkey');
if (pre) {
  input.value = pre;
  run();
}
