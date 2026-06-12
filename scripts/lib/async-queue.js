// バックプレッシャ付き非同期キュー（producer/consumer 用）。

/** pull がキュー終了時に返すセンチネル。 */
export const QUEUE_DONE = Symbol('QUEUE_DONE');

/**
 * 単純な非同期キュー。
 * - push(item): size < highWaterMark なら即解決、そうでなければ pull で空くまで待つ。
 * - pull(): 次の item を返す。空かつ未close なら待つ。空かつclosed なら QUEUE_DONE。
 * - close(): closed にし、待機中の pull を起こす。
 */
export class AsyncQueue {
  constructor({ highWaterMark = Infinity } = {}) {
    this.highWaterMark = highWaterMark;
    this.closed = false;
    this._buffer = [];
    this._pendingPulls = []; // resolver の配列
    this._pendingPushes = []; // { resolve } の配列（バックプレッシャ解放待ち）
  }

  get size() {
    return this._buffer.length;
  }

  /**
   * item を投入する。バックプレッシャがあれば Promise が後で解決する。
   * @returns {Promise<void>}
   */
  push(item) {
    if (this.closed) throw new Error('AsyncQueue: push after close');

    // 待機中の puller がいれば直接渡す（バッファを経由しない）。
    if (this._pendingPulls.length > 0) {
      const resolve = this._pendingPulls.shift();
      resolve(item);
      return Promise.resolve();
    }

    this._buffer.push(item);

    if (this._buffer.length <= this.highWaterMark) {
      return Promise.resolve();
    }
    // 高水位を超えた → drain されるまで待つ。
    return new Promise((resolve) => {
      this._pendingPushes.push(resolve);
    });
  }

  /**
   * 次の item を取り出す。
   * @returns {Promise<any|typeof QUEUE_DONE>}
   */
  pull() {
    if (this._buffer.length > 0) {
      const item = this._buffer.shift();
      this._drainPushWaiters();
      return Promise.resolve(item);
    }
    if (this.closed) {
      return Promise.resolve(QUEUE_DONE);
    }
    // バッファ空 & 未close → push を待つ。
    return new Promise((resolve) => {
      this._pendingPulls.push(resolve);
    });
  }

  /** バッファが高水位以下に戻ったら、待機中の push を解放する。 */
  _drainPushWaiters() {
    while (this._pendingPushes.length > 0 && this._buffer.length <= this.highWaterMark) {
      const resolve = this._pendingPushes.shift();
      resolve();
    }
  }

  /** キューを閉じる。空になり次第、待機中/今後の pull は QUEUE_DONE を受け取る。 */
  close() {
    this.closed = true;
    // 待機中の pull はバッファが空なので、すべて QUEUE_DONE で起こす。
    while (this._pendingPulls.length > 0) {
      const resolve = this._pendingPulls.shift();
      resolve(QUEUE_DONE);
    }
    // 待機中の push があれば解放（これ以上 pull で消費されない可能性があるため）。
    while (this._pendingPushes.length > 0) {
      const resolve = this._pendingPushes.shift();
      resolve();
    }
  }
}
