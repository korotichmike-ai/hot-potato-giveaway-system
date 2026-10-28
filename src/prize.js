// Prize links are encrypted at rest with AES-GCM (plan section 6). The key comes from the
// PRIZE_KEY Worker secret: 32 random bytes in base64, or any passphrase of 16+ characters
// (hashed with SHA-256 into a key). The giveaway id is bound in as additional data,
// so a ciphertext can't be copied onto another giveaway. Nothing in the host API decrypts;
// only the winner's claim (phase 5) does.
import { HttpError, b64, unb64 } from './http.js';

const enc = new TextEncoder();

async function prizeKey(env, usage) {
  if (!env.PRIZE_KEY) throw new HttpError(500, 'The PRIZE_KEY secret is not set on the server.');
  let raw;
  try { raw = unb64(env.PRIZE_KEY); } catch { raw = null; }
  if (!raw || raw.length !== 32) {
    if (env.PRIZE_KEY.length < 16) throw new HttpError(500, 'PRIZE_KEY is too short. Use at least 16 random characters.');
    raw = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(env.PRIZE_KEY)));
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);
}

export async function encryptPrize(env, giveawayId, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(giveawayId) },
    await prizeKey(env, 'encrypt'),
    enc.encode(text),
  );
  return { ct: b64(ct), iv: b64(iv) };
}

export async function decryptPrize(env, giveawayId, ct, iv) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(giveawayId) },
    await prizeKey(env, 'decrypt'),
    unb64(ct),
  );
  return new TextDecoder().decode(pt);
}
