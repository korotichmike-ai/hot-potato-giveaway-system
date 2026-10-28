// Launching and rerolling a round. Shared by the host API and the ban handler.
import { drawOrder, newServerSeed, seedHash } from '../public/js/draw.js';
import { roundMs } from '../public/js/pacing.js';
import { HttpError } from './http.js';
import { eligible, listEntrants, toDrawEntrant } from './store.js';

const need = (cond, message, status = 409) => { if (!cond) throw new HttpError(status, message); };

export async function launch(env, g) {
  need(g.status === 'locked', g.status === 'open' ? 'Lock entries before launching.' : 'This giveaway has already launched.');
  need(!!g.prize_ct, 'Add the prize link before launching.');
  const pool = eligible(await listEntrants(env, g.id));
  need(pool.length > 0, 'Nobody entered, so there is nothing to launch. Cancel this giveaway and start a new one.');
  const seed = newServerSeed();
  const res = await drawOrder({ giveawayId: g.id, serverSeed: seed, entrants: pool.map(toDrawEntrant), weights: { sub: g.sub_weight, nonSub: 1 } });
  need(res.listHash === g.entrant_hash, 'The entrant list changed after it was locked, so the round was not launched.', 500);
  const now = Date.now(), ms = roundMs(pool.length);
  const r = await env.DB.prepare(
    "UPDATE giveaways SET status = 'running', seed = ?, seed_hash = ?, elimination = ?, winner_id = ?, launched_at = ?, round_ms = ?, claim_deadline = ? WHERE id = ? AND status = 'locked'"
  ).bind(seed, await seedHash(seed), JSON.stringify(res.eliminationOrder), res.winnerId, now, ms, now + ms + g.claim_seconds * 1000, g.id).run();
  need(r.meta.changes === 1, 'This giveaway has already launched.');
}

// fromStatus is 'expired' for a host reroll, or the current status when a banned winner is replaced.
export async function reroll(env, g, fromStatus = 'expired') {
  need(g.status === fromStatus, g.status === 'done' ? 'The winner can still claim. Reroll is available once the claim timer runs out.' : 'Reroll is only available after an unclaimed win.');
  const excluded = [...JSON.parse(g.excluded_ids), g.winner_id];
  const pool = eligible(await listEntrants(env, g.id));
  const left = pool.filter(e => !excluded.includes(e.kick_user_id));
  need(left.length > 0, 'Everyone who entered has already won and not claimed. There is nobody left to reroll to.');
  const nonce = g.nonce + 1;
  const res = await drawOrder({ giveawayId: g.id, serverSeed: g.seed, entrants: pool.map(toDrawEntrant), nonce, excludeIds: excluded, weights: { sub: g.sub_weight, nonSub: 1 } });
  const now = Date.now(), ms = roundMs(left.length, { short: true });
  const r = await env.DB.prepare(
    "UPDATE giveaways SET status = 'running', nonce = ?, excluded_ids = ?, elimination = ?, winner_id = ?, launched_at = ?, round_ms = ?, claim_deadline = ? WHERE id = ? AND status = ? AND nonce = ?"
  ).bind(nonce, JSON.stringify(excluded), JSON.stringify(res.eliminationOrder), res.winnerId, now, ms, now + ms + g.claim_seconds * 1000, g.id, fromStatus, g.nonce).run();
  need(r.meta.changes === 1, 'This giveaway was already rerolled.');
}

// A winner banned from chat before claiming loses the win; the next draw plays right away.
export async function autoRerollBanned(env, g) {
  try {
    await reroll(env, g, g.status);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    // Nobody left to reroll to: at least stop the banned winner from claiming.
    await env.DB.prepare("UPDATE giveaways SET status = 'expired' WHERE id = ? AND status IN ('running', 'done')").bind(g.id).run();
  }
}
