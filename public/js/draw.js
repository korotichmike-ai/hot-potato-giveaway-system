// Hot Potato Arena: provably fair draw.
// Pure ES module shared by the Worker (Cloudflare runtime) and the /verify page (browser).
// Uses only Web Crypto, so it also runs unchanged in Node 20+.
//
// Algorithm hp-draw-v1
// 1. Canonical entrant list: one line per entrant, `<kickUserId>:<1 if sub else 0>`,
//    sorted by numeric Kick user id ascending, joined with "\n". listHash = sha256 hex of that text.
// 2. RNG: HMAC-SHA256 keyed with the 32 raw bytes of serverSeed (64 hex chars).
//    Block k is HMAC(`${giveawayId}:${listHash}:${nonce}:${k}`), k = 0, 1, 2, ...
//    Each block is read as eight big-endian uint32 words, consumed in order.
// 3. Uniform integer in [0, n): take the next word x; reject and take another while
//    x >= 2^32 - (2^32 mod n); otherwise use x mod n. No modulo bias.
// 4. Survival order: from the entrants still in the draw (canonical order), pick one with
//    probability weight / total weight (sub = 3, non-sub = 1) by drawing r in [0, total) and
//    walking the list subtracting weights until r < 0. Remove the pick, repeat. When one
//    entrant remains it is placed last without consuming randomness.
// 5. The first pick is the winner. Elimination order (what the overlay shows) is the
//    survival order minus the winner, reversed: the runner-up is eliminated last.
// 6. Reroll: same seed and entrant list (so listHash is unchanged), nonce + 1, and every
//    previous winner listed in excludeIds is removed before step 4.

export const ALGORITHM = 'hp-draw-v1';
export const WEIGHTS = Object.freeze({ sub: 3, nonSub: 1 });

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const TWO_32 = 2 ** 32;

export function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error('Expected an even-length hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(text) {
  return bytesToHex(await subtle.digest('SHA-256', enc.encode(text)));
}

export function newServerSeed() {
  return bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export function seedHash(serverSeed) {
  checkSeed(serverSeed);
  return sha256Hex(serverSeed.toLowerCase());
}

function checkSeed(serverSeed) {
  if (typeof serverSeed !== 'string' || !/^[0-9a-f]{64}$/i.test(serverSeed)) {
    throw new Error('serverSeed must be 64 hex characters (32 bytes)');
  }
}

// Returns entrants as [{ id: string, isSub: boolean }] sorted by numeric id. Rejects duplicates.
export function canonicalEntrants(entrants) {
  const seen = new Set();
  const list = entrants.map(e => {
    const id = String(e.id ?? e.kickUserId ?? e.kick_user_id).trim();
    if (!/^\d+$/.test(id)) throw new Error(`Invalid Kick user id: ${id}`);
    if (seen.has(id)) throw new Error(`Duplicate entrant id: ${id}`);
    seen.add(id);
    return { id, isSub: Boolean(e.isSub ?? e.is_sub) };
  });
  return list.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
}

export function canonicalText(entrants) {
  return canonicalEntrants(entrants).map(e => `${e.id}:${e.isSub ? 1 : 0}`).join('\n');
}

export function entrantListHash(entrants) {
  return sha256Hex(canonicalText(entrants));
}

export async function createRng(serverSeed, message) {
  checkSeed(serverSeed);
  const key = await subtle.importKey('raw', hexToBytes(serverSeed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  let block = 0;
  const words = [];
  async function nextU32() {
    if (!words.length) {
      const sig = new DataView(await subtle.sign('HMAC', key, enc.encode(`${message}:${block++}`)));
      for (let i = 0; i < 32; i += 4) words.push(sig.getUint32(i));
    }
    return words.shift();
  }
  async function below(n) {
    if (!Number.isInteger(n) || n < 1 || n > TWO_32) throw new Error('below(n) needs 1 <= n <= 2^32');
    const limit = TWO_32 - (TWO_32 % n);
    let x;
    do { x = await nextU32(); } while (x >= limit);
    return x % n;
  }
  return { nextU32, below, blocksUsed: () => block };
}

export async function drawOrder({ giveawayId, serverSeed, entrants, nonce = 0, excludeIds = [], weights = WEIGHTS }) {
  if (!giveawayId || /:/.test(String(giveawayId))) throw new Error('giveawayId is required and must not contain ":"');
  if (!Number.isInteger(nonce) || nonce < 0) throw new Error('nonce must be a non-negative integer');
  const list = canonicalEntrants(entrants);
  const listHash = await sha256Hex(list.map(e => `${e.id}:${e.isSub ? 1 : 0}`).join('\n'));
  const message = `${giveawayId}:${listHash}:${nonce}`;
  const rng = await createRng(serverSeed, message);
  const excluded = new Set(excludeIds.map(String));
  const weightOf = e => (e.isSub ? weights.sub : weights.nonSub);

  const remaining = list.filter(e => !excluded.has(e.id));
  const survival = [];
  while (remaining.length > 1) {
    const total = remaining.reduce((s, e) => s + weightOf(e), 0);
    let r = await rng.below(total);
    let i = 0;
    for (; i < remaining.length; i++) {
      r -= weightOf(remaining[i]);
      if (r < 0) break;
    }
    survival.push(remaining.splice(i, 1)[0]);
  }
  if (remaining.length) survival.push(remaining[0]);

  return {
    algorithm: ALGORITHM,
    weights: { ...weights },
    giveawayId: String(giveawayId),
    nonce,
    listHash,
    message,
    excludeIds: [...excluded],
    winnerId: survival.length ? survival[0].id : null,
    survivalOrder: survival.map(e => e.id),
    eliminationOrder: survival.slice(1).reverse().map(e => e.id),
  };
}
