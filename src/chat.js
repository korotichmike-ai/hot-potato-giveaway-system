// Kick chat: "!join" entries via webhooks.
// To stay inside Cloudflare's free request limits, the chat subscription only exists while
// entries are open: it is created on Open and deleted on Lock/Cancel (and any stray one is
// removed by the webhook handler itself). Bans stay subscribed so a banned winner is rerolled.
import { json } from './http.js';
import { kickConfigured, subscribe, unsubscribe, verifyWebhook } from './kick.js';
import { addEntrant } from './entries.js';
import { latestGiveaway, settle } from './store.js';
import { autoRerollBanned } from './rounds.js';

const JOIN = /^!join\b/i;
const SUB_BADGES = ['subscriber', 'founder'];

export function channelState(env) {
  return env.DB.prepare('SELECT * FROM channel_state WHERE channel_id = ?').bind(env.CHANNEL_ID).first();
}

async function setChannel(env, fields) {
  const keys = Object.keys(fields);
  await env.DB.prepare(`UPDATE channel_state SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE channel_id = ?`)
    .bind(...keys.map(k => fields[k]), env.CHANNEL_ID).run();
}

export async function ensureBanSubscription(env) {
  const cs = await channelState(env);
  if (!cs?.broadcaster_user_id || cs.ban_sub_id || !kickConfigured(env)) return;
  await setChannel(env, { ban_sub_id: await subscribe(env, cs.broadcaster_user_id, 'moderation.banned') });
}

// Called when entries open. Errors are stored and shown in the host panel rather than thrown,
// so a Kick hiccup never blocks the giveaway (test entrants and the host key still work).
export async function startChat(env) {
  const cs = await channelState(env);
  if (!cs?.broadcaster_user_id || !kickConfigured(env)) return;
  if (cs.chat_sub_id) return;
  try {
    const id = await subscribe(env, cs.broadcaster_user_id, 'chat.message.sent');
    await setChannel(env, { chat_sub_id: id, sub_error: null, last_chat_at: null });
  } catch (err) {
    await setChannel(env, { sub_error: err.message });
  }
}

export async function stopChat(env) {
  const cs = await channelState(env);
  if (!cs?.chat_sub_id) return;
  await setChannel(env, { chat_sub_id: null });
  await unsubscribe(env, cs.chat_sub_id).catch(() => {}); // a leftover subscription is cleaned up by the webhook
}

/* ---------- webhook ---------- */

let lastChatNote = 0;
const strayUnsubscribed = new Set();

export async function handleWebhook(env, request, ctx) {
  const body = await request.text();
  const h = name => request.headers.get(name);
  const timestamp = h('Kick-Event-Message-Timestamp');
  const valid = await verifyWebhook(env, { messageId: h('Kick-Event-Message-Id'), timestamp, signature: h('Kick-Event-Signature'), body });
  if (!valid) return json({ error: 'Invalid signature.' }, 401);
  const sent = Date.parse(timestamp);
  if (!sent || Math.abs(Date.now() - sent) > 10 * 60_000) return json({ error: 'Stale event.' }, 400);
  let event;
  try { event = JSON.parse(body); } catch { return json({ error: 'Invalid JSON.' }, 400); }

  const type = h('Kick-Event-Type');
  if (type === 'chat.message.sent') return onChat(env, event, h('Kick-Event-Subscription-Id'), ctx);
  if (type === 'moderation.banned') return onBan(env, event, h('Kick-Event-Message-Id'));
  return json({ ok: true, ignored: type });
}

async function onChat(env, ev, subscriptionId, ctx) {
  const now = Date.now();
  if (now - lastChatNote > 15_000) {
    lastChatNote = now;
    ctx.waitUntil(setChannel(env, { last_chat_at: now }).catch(() => {}));
  }
  if (!JOIN.test(String(ev.content || '').trim())) return json({ ok: true });

  const cs = await channelState(env);
  if (!cs || String(ev.broadcaster?.user_id) !== cs.broadcaster_user_id) return json({ ok: true, ignored: 'other channel' });
  const g = await settle(env, await latestGiveaway(env), now);
  if (!g || g.status !== 'open') {
    // Entries are closed but chat is still arriving: remove the leftover subscription.
    if (subscriptionId && !strayUnsubscribed.has(subscriptionId)) {
      strayUnsubscribed.add(subscriptionId);
      ctx.waitUntil(unsubscribe(env, subscriptionId).catch(() => {}));
    }
    return json({ ok: true, ignored: 'entries closed' });
  }
  const s = ev.sender || {};
  if (s.is_anonymous || !s.user_id) return json({ ok: true, ignored: 'anonymous' });
  const badges = (s.identity?.badges || []).map(b => b.type);
  const result = await addEntrant(env, g, {
    id: String(s.user_id), username: s.username, avatarUrl: s.profile_picture || null,
    isSub: badges.some(b => SUB_BADGES.includes(b)),
  }, now, { broadcasterId: cs.broadcaster_user_id });
  return json({ ok: true, result });
}

async function onBan(env, ev, messageId) {
  const fresh = await env.DB.prepare('INSERT OR IGNORE INTO webhook_events (message_id, received_at) VALUES (?, ?)').bind(messageId, Date.now()).run();
  if (fresh.meta.changes !== 1) return json({ ok: true, duplicate: true });
  const cs = await channelState(env);
  if (!cs || String(ev.broadcaster?.user_id) !== cs.broadcaster_user_id) return json({ ok: true, ignored: 'other channel' });
  const bannedId = String(ev.banned_user?.user_id || '');
  const g = await settle(env, await latestGiveaway(env));
  if (!g || !bannedId) return json({ ok: true });
  if (g.status === 'open') {
    await env.DB.prepare("UPDATE entrants SET rejected_reason = 'Banned from chat' WHERE giveaway_id = ? AND kick_user_id = ?").bind(g.id, bannedId).run();
  } else if (['running', 'done'].includes(g.status) && g.winner_id === bannedId) {
    await autoRerollBanned(env, g);
  }
  return json({ ok: true });
}
