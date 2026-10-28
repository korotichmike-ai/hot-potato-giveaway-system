# Hot Potato Arena

Provably fair giveaway overlay for Kick streams. Viewers type `!join`, everyone spawns as a ball in an arena, a hot potato bounces around knocking them out, and the last ball standing wins. Subs get 3x luck.

The winner and the full elimination order are drawn on the server before the animation starts. The animation only plays that order back. Anyone can recompute any round on its `/verify/<id>` page.

## Pages

| Path | Who | What |
|---|---|---|
| `/host/` | Streamer (phone friendly) | Start a giveaway, set the prize, open and close entries, launch, reroll |
| `/overlay/?key=…` | OBS browser source, 1920×1080 | Join banner, arena, winner card. Add `&preview=1` for a dark background outside OBS |
| `/verify/<id>` | Anyone | Recomputes the draw from the revealed seed and entrant list |
| `/claim/` | Winner | Placeholder until phase 5 (Kick login + one-time prize reveal) |

## How a round works

1. **New giveaway** (draft). Paste the prize link: it is encrypted with AES-GCM and the host can only replace it, never view it.
2. **Open entries** for N seconds (default 45). Entries lock automatically when the timer ends, or early with *Close entries now*. Locking freezes the entrant list and its hash.
3. **Launch**: the server makes a random seed, shows its SHA-256 on the overlay, and draws the order (`public/js/draw.js`, algorithm `hp-draw-v1`).
4. When the last ball pops, the seed is revealed and the claim timer starts (default 2:00).
5. If nobody claims in time, **Reroll** draws again with the same seed and draw number + 1, leaving earlier winners out, and plays a short replay.

## Fairness

- Weights: subs 3, everyone else 1. No other weighting exists anywhere.
- RNG: HMAC-SHA256 keyed with the seed over `giveawayId:entrantListHash:drawNumber:block`, with rejection sampling (no modulo bias).
- `npm test` runs 100,000 simulated rounds and checks a sub wins about 3x as often as a non-sub (chi-square on every entrant).

## Local development

```bash
npm install
# local secrets (never commit this file)
cat > .dev.vars <<'EOF'
HOST_KEY="pick-a-long-password"
OVERLAY_KEY="another-long-random-string"
PRIZE_KEY="<32 random bytes, base64>"   # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
EOF
npm run db:migrate:local
npm run dev          # http://127.0.0.1:8787/host/
npm run e2e          # in another terminal: full round against the dev server
npm test             # unit + 100k-round fairness test (npm run test:quick for 20k)
```

## Deploying to Cloudflare (free plan)

```bash
npx wrangler login
npx wrangler d1 create hot-potato-arena      # copy the database_id into wrangler.toml
npm run db:migrate
npx wrangler secret put HOST_KEY
npx wrangler secret put OVERLAY_KEY
npx wrangler secret put PRIZE_KEY
npm run deploy
```

Settings live in `[vars]` in `wrangler.toml` (claim site shown on the winner card, default windows, sub weight, blocklist). Set `ALLOW_TEST_ENTRANTS = "false"` once real Kick chat entries are working.

## Build status

- [x] Phase 1: offline arena preview
- [x] Phase 2: shared draw module, `/verify`, fairness tests
- [x] Phase 3: Worker + D1 + host panel + encrypted prize storage (host login is a shared key for now)
- [ ] Phase 4: Kick OAuth (broadcaster + winner), chat webhook for `!join`, sub badges
- [ ] Phase 5: claim flow
- [ ] Phase 6: 30-day account age check (first-seen logging already runs)
- [ ] Phase 7: sounds and polish
