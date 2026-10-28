// Kick public API client (docs: https://docs.kick.com).
// KICK_ID_BASE / KICK_API_BASE can point at a fake server for tests.
import { HttpError, b64, unb64 } from './http.js';

const enc = new TextEncoder();
const idBase = env => env.KICK_ID_BASE || 'https://id.kick.com';
const apiBase = env => env.KICK_API_BASE || 'https://api.kick.com';

export function kickConfigured(env) {
  return !!(env.KICK_CLIENT_ID && env.KICK_CLIENT_SECRET);
}

function requireConfig(env) {
  if (!kickConfigured(env)) throw new HttpError(500, 'Kick login is not set up on the server yet (KICK_CLIENT_ID and KICK_CLIENT_SECRET).');
}

const b64url = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier) {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
}

export function authorizeUrl(env, { redirectUri, state, challenge, scope }) {
  requireConfig(env);
  const u = new URL('/oauth/authorize', idBase(env));
  u.search = new URLSearchParams({
    response_type: 'code', client_id: env.KICK_CLIENT_ID, redirect_uri: redirectUri,
    scope, state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  return u.toString();
}

async function tokenRequest(env, params) {
  requireConfig(env);
  const res = await fetch(new URL('/oauth/token', idBase(env)), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.KICK_CLIENT_ID, client_secret: env.KICK_CLIENT_SECRET, ...params }),
  });
  if (!res.ok) throw new HttpError(502, `Kick refused the login (${res.status}). Try logging in again.`);
  return res.json();
}

export function exchangeCode(env, { code, verifier, redirectUri }) {
  return tokenRequest(env, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
}

// App access token (client credentials), cached per Worker isolate.
let appToken = null;
async function getAppToken(env) {
  if (appToken && appToken.expiresAt > Date.now() + 60_000) return appToken.value;
  const t = await tokenRequest(env, { grant_type: 'client_credentials' });
  appToken = { value: t.access_token, expiresAt: Date.now() + Number(t.expires_in || 3600) * 1000 };
  return appToken.value;
}

async function api(env, method, path, { token, query, body } = {}) {
  const u = new URL(path, apiBase(env));
  if (query) for (const [k, v] of Object.entries(query)) for (const x of [].concat(v)) u.searchParams.append(k, String(x));
  const res = await fetch(u, {
    method,
    headers: { authorization: 'Bearer ' + (token || await getAppToken(env)), accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Kick API ${method} ${path} failed (${res.status}): ${data.message || 'no details'}`);
  return data;
}

// The logged-in user behind a user access token.
export async function getMe(env, userToken) {
  const d = await api(env, 'GET', '/public/v1/users', { token: userToken });
  const u = d?.data?.[0];
  if (!u) throw new HttpError(502, 'Kick did not return the logged-in user.');
  return { id: String(u.user_id), username: u.name, avatarUrl: u.profile_picture || null };
}

export async function getChannelBySlug(env, slug) {
  const d = await api(env, 'GET', '/public/v1/channels', { query: { slug } });
  const c = d?.data?.[0];
  if (!c) throw new HttpError(404, `No Kick channel called "${slug}".`);
  return { broadcasterUserId: String(c.broadcaster_user_id), slug: c.slug };
}

// Subscribes with the app token on behalf of the broadcaster. Returns the subscription id.
export async function subscribe(env, broadcasterUserId, eventName) {
  const d = await api(env, 'POST', '/public/v1/events/subscriptions', {
    body: { broadcaster_user_id: Number(broadcasterUserId), events: [{ name: eventName, version: 1 }], method: 'webhook' },
  });
  const s = d?.data?.[0];
  if (!s || s.error || !s.subscription_id) throw new HttpError(502, `Kick did not accept the ${eventName} subscription${s?.error ? ': ' + s.error : ''}.`);
  return s.subscription_id;
}

export async function unsubscribe(env, subscriptionId) {
  await api(env, 'DELETE', '/public/v1/events/subscriptions', { query: { id: subscriptionId } });
}

/* ---------- webhook signatures: RSA PKCS#1 v1.5 + SHA-256 over `${messageId}.${timestamp}.${body}` ---------- */

let publicKey = null, publicKeyAt = 0;
async function loadPublicKey(env, force) {
  if (publicKey && !force) return publicKey;
  publicKeyAt = Date.now();
  let pem = env.KICK_PUBLIC_KEY;
  if (!pem) {
    const res = await fetch(new URL('/public/v1/public-key', apiBase(env)));
    if (!res.ok) throw new HttpError(502, 'Could not fetch the Kick webhook public key.');
    pem = (await res.json())?.data?.public_key;
  }
  const der = unb64(String(pem).replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, ''));
  publicKey = await crypto.subtle.importKey('spki', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  return publicKey;
}

export async function verifyWebhook(env, { messageId, timestamp, signature, body }) {
  if (!messageId || !timestamp || !signature) return false;
  let sig;
  try { sig = unb64(signature); } catch { return false; }
  const data = enc.encode(`${messageId}.${timestamp}.${body}`);
  const check = async force => crypto.subtle.verify('RSASSA-PKCS1-v1_5', await loadPublicKey(env, force), sig, data);
  if (await check(false)) return true;
  // Kick may have rotated its key: refetch, at most once every 10 minutes so forged requests can't hammer Kick.
  return !env.KICK_PUBLIC_KEY && Date.now() - publicKeyAt > 600_000 && check(true);
}
