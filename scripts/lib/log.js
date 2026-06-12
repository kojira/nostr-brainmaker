// 軽量な構造化ロガー（stderr）+ 名前付きカウンタ。

function ts() {
  return new Date().toISOString();
}

function emit(level, args) {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  process.stderr.write(`[${ts()}] ${level} ${msg}\n`);
}

export const log = {
  info: (...args) => emit('INFO', args),
  warn: (...args) => emit('WARN', args),
  error: (...args) => emit('ERROR', args),
  progress: (...args) => emit('PROGRESS', args),
};

/** 名前付きカウントを蓄積するヘルパー。 */
export class Counters {
  constructor() {
    this.counts = {};
  }

  inc(name, by = 1) {
    this.counts[name] = (this.counts[name] || 0) + by;
    return this.counts[name];
  }

  get(name) {
    return this.counts[name] || 0;
  }

  set(name, val) {
    this.counts[name] = val;
    return val;
  }

  snapshot() {
    return { ...this.counts };
  }
}
