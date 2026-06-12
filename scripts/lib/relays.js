// リレー一覧と時間スライス計算。

/** 設計ドキュメントのリレー構成。 */
export const RELAYS = [
  'wss://relay.nostr.band',
  'wss://yabu.me',
  'wss://r.kojira.io',
  'wss://relay-jp.nostr.wirednet.jp',
  'wss://nos.lol',
  'wss://relay.damus.io',
];

/**
 * 直近 windowDays を sliceDays チャンクに分割（新しい順）。
 * @returns {Array<{sinceSec:number, untilSec:number}>}
 */
export function timeSlices({ windowDays, sliceDays, nowSec } = {}) {
  const now = Number.isFinite(nowSec) ? Math.floor(nowSec) : Math.floor(Date.now() / 1000);
  const win = Math.max(1, Math.floor(windowDays || 1));
  const slice = Math.max(1, Math.floor(sliceDays || 1));
  const day = 86400;
  const startSec = now - win * day; // ウィンドウ全体の下限。

  const slices = [];
  let until = now;
  while (until > startSec) {
    const since = Math.max(startSec, until - slice * day);
    slices.push({ sinceSec: since, untilSec: until });
    if (since <= startSec) break;
    until = since;
  }
  return slices; // 新しい順。
}
