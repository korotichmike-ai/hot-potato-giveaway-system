// Kick login (OAuth 2.1 + PKCE) and cookie sessions.
//   role "host":   the streamer. Must own the channel named in KICK_CHANNEL_SLUG.
//   role "winner": any viewer, used on /claim to prove they are the winner.
import { HttpError, json, safeEqual } from './http.js';
import { authorizeUrl, exchangeCode, getChannelBySlug, getMe, pkceChallenge, randomToken } from './kick.js';
import { sha256Hex } from '../public/js/draw.js';
import { ensureBanSubscription } from './chat.js';

const COOKIE = 'hp_session';
const TTL = { host: 12 * 3600_000, winner: 30 * 60_000 };
const RETURN = { host: '/host/', winner: '/claim/' };

export const publicUrl = (env, url) => (env.PUBLIC_URL || url.origin).replace(/\/$/, '');
const redirectUri = (env, url) => publicUrl(env, url) + '/api/auth/callback';

function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', ...headers } });
}

export async function startLogin(env, url) {
  const role = url.searchParams.get('role') === 'host' ? 'host' : 'winner';
  const state = randomToken(24), verifier = randomToken(48);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?').bind(now - 600_000),
    env.DB.prepare('INSERT INTO oauth_states (state, verifier, role, created_at) VALUES (?, ?, ?, ?)').bind(state, verifier, role, now),
  ]);
  return redirect(authorizeUrl(env, { redirectUri: redirectUri(env, url), state, challenge: await pkceChallenge(verifier), scope: 'user:read' }));
}

export async function finishLogin(env, url) {
  const fail = (role, message) => redirect(`${RETURN[role] || '/claim/'}?error=${encodeURIComponent(message)}`);
  const state = url.searchParams.get('state') || '';
  const row = await env.DB.prepare('SELECT * FROM oauth_states WHERE state = ?').bind(state).first();
  if (!row || Date.now() - row.created_at > 600_000) return fail('winner', 'That login link expired. Please try again.');
  await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
  if (url.searchParams.get('error') || !url.searchParams.get('code')) return fail(row.role, 'Kick login was cancelled.');

  let user;
  try {
    const tokens = await exchangeCode(env, { code: url.searchParams.get('code'), verifier: row.verifier, redirectUri: redirectUri(env, url) });
    user = await getMe(env, tokens.access_token);
  } catch (err) {
    return fail(row.role, err.message || 'Kick login failed. Please try again.');
  }

  if (row.role === 'host') {
    if (!env.KICK_CHANNEL_SLUG) return fail('host', 'KICK_CHANNEL_SLUG is not set on the server, so nobody can log in as the host yet.');
    let channel;
    try { channel = await getChannelBySlug(env, env.KICK_CHANNEL_SLUG); } catch (err) { return fail('host', err.message); }
    if (channel.broadcasterUserId !== user.id) return fail('host', `You are logged in to Kick as ${user.username}, which is not the ${env.KICK_CHANNEL_SLUG} channel.`);
    await env.DB.prepare(
      `INSERT INTO channel_state (channel_id, broadcaster_user_id, broadcaster_username) VALUES (?, ?, ?)
       ON CONFLICT (channel_id) DO UPDATE SET broadcaster_user_id = excluded.broadcaster_user_id, broadcaster_username = excluded.broadcaster_username`
    ).bind(env.CHANNEL_ID, user.id, user.username).run();
    await ensureBanSubscription(env).catch(() => {});
  }

  const token = randomToken(32), now = Date.now(), ttl = TTL[row.role];
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('INSERT INTO sessions (token_hash, kick_user_id, username, avatar_url, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(await sha256Hex(token), user.id, user.username, user.avatarUrl, row.role, now, now + ttl),
  ]);
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return redirect(RETURN[row.role], { 'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttl / 1000)}${secure}` });
}

function readCookie(request) {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

export async function getSession(env, request) {
  const token = readCookie(request);
  if (!token) return null;
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').bind(await sha256Hex(token), Date.now()).first();
  return s ? { userId: s.kick_user_id, username: s.username, avatarUrl: s.avatar_url, role: s.role } : null;
}

export async function logout(env, request) {
  const token = readCookie(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json', 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` },
  });
}

// Cookie-authenticated POSTs must carry this header. Browsers won't send a custom header
// cross-site without a CORS preflight (which this Worker never approves), which blocks CSRF.
export function requireCsrfHeader(request) {
  if (request.method !== 'GET' && request.headers.get('x-hp') !== '1') throw new HttpError(403, 'Missing request header. Reload the page and try again.');
}

// Host API access: a Kick session for the channel owner, or the HOST_KEY bearer (setup and tests).
export async function requireHost(env, request) {
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (bearer) {
    if (env.HOST_KEY && safeEqual(env.HOST_KEY, bearer)) return { via: 'key' };
    throw new HttpError(401, 'Wrong host key.');
  }
  const s = await getSession(env, request);
  if (!s || s.role !== 'host') throw new HttpError(401, 'Log in with Kick to use the host panel.');
  requireCsrfHeader(request);
  return { via: 'kick', user: s };
}

export async function me(env, request) {
  return json({ user: await getSession(env, request) });
}
