// チェックポイント/JSONL ファイル I/O（クラッシュ耐性のための append + atomic write）。
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** path の親ディレクトリを作る。 */
function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * 1行 JSON を追記する（mkdir -p してから）。
 */
export function appendJsonl(path, obj) {
  ensureDir(path);
  appendFileSync(path, JSON.stringify(obj) + '\n', 'utf8');
}

/**
 * JSON を読む。存在しなければ null。
 */
export function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * tmp に書いてから rename（アトミック書き込み）。
 */
export function writeJsonAtomic(path, obj) {
  ensureDir(path);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  renameSync(tmp, path);
}

/**
 * JSONL を読み、okKey===true の項目の key 値の Set を返す（resume 用）。
 */
export function loadDoneIds(jsonlPath, { key = 'event_id', okKey = 'ok' } = {}) {
  const done = new Set();
  if (!existsSync(jsonlPath)) return done;
  let raw;
  try {
    raw = readFileSync(jsonlPath, 'utf8');
  } catch {
    return done;
  }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      if (obj && obj[okKey] === true && obj[key] != null) {
        done.add(obj[key]);
      }
    } catch {
      // 壊れた行は無視。
    }
  }
  return done;
}

/**
 * JSONL を全行パースして配列で返す（最後の値を resume 時に復元する用）。
 */
export function readJsonl(jsonlPath) {
  const out = [];
  if (!existsSync(jsonlPath)) return out;
  let raw;
  try {
    raw = readFileSync(jsonlPath, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // skip
    }
  }
  return out;
}
