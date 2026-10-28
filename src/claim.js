// Prize claim (plan section 6): the winner logs in with Kick and sees the prize link once.
import { HttpError, json } from './http.js';
import { getSession, requireCsrfHeader } from './auth.js';
import { decryptPrize } from './prize.js';
import { latestGiveaway, settle } from './store.js';

export async function claimState(env, request) {
  const user = await getSession(env, request);
  const g = await settle(env, await latestGiveaway(env));
  let giveaway = null;
  if (g && g.winner_id && ['running', 'done', 'claimed', 'expired'].includes(g.status)) {
    // While the round is still playing, nobody learns the winner from this endpoint.
    const playing = g.status === 'running';
    const winner = playing ? null : await env.DB.prepare('SELECT username FROM entrants WHERE giveaway_id = ? AND kick_user_id = ?').bind(g.id, g.winner_id).first();
    giveaway = {
      id: g.id, status: g.status, claimDeadline: g.claim_deadline, roundEndsAt: g.launched_at + g.round_ms,
      isWinner: !playing && !!user && user.userId === g.winner_id,
      winnerName: winner?.username || null,
    };
  }
  return json({ now: Date.now(), user, giveaway });
}

export async function revealPrize(env, request) {
  requireCsrfHeader(request);
  const user = await getSession(env, request);
  if (!user) throw new HttpError(401, 'Log in with Kick first.');
  const g = await settle(env, await latestGiveaway(env));
  if (!g || !g.winner_id) throw new HttpError(404, 'There is no giveaway to claim right now.');
  if (g.status === 'running') throw new HttpError(409, 'The round is still playing. Wait for the winner card.');
  if (g.status === 'claimed') throw new HttpError(409, 'This prize has already been claimed.');
  if (g.status === 'expired') throw new HttpError(410, 'The claim time ran out, so the prize goes to a reroll.');
  if (g.status !== 'done') throw new HttpError(409, 'There is no prize waiting to be claimed.');
  if (user.userId !== g.winner_id) throw new HttpError(403, `You are logged in as ${user.username}, who did not win this giveaway.`);
  const now = Date.now();
  if (now >= g.claim_deadline) throw new HttpError(410, 'The claim time ran out, so the prize goes to a reroll.');

  const prize = await decryptPrize(env, g.id, g.prize_ct, g.prize_iv);
  const ins = await env.DB.prepare('INSERT OR IGNORE INTO claims (giveaway_id, kick_user_id, claimed_at) VALUES (?, ?, ?)').bind(g.id, user.userId, now).run();
  if (ins.meta.changes !== 1) throw new HttpError(409, 'This prize has already been claimed.');
  // Shown once: the ciphertext is wiped as the claim is recorded.
  await env.DB.prepare("UPDATE giveaways SET status = 'claimed', prize_ct = NULL, prize_iv = NULL WHERE id = ?").bind(g.id).run();
  return json({ prize });
}
