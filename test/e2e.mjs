// End-to-end check against a running `wrangler dev` (default http://127.0.0.1:8787).
// Usage: npm run dev  (in another terminal), then  npm run e2e
// Walks a full round with test entrants: create, prize, open, lock, launch, finish, expire, reroll.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { drawOrder, seedHash } from '../public/js/draw.js';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const vars = Object.fromEntries(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
  .split('\n').map(l => l.match(/^(\w+)\s*=\s*"?([^"]*)"?\s*$/)).filter(Boolean).map(m => [m[1], m[2]]));
const PRIZE = 'https://example.com/prize/SECRET-' + Math.random().toString(36).slice(2);
const bodies = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(method, path, { body, key = vars.HOST_KEY, expect = 200 } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: 'Bearer ' + key, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  bodies.push(text);
  assert.equal(res.status, expect, `${method} ${path} -> ${res.status} ${text}`);
  return JSON.parse(text);
}
const host = (action, body, expect) => req('POST', `/api/host/giveaways/${id}/${action}`, { body: body || {}, expect });
const overlay = () => req('GET', '/api/overlay/state?key=' + encodeURIComponent(vars.OVERLAY_KEY));
const step = m => console.log('✓ ' + m);

async function waitFor(fn, label, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { const v = await fn(); if (v) return v; await sleep(500); }
  throw new Error('Timed out waiting for ' + label);
}

async function checkDraw(state) {
  const v = await req('GET', '/api/verify/' + id);
  assert.ok(v.seed, 'seed revealed after the round');
  assert.equal(await seedHash(v.seed), v.seedHash);
  const res = await drawOrder({ giveawayId: v.id, serverSeed: v.seed, entrants: v.entrants, nonce: v.nonce, excludeIds: v.excludeIds, weights: v.weights });
  assert.equal(res.listHash, v.entrantHash);
  assert.equal(res.winnerId, state.giveaway.round.winnerId);
  assert.deepEqual(res.eliminationOrder, state.giveaway.round.eliminationOrder);
  return res;
}

let id;
await req('GET', '/api/health');
await req('GET', '/api/host/state', { key: 'wrong', expect: 401 });
await req('GET', '/api/overlay/state?key=wrong', { expect: 401 });
step('wrong keys are refused');

const before = await req('GET', '/api/host/state');
if (before.giveaway && ['draft', 'open', 'locked'].includes(before.giveaway.status)) {
  id = before.giveaway.id; await host('cancel');
}
({ id } = await req('POST', '/api/host/giveaways', { body: { entrySeconds: 10, claimSeconds: 5 }, expect: 201 }));
await req('POST', '/api/host/giveaways', { body: {}, expect: 409 });
step('giveaway created, second one refused while active');

await host('launch', {}, 409);
await host('prize', { link: PRIZE });
let s = await req('GET', '/api/host/state');
assert.equal(s.giveaway.prizeSet, true);
step('prize stored (host only sees "prize set")');

await host('open', { seconds: 10 });
s = await host('test-entrants', { count: 12, subPct: 25 });
const eligibleCount = s.entrants.filter(e => !e.rejectedReason).length;
assert.ok(eligibleCount > 0);
let o = await overlay();
assert.equal(o.giveaway.status, 'open');
assert.equal(o.giveaway.count, eligibleCount);
assert.equal(o.giveaway.round, undefined);
step(`entries open with ${s.entrants.length} test viewers (${eligibleCount} eligible)`);

await host('lock');
await host('test-entrants', { count: 3 }, 409);
s = await host('launch');
assert.equal(s.giveaway.status, 'running');
await host('launch', {}, 409);
o = await overlay();
assert.equal(o.giveaway.seed, null);
assert.equal(o.giveaway.round.entrants.length, eligibleCount);
assert.equal(o.giveaway.round.eliminationOrder.length, eligibleCount - 1);
assert.equal((await req('GET', '/api/verify/' + id)).seed, null);
step(`launched; seed hidden while playing (round ${o.giveaway.roundMs} ms)`);

o = await waitFor(async () => { const x = await overlay(); return x.giveaway.status === 'done' && x; }, 'round to finish');
const first = await checkDraw(o);
step('round finished; seed revealed and /verify recomputes the same winner and order');

await req('POST', '/api/host/giveaways', { body: {}, expect: 409 });
await host('reroll', {}, 409);
await waitFor(async () => (await overlay()).giveaway.status === 'expired', 'claim window to expire');
s = await host('reroll');
assert.equal(s.giveaway.status, 'running');
assert.equal(s.giveaway.nonce, 1);
o = await overlay();
assert.equal(o.giveaway.round.short, true);
assert.notEqual(o.giveaway.round.winnerId, first.winnerId);
assert.ok(!o.giveaway.round.entrants.some(e => e.id === first.winnerId));
o = await waitFor(async () => { const x = await overlay(); return x.giveaway.status === 'done' && x; }, 'reroll to finish');
await checkDraw(o);
step('unclaimed win expired; reroll left out the first winner and verifies');

assert.ok(!bodies.some(b => b.includes(PRIZE)), 'prize link leaked in an API response');
step(`prize link never appeared in any of ${bodies.length} API responses`);
console.log('\nAll end-to-end checks passed.');
