// Run with: node --test draw.test.mjs   (set ROUNDS=20000 for a quicker run)
import test from 'node:test';
import assert from 'node:assert/strict';
import { drawOrder, createRng, entrantListHash, canonicalText, seedHash, newServerSeed, WEIGHTS } from '../public/js/draw.js';

const SEED = '7f3c9a1e5b2d4f60a8c1e3b5d7f90a2c4e6b8d0f1a3c5e7092b4d6f8a0c2e4f6';
const ROUNDS = Number(process.env.ROUNDS || 100000);

function makeEntrants(n, subs) {
  return Array.from({ length: n }, (_, i) => ({ id: 1000 + i * 37, isSub: i < subs }));
}

test('weights are sub 3, non-sub 1', () => {
  assert.deepEqual({ ...WEIGHTS }, { sub: 3, nonSub: 1 });
});

test('same inputs give the same order, and the order is a full permutation', async () => {
  const entrants = makeEntrants(35, 7);
  const a = await drawOrder({ giveawayId: 'g1', serverSeed: SEED, entrants });
  const b = await drawOrder({ giveawayId: 'g1', serverSeed: SEED, entrants: [...entrants].reverse() });
  assert.deepEqual(a, b);
  assert.equal(new Set(a.survivalOrder).size, 35);
  assert.equal(a.eliminationOrder.length, 34);
  assert.equal(a.eliminationOrder.at(-1), a.survivalOrder[1]);
  assert.ok(!a.eliminationOrder.includes(a.winnerId));
});

test('changing seed, giveaway id, nonce or a sub flag changes the result inputs', async () => {
  const entrants = makeEntrants(35, 7);
  const base = await drawOrder({ giveawayId: 'g1', serverSeed: SEED, entrants });
  const other = await drawOrder({ giveawayId: 'g2', serverSeed: SEED, entrants });
  assert.notDeepEqual(base.survivalOrder, other.survivalOrder);
  const flipped = entrants.map((e, i) => (i === 20 ? { ...e, isSub: true } : e));
  assert.notEqual(await entrantListHash(flipped), base.listHash);
});

test('canonical list sorts numerically, not as text', () => {
  assert.equal(canonicalText([{ id: 100, isSub: false }, { id: 9, isSub: true }, { id: '25', isSub: false }]), '9:1\n25:0\n100:0');
});

test('rejects bad input', async () => {
  await assert.rejects(drawOrder({ giveawayId: 'g', serverSeed: 'abc', entrants: makeEntrants(3, 1) }));
  await assert.rejects(drawOrder({ giveawayId: 'g', serverSeed: SEED, entrants: [{ id: 1 }, { id: 1 }] }));
  await assert.rejects(drawOrder({ giveawayId: 'a:b', serverSeed: SEED, entrants: makeEntrants(3, 1) }));
});

test('0, 1 and 2 entrants', async () => {
  assert.equal((await drawOrder({ giveawayId: 'g', serverSeed: SEED, entrants: [] })).winnerId, null);
  const one = await drawOrder({ giveawayId: 'g', serverSeed: SEED, entrants: [{ id: 5, isSub: false }] });
  assert.equal(one.winnerId, '5');
  assert.deepEqual(one.eliminationOrder, []);
  const two = await drawOrder({ giveawayId: 'g', serverSeed: SEED, entrants: makeEntrants(2, 1) });
  assert.equal(two.eliminationOrder.length, 1);
});

test('reroll excludes previous winners and keeps the list hash', async () => {
  const entrants = makeEntrants(35, 7);
  const first = await drawOrder({ giveawayId: 'g1', serverSeed: SEED, entrants });
  const re = await drawOrder({ giveawayId: 'g1', serverSeed: SEED, entrants, nonce: 1, excludeIds: [first.winnerId] });
  assert.equal(re.listHash, first.listHash);
  assert.notEqual(re.winnerId, first.winnerId);
  assert.ok(!re.survivalOrder.includes(first.winnerId));
  assert.equal(re.survivalOrder.length, 34);
});

test('seed hash is sha256 of the lowercase seed hex', async () => {
  const s = newServerSeed();
  assert.match(s, /^[0-9a-f]{64}$/);
  assert.equal(await seedHash(s.toUpperCase()), await seedHash(s));
});

test('below(n) is unbiased for an awkward n', async () => {
  const rng = await createRng(SEED, 'bias-check');
  const counts = [0, 0, 0];
  for (let i = 0; i < 30000; i++) counts[await rng.below(3)]++;
  for (const c of counts) assert.ok(Math.abs(c - 10000) < 400, `counts ${counts}`);
});

test(`${ROUNDS} rounds: each sub wins about 3x as often as each non-sub`, { timeout: 600000 }, async () => {
  const n = 35, subs = 7;
  const entrants = makeEntrants(n, subs);
  const wins = new Map(entrants.map(e => [String(e.id), 0]));
  for (let r = 0; r < ROUNDS; r++) {
    const res = await drawOrder({ giveawayId: 'sim' + r, serverSeed: SEED, entrants });
    wins.set(res.winnerId, wins.get(res.winnerId) + 1);
  }
  const total = subs * 3 + (n - subs);
  let subWins = 0, chi2 = 0;
  for (const e of entrants) {
    const w = wins.get(String(e.id));
    if (e.isSub) subWins += w;
    const expected = ROUNDS * (e.isSub ? 3 : 1) / total;
    chi2 += (w - expected) ** 2 / expected;
  }
  const perSub = subWins / subs, perNon = (ROUNDS - subWins) / (n - subs);
  const ratio = perSub / perNon;
  console.log(`  ${ROUNDS} rounds, ${n} entrants, ${subs} subs: subs won ${(subWins / ROUNDS * 100).toFixed(2)}% (expected ${(subs * 3 / total * 100).toFixed(2)}%), per-person ratio ${ratio.toFixed(3)}x, chi-square ${chi2.toFixed(1)} on 34 df`);
  assert.ok(Math.abs(ratio - 3) < (ROUNDS >= 100000 ? 0.08 : 0.2), `ratio ${ratio}`);
  assert.ok(chi2 < 65.2, `chi-square ${chi2} is above the 0.1% critical value for 34 df`);
});
