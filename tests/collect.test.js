import { describe, it, expect } from 'vitest';
import { filterAndSample } from '../scripts/collect.js';

const cfg = {
  target: 100,
  perAuthorCap: 10,
  rawPerAuthorCap: 25,
};

/** raw アイテム生成ヘルパ。relay を配列/Set どちらでも作れる。 */
function rawItem({ id, pubkey, created_at, content, relay }) {
  return { event_id: id, pubkey, created_at, content, relay };
}

describe('filterAndSample relay 集約の回帰テスト', () => {
  it('relay が配列の重複コンテンツでクラッシュしない（rep.relay.add リグレッション）', () => {
    // main() がシリアライズした raw（および resume でロードした raw）は relay が配列。
    // 同一コンテンツのため contentHash が一致し、代表へのマージ経路を通る。
    const rawList = [
      rawItem({ id: 'a', pubkey: 'p1', created_at: 100, content: '今日はとても良い天気ですね。散歩に行きたい気分です。', relay: ['wss://relay-a'] }),
      rawItem({ id: 'b', pubkey: 'p2', created_at: 90, content: '今日はとても良い天気ですね。散歩に行きたい気分です。', relay: ['wss://relay-b'] }),
    ];

    expect(() => filterAndSample(rawList, cfg)).not.toThrow();

    const { samples } = filterAndSample(rawList, cfg);
    // 近似重複は1代表に集約され、relay はマージされた配列になる。
    expect(samples).toHaveLength(1);
    const merged = samples[0].relay;
    expect(Array.isArray(merged)).toBe(true);
    expect(merged.sort()).toEqual(['wss://relay-a', 'wss://relay-b']);
    // 代表は最古（created_at 最小）。
    expect(samples[0].created_at).toBe(90);
  });

  it('relay が Set の新規収集アイテムでも動作する', () => {
    const rawList = [
      rawItem({ id: 'a', pubkey: 'p1', created_at: 100, content: '美味しいラーメンを食べました。スープが最高でした。', relay: new Set(['wss://relay-a']) }),
      rawItem({ id: 'b', pubkey: 'p2', created_at: 80, content: '美味しいラーメンを食べました。スープが最高でした。', relay: new Set(['wss://relay-b']) }),
    ];

    expect(() => filterAndSample(rawList, cfg)).not.toThrow();
    const { samples } = filterAndSample(rawList, cfg);
    expect(samples).toHaveLength(1);
    expect(samples[0].relay.sort()).toEqual(['wss://relay-a', 'wss://relay-b']);
  });

  it('relay が欠落していても落ちない', () => {
    const rawList = [
      rawItem({ id: 'a', pubkey: 'p1', created_at: 100, content: '猫がとても可愛くてずっと見ていられます。', relay: undefined }),
      rawItem({ id: 'b', pubkey: 'p2', created_at: 95, content: '猫がとても可愛くてずっと見ていられます。', relay: undefined }),
    ];
    expect(() => filterAndSample(rawList, cfg)).not.toThrow();
    const { samples } = filterAndSample(rawList, cfg);
    expect(samples).toHaveLength(1);
    expect(samples[0].relay).toEqual([]);
  });

  it('複数ユニークノートを承認しサンプルとして返す', () => {
    const rawList = [
      rawItem({ id: 'a', pubkey: 'p1', created_at: 100, content: '朝のコーヒーは一日の始まりに欠かせません。', relay: ['wss://r1'] }),
      rawItem({ id: 'b', pubkey: 'p2', created_at: 90, content: '夜は静かに読書をして過ごすのが好きです。', relay: ['wss://r2'] }),
    ];
    const { samples } = filterAndSample(rawList, cfg);
    expect(samples.length).toBe(2);
    for (const s of samples) {
      expect(Array.isArray(s.relay)).toBe(true);
    }
  });
});

/** approved 候補（ユニークノート）。 */
function approvedRaw(id, pubkey, content) {
  return rawItem({ id, pubkey, created_at: 100, content, relay: ['wss://r'] });
}

/** review 候補を1つ作る。同一コンテンツ・同一著者の近似重複ペア → near_dup_representative で review。 */
function reviewPair(idBase, pubkey, content) {
  return [
    rawItem({ id: `${idBase}a`, pubkey, created_at: 100, content, relay: ['wss://r'] }),
    rawItem({ id: `${idBase}b`, pubkey, created_at: 90, content, relay: ['wss://r'] }),
  ];
}

describe('filterAndSample review バックフィル', () => {
  // approved 2件・review 3件・excluded 1件（英語）を用意。
  const buildPool = () => [
    approvedRaw('a1', 'pa1', '朝のコーヒーは一日の始まりに欠かせません。'),
    approvedRaw('a2', 'pa2', '夜は静かに読書をして過ごすのが好きです。'),
    ...reviewPair('r1', 'pr1', '猫がとても可愛くてずっと見ていられます。'),
    ...reviewPair('r2', 'pr2', '美味しいラーメンを食べました。スープが最高でした。'),
    ...reviewPair('r3', 'pr3', '今日はとても良い天気ですね。散歩に行きたいです。'),
    // 英語は言語判定で excluded（samples に含めない、バックフィル対象外）。
    rawItem({ id: 'en', pubkey: 'pen', created_at: 100, content: 'This is an English sentence about the weather today.', relay: ['wss://r'] }),
  ];

  it('approved が target に満たないと review からバックフィルして target に到達する', () => {
    const { samples, counters } = filterAndSample(buildPool(), { target: 4, perAuthorCap: 10, rawPerAuthorCap: 25 });
    const approved = samples.filter((s) => s.review_status === 'approved');
    const review = samples.filter((s) => s.review_status === 'review');
    // approved 2件 + review から2件バックフィル = 4。
    expect(approved.length).toBe(4);
    expect(review.length).toBe(1);
    expect(counters.get('approved_backfilled')).toBe(2);
    // 元々 approved の2件は必ず approved のまま。
    const approvedIds = new Set(approved.map((s) => s.event_id));
    expect(approvedIds.has('a1')).toBe(true);
    expect(approvedIds.has('a2')).toBe(true);
    // excluded（英語）は samples に出ない。
    expect(samples.some((s) => s.event_id === 'en')).toBe(false);
  });

  it('target が十分大きいと review プールを使い切るが excluded は決して採用しない', () => {
    const { samples, counters } = filterAndSample(buildPool(), { target: 100, perAuthorCap: 10, rawPerAuthorCap: 25 });
    const approved = samples.filter((s) => s.review_status === 'approved');
    const review = samples.filter((s) => s.review_status === 'review');
    // 非 excluded 5件すべてが approved に昇格、review は空。
    expect(approved.length).toBe(5);
    expect(review.length).toBe(0);
    expect(counters.get('approved_backfilled')).toBe(3);
    expect(samples.some((s) => s.event_id === 'en')).toBe(false);
  });

  it('バックフィル不要（approved だけで target 到達）なら review は降格しない', () => {
    const { samples, counters } = filterAndSample(buildPool(), { target: 2, perAuthorCap: 10, rawPerAuthorCap: 25 });
    const approved = samples.filter((s) => s.review_status === 'approved');
    const review = samples.filter((s) => s.review_status === 'review');
    expect(approved.length).toBe(2);
    expect(review.length).toBe(3); // review 候補はそのまま review。
    expect(counters.get('approved_backfilled')).toBe(0);
  });

  it('著者ごと上限は approved/review プール横断で維持される', () => {
    // 同一著者 pcap に approved 3件 + review 2件。cap=2 なら approved は2件まで。
    const rawList = [
      approvedRaw('c1', 'pcap', 'おはようございます。今日も一日頑張りましょうね。'),
      approvedRaw('c2', 'pcap', 'お昼ご飯はおにぎりとお味噌汁にしました。'),
      approvedRaw('c3', 'pcap', '寝る前に温かいお茶を飲むと落ち着きます。'),
      ...reviewPair('cr1', 'pcap', '週末は近所の公園を散歩する予定です。'),
      ...reviewPair('cr2', 'pcap', '新しい本を買ったので読むのが楽しみです。'),
    ];
    const { samples, counters } = filterAndSample(rawList, { target: 100, perAuthorCap: 2, rawPerAuthorCap: 25 });
    const approved = samples.filter((s) => s.review_status === 'approved');
    // cap=2 のため、approved 候補で枠を使い切り review はバックフィルされない。
    expect(approved.length).toBe(2);
    expect(counters.get('approved_backfilled')).toBe(0);
  });
});
