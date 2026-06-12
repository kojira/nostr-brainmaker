import { resolveInput, fetchRecentNotes, fetchProfile, npubOf, hasNip07, getNip07PublicKey } from './nostr.js';
import { buildBrainModel } from './analyze.js';
import { rangeLabel, activeDayStats, formatDate } from './daterange.js';
import { renderBrain, exportCanvas } from './brain.js';

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

function setStatus(msg, kind = 'info') {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function run() {
  goBtn.disabled = true;
  exportBtn.disabled = true;
  metaEl.innerHTML = '';
  try {
    const days = Number(daysSel.value) || 7;
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
      describe({ pubkey, usedRelays, events, days, profile });
      return;
    }

    const text = events.map((e) => e.content).join('\n');
    const model = buildBrainModel(text, 24);

    renderBrain(canvas, model, {
      name: lastName,
      footer: `${events.length} notes · ${days}d · nostr-brainmaker`,
    });

    setStatus(`完成！ ${events.length} 件のノートから ${model.terms.length} 語を可視化しました。`, 'ok');
    exportBtn.disabled = false;
    describe({ pubkey, usedRelays, events, days, profile, model });
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), 'error');
  } finally {
    goBtn.disabled = false;
  }
}

function renderEmpty() {
  const ctx = canvas.getContext('2d');
  canvas.width = 1000;
  canvas.height = 1000;
  ctx.fillStyle = '#fff7fb';
  ctx.fillRect(0, 0, 1000, 1000);
  ctx.fillStyle = '#b08a96';
  ctx.textAlign = 'center';
  ctx.font = '500 30px system-ui, sans-serif';
  ctx.fillText('ノートが見つかりませんでした', 500, 500);
}

function describe({ pubkey, usedRelays, events, days, profile, model }) {
  // The *requested* window — always the full N days, even on no-post days.
  const requestedRange = rangeLabel(days);

  // Optional secondary line: the span that actually had posts.
  const stats = activeDayStats(events);
  const activeLine = stats
    ? `<li><b>投稿のあった期間:</b> ${escapeHtml(formatDate(stats.firstSec * 1000))} 〜 ${escapeHtml(formatDate(stats.lastSec * 1000))}（${stats.activeDays} 日に投稿）</li>`
    : '';

  const topList = model
    ? model.terms.slice(0, 12).map((t) => `<span class="chip" style="--c:${chipColor(t.category)}">${escapeHtml(t.term)} <b>${t.count}</b></span>`).join(' ')
    : '';

  metaEl.innerHTML = `
    <div class="meta-card">
      <h3>取得したデータ</h3>
      <ul>
        <li><b>著者:</b> ${escapeHtml(profile?.display_name || profile?.name || '(プロフィール無し)')} <code>${escapeHtml(npubOf(pubkey))}</code></li>
        <li><b>ノート数:</b> ${events.length} 件（直近 ${days} 日間）</li>
        <li><b>対象期間（直近 ${days} 日間）:</b> ${escapeHtml(requestedRange)}</li>
        ${activeLine}
        <li><b>問い合わせたリレー:</b><br>${usedRelays.map((r) => `<code>${escapeHtml(r)}</code>`).join(' ')}</li>
      </ul>
      ${topList ? `<h3>トップ語</h3><div class="chips">${topList}</div>` : ''}
    </div>`;
}

function chipColor(cat) {
  return {
    愛情: '#ff6b9d', 仕事: '#4d96ff', 欲望: '#ffa24d',
    遊び: '#42c98e', 悩み: '#9b6bff', その他: '#8a8f99',
  }[cat] || '#8a8f99';
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

// Surface whether a NIP-07 extension is available (best-effort hint only).
if (!hasNip07()) {
  nip07Btn.title = 'NIP-07 対応のブラウザ拡張機能が必要です';
}
exportBtn.addEventListener('click', () => {
  const safe = lastName.replace(/[^\w぀-ヿ一-鿿-]/g, '_').slice(0, 24) || 'nostr';
  exportCanvas(canvas, `nostr-brain-${safe}.png`);
});

// Allow ?npub=... deep links.
const params = new URLSearchParams(location.search);
const pre = params.get('npub') || params.get('pubkey');
if (pre) {
  input.value = pre;
  run();
}
