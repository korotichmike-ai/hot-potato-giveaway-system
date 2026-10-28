# Hot Potato Arena

Provably fair giveaway overlay for Kick streams. Viewers type `!join`, everyone spawns as a ball in an arena, a hot potato bounces around knocking them out, and the last ball standing wins. Subs get 3x luck.

The winner and the full elimination order are drawn on the server before the animation starts. The animation only plays that order back. Anyone can recompute any round on its `/verify/<id>` page.

## Pages

| Path | Who | What |
|---|---|---|
| `/host/` | Streamer (phone friendly) | Log in with Kick, start a giveaway, set the prize, open and close entries, launch, reroll |
| `/overlay/?key=…` | OBS browser source, 1920×1080 | Join banner, arena, winner card. Add `&preview=1` for a dark background outside OBS |
| `/claim/` | Winner | Log in with Kick and hold to reveal the prize link, once |
| `/verify/<id>` | Anyone | Recomputes the draw from the revealed seed and entrant list |

## How a round works

1. **New giveaway**. Paste the prize link: it is encrypted with AES-GCM and the host can only replace it, never view it.
2. **Open entries** for N seconds (default 45). The server subscribes to the channel's Kick chat and every `!join` adds that viewer (one entry each; sub badge = 3x luck; the streamer, bots on the blocklist and banned viewers are left out). Entries lock automatically when the timer ends, or early with *Close entries now*. Locking freezes the entrant list and its hash, and unsubscribes from chat.
3. **Launch**: the server makes a random seed, shows its SHA-256 on the overlay, and draws the order (`public/js/draw.js`, algorithm `hp-draw-v1`).
4. When the last ball pops, the seed is revealed and the claim timer starts (default 2:00). The winner opens `/claim`, logs in with Kick, and sees the prize once.
5. If nobody claims in time, **Reroll** draws again with the same seed and draw number + 1, leaving earlier winners out, and plays a short replay. A winner banned from chat before claiming is rerolled automatically.

## Fairness

- Weights: subs 3, everyone else 1. No other weighting exists anywhere.
- RNG: HMAC-SHA256 keyed with the seed over `giveawayId:entrantListHash:drawNumber:block`, with rejection sampling (no modulo bias).
- `npm test` runs 100,000 simulated rounds and checks a sub wins about 3x as often as a non-sub (chi-square on every entrant).

## Going live

### 1. Cloudflare (free plan)

1. **Storage & databases → D1 → Create database** named `hot-potato-arena`. Put its Database ID in `wrangler.toml` (`database_id`). Tables are created automatically on the first request.
2. **Compute → Workers & Pages → Create → Import a repository**, pick this repo, keep the defaults (deploy command `npx wrangler deploy`). Every push to `main` redeploys.
3. In the Worker's **Settings → Variables and secrets**, add these as **Secrets**:
   - `OVERLAY_KEY`: any long random text (it goes in the OBS link)
   - `PRIZE_KEY`: any long random text, 16+ characters. Don't change it while a prize is waiting to be claimed.
   - `HOST_KEY` (optional): backup password for the host panel
   - `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET`: from step 2

### 2. Kick developer app (the streamer's account)

At [kick.com/settings/developer](https://kick.com/settings/developer) (2FA required) create an app:
- **Redirect URL**: `https://<your worker address>/api/auth/callback`
- **Enable webhooks**: on, **Webhook URL**: `https://<your worker address>/api/kick/webhook`
- **Scopes**: `user:read` and `events:subscribe`

Then set `KICK_CHANNEL_SLUG` in `wrangler.toml` to the channel name (as in `kick.com/<name>`). Only that account can log in to the host panel.

Other settings in `[vars]`: `CLAIM_SITE` (address shown on the winner card), `PUBLIC_URL` (if you use a custom domain), default windows, `BLOCKLIST`, and `ALLOW_TEST_ENTRANTS` (set to `"false"` once real chat entries work).

## Local development

```bash
npm install
cat > .dev.vars <<'EOF'
HOST_KEY="pick-a-long-password"
OVERLAY_KEY="another-long-random-string"
PRIZE_KEY="yet-another-long-random-string"
EOF
npm run dev          # http://127.0.0.1:8787/host/
npm run e2e          # in another terminal: full round against the dev server
npm test             # unit + 100k-round fairness test (npm run test:quick for 20k)
```

`npm run e2e:kick` tests Kick login, chat entries, bans and the claim against a fake Kick server it starts itself. It needs these extra lines in `.dev.vars`:

```
KICK_CLIENT_ID="test-client"
KICK_CLIENT_SECRET="test-secret"
KICK_CHANNEL_SLUG="teststreamer"
KICK_ID_BASE="http://127.0.0.1:8799"
KICK_API_BASE="http://127.0.0.1:8799"
```

## Build status

- [x] Phase 1: offline arena preview
- [x] Phase 2: shared draw module, `/verify`, fairness tests
- [x] Phase 3: Worker + D1 + host panel + encrypted prize storage
- [x] Phase 4: Kick login for the streamer, chat webhooks for `!join`, sub badges, bans
- [x] Phase 5: claim flow (Kick login, one-time reveal, reroll)
- [ ] Phase 6: 30-day account age check. Kick's public API has no account creation date, so this will use first-seen-in-chat logging (already recording) or an unofficial endpoint.
- [ ] Phase 7: sounds and polish
