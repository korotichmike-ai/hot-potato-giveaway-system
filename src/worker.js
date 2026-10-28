// Hot Potato Arena Worker: API for the host panel, the OBS overlay and /verify, plus static pages.
import { HttpError, json, readJson, safeEqual } from './http.js';
import { encryptPrize } from './prize.js';
import { addEntrant, fakeUsers } from './entries.js';
import { ACTIVE, FINISHED_ROUND, eligible, getGiveaway, latestGiveaway, listEntrants, lockGiveaway, newId, settle } from './store.js';
import { launch, reroll } from './rounds.js';
import { finishLogin, logout, me, publicUrl, requireHost, startLogin } from './auth.js';
import { channelState, handleWebhook, startChat, stopChat } from './chat.js';
import { claimState, revealPrize } from './claim.js';
import { kickConfigured } from './kick.js';
import { migrate } from './migrate.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        await migrate(env);
        return await api(request, env, url, ctx);
      }
      // /verify/<giveaway id> is one static page that reads the id from the address.
      if (/^\/verify\/[^/]+\/?$/.test(url.pathname)) return env.ASSETS.fetch(new Request(new URL('/verify/', url), request));
      return env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong on the server. Try again in a moment.' }, 500);
    }
  },
};

const intVar = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

async function api(request, env, url, ctx) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  let m;

  if (path === '/api/health') return json({ ok: true });
  if (path === '/api/config' && method === 'GET') return json({ kickLogin: kickConfigured(env), channel: env.KICK_CHANNEL_SLUG || null, hostKeyLogin: !!env.HOST_KEY });

  if (path === '/api/overlay/state' && method === 'GET') {
    requireKey(env.OVERLAY_KEY, url.searchParams.get('key'), 'OVERLAY_KEY', 'This overlay link has the wrong key. Copy it again from the host panel.');
    return json(await overlayState(env));
  }

  if ((m = path.match(/^\/api\/verify\/([\w-]+)$/)) && method === 'GET') return json(await verifyData(env, m[1]));

  if (path === '/api/kick/webhook' && method === 'POST') return handleWebhook(env, request, ctx);
  if (path === '/api/auth/login' && method === 'GET') return startLogin(env, url);
  if (path === '/api/auth/callback' && method === 'GET') return finishLogin(env, url);
  if (path === '/api/auth/logout' && method === 'POST') return logout(env, request);
  if (path === '/api/me' && method === 'GET') return me(env, request);
  if (path === '/api/claim/state' && method === 'GET') return claimState(env, request);
  if (path === '/api/claim/reveal' && method === 'POST') return revealPrize(env, request);

  if (path.startsWith('/api/host/')) {
    const host = await requireHost(env, request);
    if (path === '/api/host/state' && method === 'GET') return json(await hostState(env, url, host));
    if (path === '/api/host/chat/reconnect' && method === 'POST') { await reconnectChat(env); return json(await hostState(env, url, host)); }
    if (path === '/api/host/giveaways' && method === 'POST') return json(await createGiveaway(env, await readJson(request)), 201);
    if ((m = path.match(/^\/api\/host\/giveaways\/([\w-]+)\/(prize|open|lock|launch|reroll|cancel|test-entrants)$/)) && method === 'POST') {
      const g = await settle(env, await getGiveaway(env, m[1]));
      if (!g || g.channel_id !== env.CHANNEL_ID) throw new HttpError(404, 'That giveaway does not exist.');
      const body = await readJson(request);
      const actions = { prize: setPrize, open: openEntries, lock, launch: () => launch(env, g), reroll: () => reroll(env, g), cancel, 'test-entrants': testEntrants };
      await actions[m[2]](env, g, body);
      return json(await hostState(env, url, host));
    }
  }
  throw new HttpError(404, 'Not found.');
}

function requireKey(expected, given, name, message) {
  if (!expected) throw new HttpError(500, `The ${name} secret is not set on the server.`);
  if (!given || !safeEqual(expected, given)) throw new HttpError(401, message);
}

const need = (cond, message, status = 409) => { if (!cond) throw new HttpError(status, message); };

async function reconnectChat(env) {
  const g = await settle(env, await latestGiveaway(env));
  await stopChat(env);
  if (g?.status === 'open') await startChat(env);
}

/* ---------------- host actions ---------------- */

async function createGiveaway(env, body) {
  const current = await settle(env, await latestGiveaway(env));
  need(!current || !ACTIVE.includes(current.status),
    current?.status === 'done' ? 'The last winner can still claim. Wait for the claim timer, or start a new one after it ends.' : 'There is already a giveaway in progress. Finish or cancel it first.');
  const entrySeconds = Math.round(clampNum(body.entrySeconds, 10, 600, intVar(env.DEFAULT_ENTRY_SECONDS, 45)));
  const claimSeconds = Math.round(clampNum(body.claimSeconds, 5, 3600, intVar(env.DEFAULT_CLAIM_SECONDS, 120)));
  const id = newId();
  await env.DB.prepare('INSERT INTO giveaways (id, channel_id, status, entry_seconds, claim_seconds, sub_weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, env.CHANNEL_ID, 'draft', entrySeconds, claimSeconds, intVar(env.SUB_WEIGHT, 3), Date.now()).run();
  return { id };
}

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v != null ? Math.min(hi, Math.max(lo, n)) : dflt;
}

async function setPrize(env, g, body) {
  need(['draft', 'open', 'locked'].includes(g.status), 'The prize can only be set before the round launches.');
  const link = String(body.link ?? '').trim();
  need(link.length > 0, 'Paste the prize link first.', 400);
  need(link.length <= 2000, 'That prize link is too long (2000 characters max).', 400);
  const { ct, iv } = await encryptPrize(env, g.id, link);
  await env.DB.prepare('UPDATE giveaways SET prize_ct = ?, prize_iv = ? WHERE id = ?').bind(ct, iv, g.id).run();
}

async function openEntries(env, g, body) {
  need(g.status === 'draft', 'Entries can only be opened once, on a new giveaway.');
  const now = Date.now();
  const seconds = Math.round(clampNum(body.seconds, 10, 600, g.entry_seconds));
  await env.DB.prepare("UPDATE giveaways SET status = 'open', opened_at = ?, entries_close_at = ?, entry_seconds = ? WHERE id = ? AND status = 'draft'")
    .bind(now, now + seconds * 1000, seconds, g.id).run();
  await startChat(env);
}

async function lock(env, g) {
  need(g.status === 'open', 'Only an open giveaway can be locked.');
  await lockGiveaway(env, g, Date.now());
}

async function cancel(env, g) {
  need(['draft', 'open', 'locked'].includes(g.status), 'A giveaway can only be cancelled before it launches.');
  await env.DB.prepare("UPDATE giveaways SET status = 'cancelled', prize_ct = NULL, prize_iv = NULL WHERE id = ?").bind(g.id).run();
  await stopChat(env);
}

async function testEntrants(env, g, body) {
  need(env.ALLOW_TEST_ENTRANTS === 'true', 'Test entrants are turned off on this server.', 403);
  need(g.status === 'open', 'Open entries first, then add test entrants.');
  const users = fakeUsers(Math.round(clampNum(body.count, 1, 150, 30)), clampNum(body.subPct, 0, 100, 20));
  const now = Date.now();
  for (const u of users) await addEntrant(env, g, u, now);
}

/* ---------------- views ---------------- */

function publicEntrant(e) {
  return { id: e.kick_user_id, username: e.username, avatarUrl: e.avatar_url, isSub: !!e.is_sub };
}

async function hostState(env, url, host) {
  const g = await settle(env, await latestGiveaway(env));
  let cs = await channelState(env);
  if (cs?.chat_sub_id && g?.status !== 'open') { await stopChat(env); cs = await channelState(env); } // sweep a leftover chat subscription
  const entrants = g ? await listEntrants(env, g.id) : [];
  const winner = g?.winner_id ? entrants.find(e => e.kick_user_id === g.winner_id) : null;
  return {
    now: Date.now(),
    overlayUrl: env.OVERLAY_KEY ? `${publicUrl(env, url)}/overlay/?key=${encodeURIComponent(env.OVERLAY_KEY)}` : null,
    user: host.user || null,
    kick: {
      loginEnabled: kickConfigured(env),
      channel: env.KICK_CHANNEL_SLUG || null,
      broadcaster: cs?.broadcaster_username || null,
      chatListening: !!cs?.chat_sub_id,
      chatError: cs?.sub_error || null,
      lastChatAt: cs?.last_chat_at || null,
    },
    testEntrantsAllowed: env.ALLOW_TEST_ENTRANTS === 'true',
    defaults: { entrySeconds: intVar(env.DEFAULT_ENTRY_SECONDS, 45), claimSeconds: intVar(env.DEFAULT_CLAIM_SECONDS, 120), subWeight: intVar(env.SUB_WEIGHT, 3) },
    giveaway: g && {
      id: g.id, status: g.status, prizeSet: !!g.prize_ct,
      entrySeconds: g.entry_seconds, claimSeconds: g.claim_seconds, subWeight: g.sub_weight,
      openedAt: g.opened_at, entriesCloseAt: g.entries_close_at, lockedAt: g.locked_at,
      launchedAt: g.launched_at, roundMs: g.round_ms, claimDeadline: g.claim_deadline,
      seedHash: g.seed_hash, entrantHash: g.entrant_hash, nonce: g.nonce,
      winner: winner ? publicEntrant(winner) : null,
      verifyUrl: `${publicUrl(env, url)}/verify/${g.id}`,
    },
    entrants: entrants.map(e => ({ ...publicEntrant(e), rejectedReason: e.rejected_reason, joinedAt: e.joined_at })),
  };
}

async function overlayState(env) {
  const g = await settle(env, await latestGiveaway(env));
  const now = Date.now();
  if (!g || g.status === 'cancelled' || g.status === 'draft') return { now, giveaway: null };
  const entrants = eligible(await listEntrants(env, g.id));
  const base = {
    id: g.id, status: g.status, entriesCloseAt: g.entries_close_at,
    count: entrants.length, subCount: entrants.filter(e => e.is_sub).length, subWeight: g.sub_weight,
    claimSite: env.CLAIM_SITE || null,
  };
  if (!['running', ...FINISHED_ROUND].includes(g.status)) return { now, giveaway: base };
  const excluded = JSON.parse(g.excluded_ids);
  return {
    now,
    giveaway: {
      ...base,
      seedHash: g.seed_hash, nonce: g.nonce, launchedAt: g.launched_at, roundMs: g.round_ms, claimDeadline: g.claim_deadline,
      seed: g.status === 'running' ? null : g.seed,
      round: {
        entrants: entrants.filter(e => !excluded.includes(e.kick_user_id)).map(publicEntrant),
        eliminationOrder: JSON.parse(g.elimination),
        winnerId: g.winner_id,
        short: g.nonce > 0,
      },
    },
  };
}

async function verifyData(env, id) {
  const g = await settle(env, await getGiveaway(env, id));
  if (!g || !g.seed_hash) throw new HttpError(404, 'No finished round with that id.');
  const finished = FINISHED_ROUND.includes(g.status);
  const entrants = eligible(await listEntrants(env, g.id)).map(publicEntrant);
  return {
    id: g.id, status: g.status, algorithm: 'hp-draw-v1',
    weights: { sub: g.sub_weight, nonSub: 1 },
    seedHash: g.seed_hash, entrantHash: g.entrant_hash, nonce: g.nonce,
    excludeIds: JSON.parse(g.excluded_ids),
    seed: finished ? g.seed : null,
    launchedAt: g.launched_at,
    entrants,
  };
}
