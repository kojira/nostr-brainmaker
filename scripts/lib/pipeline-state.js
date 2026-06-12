// パイプラインの進捗状態: ラベル別カウント、seen 集合、完了判定。
import { LABELS } from './labels.js';

export class PipelineState {
  constructor({ labels = LABELS } = {}) {
    this._labels = labels.slice();
    this._targetSet = new Set(this._labels);
    this.labeledByEvent = new Map(); // event_id -> labeled record
    this.seen = new Set();           // event_id
    this._counts = new Map();        // target label -> count
    for (const l of this._labels) this._counts.set(l, 0);
    this._qaOrOther = new Map();     // non-target label -> count
  }

  /**
   * checkpoint レコード列から state を構築する。
   * ok:true は recordLabeled、ok:true/false いずれも event_id を seen にする。
   * 同一 event_id の最後の ok:true が勝つ（recordLabeled が relabel を処理）。
   */
  static fromCheckpoint(records, { labels = LABELS } = {}) {
    const state = new PipelineState({ labels });
    for (const rec of records || []) {
      if (!rec || rec.event_id == null) continue;
      if (rec.ok === true) {
        state.recordLabeled(rec);
      } else {
        // ok:false でも seen 扱いにして再ラベルしない。
        state.markSeen(rec.event_id);
      }
    }
    return state;
  }

  _bump(label, delta) {
    if (this._targetSet.has(label)) {
      this._counts.set(label, (this._counts.get(label) || 0) + delta);
    } else {
      const next = (this._qaOrOther.get(label) || 0) + delta;
      if (next <= 0) this._qaOrOther.delete(label);
      else this._qaOrOther.set(label, next);
    }
  }

  /** ラベル済みレコードを記録する。relabel 時は旧カウントを減らす。 */
  recordLabeled(labeled) {
    const id = labeled.event_id;
    const prev = this.labeledByEvent.get(id);
    if (prev && prev.label !== labeled.label) {
      this._bump(prev.label, -1);
    }
    const isReplacementSameLabel = prev && prev.label === labeled.label;
    this.labeledByEvent.set(id, labeled);
    this.markSeen(id);
    if (!isReplacementSameLabel) {
      this._bump(labeled.label, +1);
    }
  }

  hasSeen(id) {
    return this.seen.has(id);
  }

  markSeen(id) {
    this.seen.add(id);
  }

  /** 46ラベル全てを LABELS 順で含む plain object（無いものは0）。 */
  counts() {
    const out = {};
    for (const l of this._labels) out[l] = this._counts.get(l) || 0;
    return out;
  }

  /** 非ターゲットラベル（QA等）のカウント。 */
  qaCounts() {
    const out = {};
    for (const [k, v] of this._qaOrOther.entries()) out[k] = v;
    return out;
  }

  totalLabeled() {
    return this.labeledByEvent.size;
  }

  /** count < min のターゲットラベルを昇順で返す。 */
  labelsBelow(min) {
    const out = [];
    for (const l of this._labels) {
      const count = this._counts.get(l) || 0;
      if (count < min) out.push({ label: l, count });
    }
    out.sort((a, b) => a.count - b.count);
    return out;
  }

  isComplete(min) {
    return this.labelsBelow(min).length === 0;
  }

  labeledItems() {
    return [...this.labeledByEvent.values()];
  }
}
