// レート制限（スライディング60秒ウィンドウ）と並列実行プール。

/**
 * RateLimiter: 直近60秒で rpm リクエストまでを許可する。
 * acquire() はスロットが空くまで待ってから解決する。
 */
export class RateLimiter {
  constructor({ rpm = 60, windowMs = 60000 } = {}) {
    this.rpm = Math.max(1, Math.floor(rpm));
    this.windowMs = windowMs;
    this.timestamps = [];
  }

  _now() {
    return Date.now();
  }

  async acquire() {
    // ループ：ウィンドウ内の古い記録を捨て、空きが出るまで待つ。
    // 競合しても for-await のように再評価するためループで実装。
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = this._now();
      const cutoff = now - this.windowMs;
      // ウィンドウ外を除去。
      while (this.timestamps.length && this.timestamps[0] <= cutoff) {
        this.timestamps.shift();
      }
      if (this.timestamps.length < this.rpm) {
        this.timestamps.push(this._now());
        return;
      }
      // 最古の記録がウィンドウから外れるまで待つ。
      const waitMs = this.timestamps[0] + this.windowMs - now + 1;
      await new Promise((r) => setTimeout(r, Math.max(1, waitMs)));
    }
  }
}

/**
 * 上限付き並列でワーカーを走らせる。結果は元の順序で返す。
 * 単一ワーカーの throw で全体が reject することはなく、その項目のエラーを捕捉する。
 * @returns {Promise<Array<{ok:boolean, value?:any, error?:Error, index:number}>>}
 */
export async function runPool(items, worker, { concurrency = 5, onItem } = {}) {
  const list = Array.from(items);
  const results = new Array(list.length);
  let cursor = 0;
  const n = Math.max(1, Math.floor(concurrency));

  async function runner() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      let res;
      try {
        const value = await worker(list[index], index);
        res = { ok: true, value, index };
      } catch (error) {
        res = { ok: false, error, index };
      }
      results[index] = res;
      if (onItem) {
        try { onItem(res, index, list.length); } catch { /* onItem は失敗しても無視 */ }
      }
    }
  }

  const runners = [];
  for (let i = 0; i < Math.min(n, list.length); i++) {
    runners.push(runner());
  }
  await Promise.all(runners);
  return results;
}
