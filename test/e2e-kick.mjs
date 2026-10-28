// End-to-end check of Kick login, chat entries, bans and the prize claim, against `wrangler dev`
// and a fake Kick server started by this script on port 8799.
//
// .dev.vars needs, in addition to the usual secrets:
//   KICK_CLIENT_ID="test-client"  KICK_CLIENT_SECRET="test-secret"  KICK_CHANNEL_SLUG="teststreamer"
//   KICK_ID_BASE="http://127.0.0.1:8799"  KICK_API_BASE="http://127.0.0.1:8799"
// Usage: npm run dev (another terminal), then npm run e2e:kick
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const MOCK_PORT = 8799;
const BROADCASTER = 1000;
const vars = Object.fromEntries(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
  .split('\n').map(l => l.match(/^(\w+)\s*=\s*"?([^"]*)"?\s*$/)).filter(Boolean).map(m => [m[1], m[2]]));
assert.equal(vars.KICK_API_BASE, `http://127.0.0.1:${MOCK_PORT}`, 'Point KICK_API_BASE and KICK_ID_BASE in .dev.vars at the fake Kick server (see the top of this file).');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const step = m => console.log('✓ ' + m);

/* ---------- fake Kick ---------- */
// Reuse one key pair across runs: the Worker caches the public key.
const keyFile = new URL('../.wrangler/test-kick-key.json', import.meta.url);
if (!existsSync(keyFile)) {
  mkdirSync(new URL('../.wrangler/', import.meta.url), { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(keyFile, JSON.stringify({
    pub: publicKey.export({ type: 'spki', format: 'pem' }),
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }));
}
const keys = JSON.parse(readFileSync(keyFile, 'utf8'));
const challenges = new Map();           // code -> PKCE challenge
const subscriptions = [];               // { id, name, broadcaster }
const deleted = [];
let subCounter = 0;
const users = { 1000: 'teststreamer', 2000: 'someone_else', 3001: 'LuckySub', 3002: 'PlainViewer', 3003: 'Troublemaker', 3004: 'Chatter', 3006: 'LateComer' };

const mock = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = '';
  for await (const c of req) body += c;
  const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (url.pathname === '/oauth/token') {
    const f = new URLSearchParams(body);
    assert.equal(f.get('client_secret'), 'test-secret');
    if (f.get('grant_type') === 'client_credentials') return send(200, { access_token: 'app-token', token_type: 'Bearer', expires_in: 3600 });
    const code = f.get('code');
    const expected = challenges.get(code);
    const actual = createHash('sha256').update(f.get('code_verifier')).digest('base64url');
    if (!expected || expected !== actual) return send(400, { error: 'Invalid request' });
    return send(200, { access_token: 'user-' + code.split('-')[1], token_type: 'Bearer', refresh_token: 'r', expires_in: 3600, scope: 'user:read' });
  }
  if (url.pathname === '/public/v1/public-key') return send(200, { data: { public_key: keys.pub }, message: 'OK' });
  if (url.pathname === '/public/v1/users') {
    const id = auth.replace('user-', '');
    if (!users[id]) return send(401, { message: 'Unauthorized' });
    return send(200, { data: [{ user_id: Number(id), name: users[id], profile_picture: null, email: '' }], message: 'OK' });
  }
  if (url.pathname === '/public/v1/channels') {
    assert.equal(auth, 'app-token');
    return url.searchParams.get('slug') === 'teststreamer' ? send(200, { data: [{ broadcaster_user_id: BROADCASTER, slug: 'teststreamer' }] }) : send(200, { data: [] });
  }
  if (url.pathname === '/public/v1/events/subscriptions' && req.method === 'POST') {
    assert.equal(auth, 'app-token');
    const b = JSON.parse(body);
    const id = 'sub-' + (++subCounter);
    subscriptions.push({ id, name: b.events[0].name, broadcaster: b.broadcaster_user_id });
    return send(200, { data: [{ name: b.events[0].name, version: 1, subscription_id: id }], message: 'OK' });
  }
  if (url.pathname === '/public/v1/events/subscriptions' && req.method === 'DELETE') {
    deleted.push(...url.searchParams.getAll('id'));
    res.writeHead(204); return res.end();
  }
  send(404, { message: 'not found' });
});
await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));

/* ---------- helpers ---------- */
async function call(method, path, { cookie, body, headers = {}, expect = 200 } = {}) {
  const res = await fetch(BASE + path, {
    method, redirect: 'manual',
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  assert.equal(res.status, expect, `${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const hostCall = (method, path, body, expect) => call(method, '/api/host' + path, { cookie: hostCookie, body, headers: { 'x-hp': '1' }, expect });

async function login(role, userId) {
  const start = await fetch(`${BASE}/api/auth/login?role=${role}`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const auth = new URL(start.headers.get('location'));
  assert.equal(auth.origin, `http://127.0.0.1:${MOCK_PORT}`);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  const code = 'code-' + userId;
  challenges.set(code, auth.searchParams.get('code_challenge'));
  const cb = await fetch(`${BASE}/api/auth/callback?code=${code}&state=${auth.searchParams.get('state')}`, { redirect: 'manual' });
  assert.equal(cb.status, 302);
  const cookie = (cb.headers.get('set-cookie') || '').split(';')[0];
  return { location: cb.headers.get('location'), cookie: cookie.startsWith('hp_session=') ? cookie : null };
}

let msgCounter = 0;
async function webhook(type, payload, { badSignature = false, timestamp = new Date().toISOString(), subscriptionId = 'sub-x', messageId } = {}) {
  const body = JSON.stringify(payload);
  const id = messageId || `01TESTMSG${Date.now()}${++msgCounter}`;
  let signature = sign('sha256', Buffer.from(`${id}.${timestamp}.${body}`), keys.priv).toString('base64');
  if (badSignature) signature = signature.slice(0, -4) + 'AAAA';
  const res = await fetch(BASE + '/api/kick/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'Kick-Event-Message-Id': id, 'Kick-Event-Subscription-Id': subscriptionId,
      'Kick-Event-Signature': signature, 'Kick-Event-Message-Timestamp': timestamp, 'Kick-Event-Type': type, 'Kick-Event-Version': '1',
    },
    body,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const person = (id, badges = []) => ({ is_anonymous: false, user_id: id, username: users[id] || 'user' + id, is_verified: false, profile_picture: null, channel_slug: 'c' + id, identity: { username_color: '#fff', badges } });
const chat = (senderId, content, { badges, broadcaster = BROADCASTER } = {}) => ({
  message_id: 'm' + Math.random(), broadcaster: { ...person(broadcaster), identity: null }, sender: person(senderId, badges), content, emotes: [], created_at: new Date().toISOString(),
});
const ban = bannedId => ({ broadcaster: { ...person(BROADCASTER), identity: null }, moderator: person(4000), banned_user: person(bannedId), metadata: { reason: 'test', created_at: new Date().toISOString(), expires_at: null } });

async function waitFor(fn, label, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { const v = await fn(); if (v) return v; await sleep(500); }
  throw new Error('Timed out waiting for ' + label);
}

async function freshGiveaway(entrySeconds = 60, claimSeconds = 30) {
  const s = await hostCall('GET', '/state');
  if (s.giveaway && ['draft', 'open', 'locked'].includes(s.giveaway.status)) await hostCall('POST', `/giveaways/${s.giveaway.id}/cancel`, {});
  const { id } = await hostCall('POST', '/giveaways', { entrySeconds, claimSeconds }, 201);
  await hostCall('POST', `/giveaways/${id}/prize`, { link: PRIZE });
  return id;
}
const PRIZE = 'https://example.com/prize/' + Math.random().toString(36).slice(2);

/* ---------- the run ---------- */
let hostCookie;
try {
  const cfg = await call('GET', '/api/config');
  assert.equal(cfg.kickLogin, true);

  const wrong = await login('host', 2000);
  assert.equal(wrong.cookie, null);
  assert.match(decodeURIComponent(wrong.location), /not the teststreamer channel/);
  const host = await login('host', BROADCASTER);
  assert.equal(host.location, '/host/');
  assert.ok(host.cookie, 'session cookie set');
  hostCookie = host.cookie;
  await call('GET', '/api/host/state', { expect: 401 });
  await call('POST', '/api/host/giveaways', { cookie: hostCookie, body: {}, expect: 403 }); // no x-hp header
  let s = await hostCall('GET', '/state');
  assert.equal(s.kick.broadcaster, 'teststreamer');
  assert.equal(s.user.username, 'teststreamer');
  assert.ok(subscriptions.some(x => x.name === 'moderation.banned' && x.broadcaster === BROADCASTER));
  step('streamer logs in with Kick (PKCE checked); other accounts are refused; ban events subscribed');

  let id = await freshGiveaway();
  s = await hostCall('POST', `/giveaways/${id}/open`, { seconds: 60 });
  const chatSub = subscriptions.find(x => x.name === 'chat.message.sent');
  assert.ok(chatSub, 'chat subscription created when entries open');
  assert.equal(s.kick.chatListening, true);
  step('opening entries subscribes to chat');

  assert.equal((await webhook('chat.message.sent', chat(3001, '!join', { badges: [{ text: 'Subscriber', type: 'subscriber', count: 3 }] }))).data.result, 'added');
  assert.equal((await webhook('chat.message.sent', chat(3002, '!join'))).data.result, 'added');
  assert.equal((await webhook('chat.message.sent', chat(3003, '!JOIN me pls'))).data.result, 'added');
  assert.equal((await webhook('chat.message.sent', chat(3004, 'hello !join'))).data.result, undefined);
  assert.equal((await webhook('chat.message.sent', chat(BROADCASTER, '!join'))).data.result, 'ignored');
  assert.equal((await webhook('chat.message.sent', chat(3001, '!join'))).data.result, 'duplicate');
  assert.equal((await webhook('chat.message.sent', chat(3004, '!join', { broadcaster: 999 }))).data.ignored, 'other channel');
  assert.equal((await webhook('chat.message.sent', chat(3004, '!join'), { badSignature: true })).status, 401);
  assert.equal((await webhook('chat.message.sent', chat(3004, '!join'), { timestamp: new Date(Date.now() - 3600_000).toISOString() })).status, 400);
  step('!join via signed webhooks: subs detected, duplicates/streamer/other channels ignored, forged and stale events refused');

  await webhook('moderation.banned', ban(3003));
  s = await hostCall('GET', '/state');
  const byId = Object.fromEntries(s.entrants.map(e => [e.id, e]));
  assert.equal(byId['3001'].isSub, true);
  assert.equal(byId['3002'].isSub, false);
  assert.equal(byId['3003'].rejectedReason, 'Banned from chat');
  assert.equal(s.entrants.length, 3);
  step('a viewer banned during entries is rejected');

  await hostCall('POST', `/giveaways/${id}/lock`, {});
  assert.ok(deleted.includes(chatSub.id), 'chat subscription deleted on lock');
  const late = await webhook('chat.message.sent', chat(3006, '!join'), { subscriptionId: 'sub-stray' });
  assert.equal(late.data.ignored, 'entries closed');
  await sleep(300);
  assert.ok(deleted.includes('sub-stray'), 'stray chat subscription removed by the webhook');
  step('locking unsubscribes from chat; a leftover subscription cleans itself up');

  s = await hostCall('POST', `/giveaways/${id}/launch`, {});
  const claimBefore = await call('GET', '/api/claim/state');
  assert.equal(claimBefore.giveaway.winnerName, null, 'winner hidden while playing');
  s = await waitFor(async () => { const x = await hostCall('GET', '/state'); return x.giveaway.status === 'done' && x; }, 'round to finish');
  const winnerId = s.giveaway.winner.id;
  const loserId = winnerId === '3001' ? '3002' : '3001';

  const loser = await login('winner', loserId);
  assert.equal(loser.location, '/claim/');
  const ls = await call('GET', '/api/claim/state', { cookie: loser.cookie });
  assert.equal(ls.giveaway.isWinner, false);
  await call('POST', '/api/claim/reveal', { cookie: loser.cookie, headers: { 'x-hp': '1' }, expect: 403 });
  const win = await login('winner', winnerId);
  const ws = await call('GET', '/api/claim/state', { cookie: win.cookie });
  assert.equal(ws.giveaway.isWinner, true);
  await call('POST', '/api/claim/reveal', { cookie: win.cookie, expect: 403 }); // no x-hp header
  const revealed = await call('POST', '/api/claim/reveal', { cookie: win.cookie, headers: { 'x-hp': '1' } });
  assert.equal(revealed.prize, PRIZE);
  await call('POST', '/api/claim/reveal', { cookie: win.cookie, headers: { 'x-hp': '1' }, expect: 409 });
  s = await hostCall('GET', '/state');
  assert.equal(s.giveaway.status, 'claimed');
  step(`winner (${users[winnerId]}) claims once with Kick login; the other entrant and repeat reveals are refused`);

  id = await freshGiveaway(60, 60);
  await hostCall('POST', `/giveaways/${id}/open`, { seconds: 60 });
  for (const u of [3001, 3002, 3004]) await webhook('chat.message.sent', chat(u, '!join'));
  await hostCall('POST', `/giveaways/${id}/lock`, {});
  await hostCall('POST', `/giveaways/${id}/launch`, {});
  s = await waitFor(async () => { const x = await hostCall('GET', '/state'); return x.giveaway.status === 'done' && x; }, 'second round to finish');
  const banned = s.giveaway.winner.id;
  await webhook('moderation.banned', ban(Number(banned)));
  s = await hostCall('GET', '/state');
  assert.equal(s.giveaway.status, 'running');
  assert.equal(s.giveaway.nonce, 1);
  assert.notEqual(s.giveaway.winner.id, banned);
  step('a winner banned before claiming is rerolled automatically');

  console.log('\nAll Kick end-to-end checks passed.');
} finally {
  mock.close();
}
