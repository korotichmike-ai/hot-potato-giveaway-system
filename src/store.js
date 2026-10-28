// D1 access and the giveaway state machine.
//
//   draft -> open -> locked -> running -> done -> claimed
//                                          \-> expired -> (reroll) -> running ...
//   any state before running -> cancelled
//
// Time-based steps happen lazily in settle(): an open giveaway locks itself when the entry
// window ends, a running one becomes done when the animation ends, and done becomes expired
// when the claim window runs out without a claim.
import { entrantListHash } from '../public/js/draw.js';
import { stopChat } from './chat.js';

export const ACTIVE = ['draft', 'open', 'locked', 'running', 'done'];
export const FINISHED_ROUND = ['done', 'claimed', 'expired'];

export function newId() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return 'gw_' + [...bytes].map(b => alphabet[b % 32]).join('');
}

export async function getGiveaway(env, id) {
  return env.DB.prepare('SELECT * FROM giveaways WHERE id = ?').bind(id).first();
}

export async function latestGiveaway(env) {
  return env.DB.prepare('SELECT * FROM giveaways WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1').bind(env.CHANNEL_ID).first();
}

export async function listEntrants(env, id) {
  const { results } = await env.DB.prepare('SELECT * FROM entrants WHERE giveaway_id = ? ORDER BY joined_at, kick_user_id').bind(id).all();
  return results;
}

export const eligible = entrants => entrants.filter(e => !e.rejected_reason);

export function toDrawEntrant(e) {
  return { id: e.kick_user_id, isSub: !!e.is_sub };
}

// Freeze the entrant list: hash of eligible entrants, sorted by Kick id, with sub flags.
// The status flips first; entrant inserts check the status in the same statement, so nobody
// can slip in between the flip and the hash.
export async function lockGiveaway(env, g, now) {
  const res = await env.DB.prepare("UPDATE giveaways SET status = 'locked', locked_at = ? WHERE id = ? AND status = 'open'").bind(now, g.id).run();
  if (res.meta.changes !== 1) return false;
  const hash = await entrantListHash(eligible(await listEntrants(env, g.id)).map(toDrawEntrant));
  await env.DB.prepare('UPDATE giveaways SET entrant_hash = ? WHERE id = ?').bind(hash, g.id).run();
  await stopChat(env);
  return true;
}

// Apply any time-based transitions and return the fresh row.
export async function settle(env, g, now = Date.now()) {
  if (!g) return g;
  let changed = false;
  if (g.status === 'open' && g.entries_close_at && now >= g.entries_close_at) {
    changed = await lockGiveaway(env, g, now) || changed;
  }
  if (g.status === 'running' && now >= g.launched_at + g.round_ms) {
    const r = await env.DB.prepare("UPDATE giveaways SET status = 'done' WHERE id = ? AND status = 'running'").bind(g.id).run();
    changed = r.meta.changes === 1 || changed;
    g = await getGiveaway(env, g.id);
  }
  if (g.status === 'done' && g.claim_deadline && now >= g.claim_deadline) {
    const r = await env.DB.prepare("UPDATE giveaways SET status = 'expired' WHERE id = ? AND status = 'done' AND NOT EXISTS (SELECT 1 FROM claims WHERE giveaway_id = ?)")
      .bind(g.id, g.id).run();
    changed = r.meta.changes === 1 || changed;
  }
  return changed ? getGiveaway(env, g.id) : g;
}
