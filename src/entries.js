// Entry rules (plan section 5). The Kick chat webhook (phase 4) calls addEntrant for every
// "!join"; the test-entrant button in the host panel uses the same path.

// Returns null to accept, or a reason shown only in the host panel.
async function rejectionReason(env, user, now) {
  // Phase 6: Kick account must be at least 30 days old. Until the age check exists we only
  // log first sightings so the 30-day history starts building up.
  await env.DB.prepare('INSERT OR IGNORE INTO seen_users (kick_user_id, channel_id, first_seen_at) VALUES (?, ?, ?)')
    .bind(user.id, env.CHANNEL_ID, now).run();
  return user.rejectReason || null;
}

function ignored(env, user) {
  if (env.BROADCASTER_USER_ID && user.id === String(env.BROADCASTER_USER_ID)) return true;
  const block = String(env.BLOCKLIST || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  return block.includes(user.id) || block.includes(String(user.username).toLowerCase());
}

// user: { id, username, avatarUrl, isSub }. Returns 'added' | 'duplicate' | 'closed' | 'ignored'.
export async function addEntrant(env, g, user, now = Date.now()) {
  if (g.status !== 'open' || now >= g.entries_close_at) return 'closed';
  if (!/^\d+$/.test(String(user.id))) return 'ignored';
  user = { ...user, id: String(user.id) };
  if (ignored(env, user)) return 'ignored';
  const reason = await rejectionReason(env, user, now);
  const res = await env.DB.prepare(
    'INSERT OR IGNORE INTO entrants (giveaway_id, kick_user_id, username, avatar_url, is_sub, rejected_reason, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(g.id, user.id, String(user.username).slice(0, 40), user.avatarUrl || null, user.isSub ? 1 : 0, reason, now).run();
  return res.meta.changes === 1 ? 'added' : 'duplicate';
}

const ADJ = ['Lucky', 'Salty', 'Crypto', 'Bandit', 'Turbo', 'Midnight', 'Rapid', 'Golden', 'Neon', 'Silent', 'Wild', 'Frosty', 'Spicy', 'Shadow', 'Ninja', 'Royal', 'Mega', 'Sneaky', 'Cosmic', 'Rusty'];
const NOUN = ['Ace', 'Raccoon', 'Gambler', 'Whale', 'Shark', 'Fox', 'Dealer', 'Rider', 'Wolf', 'Spinner', 'Jackpot', 'Hustler', 'Viking', 'Panda', 'Cobra', 'Falcon', 'Goblin', 'Tiger', 'Nugget', 'Bagel'];
const pick = a => a[Math.floor(Math.random() * a.length)];

// Fake viewers for rehearsals. About 1 in 15 is marked as rejected so the panel shows that state.
export function fakeUsers(count, subPct) {
  return Array.from({ length: count }, () => ({
    id: String(90000000 + Math.floor(Math.random() * 9000000)),
    username: pick(ADJ) + pick(NOUN) + (Math.random() < 0.5 ? Math.floor(Math.random() * 999) : ''),
    avatarUrl: null,
    isSub: Math.random() * 100 < subPct,
    rejectReason: Math.random() < 1 / 15 ? 'Test viewer: account newer than 30 days' : null,
  }));
}
