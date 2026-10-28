-- Hot Potato Arena schema (plan section 9, plus columns the state machine needs).

CREATE TABLE giveaways (
  id               TEXT PRIMARY KEY,
  channel_id       TEXT NOT NULL,
  -- draft | open | locked | running | done | claimed | expired | cancelled
  status           TEXT NOT NULL DEFAULT 'draft',
  prize_ct         TEXT,              -- AES-GCM ciphertext (base64); plaintext is never stored
  prize_iv         TEXT,              -- AES-GCM IV (base64)
  entry_seconds    INTEGER NOT NULL DEFAULT 45,
  claim_seconds    INTEGER NOT NULL DEFAULT 120,
  sub_weight       INTEGER NOT NULL DEFAULT 3,
  seed_hash        TEXT,
  seed             TEXT,              -- only returned publicly once the round has finished
  entrant_hash     TEXT,
  nonce            INTEGER NOT NULL DEFAULT 0,
  excluded_ids     TEXT NOT NULL DEFAULT '[]',  -- JSON array of earlier winners (rerolls)
  elimination      TEXT,              -- JSON array of Kick ids, cached copy of the draw
  winner_id        TEXT,
  created_at       INTEGER NOT NULL,  -- all times are epoch milliseconds
  opened_at        INTEGER,
  entries_close_at INTEGER,
  locked_at        INTEGER,
  launched_at      INTEGER,
  round_ms         INTEGER,           -- planned animation length for the current draw
  claim_deadline   INTEGER
);
CREATE INDEX giveaways_channel_created ON giveaways (channel_id, created_at DESC);

CREATE TABLE entrants (
  giveaway_id      TEXT NOT NULL REFERENCES giveaways (id),
  kick_user_id     TEXT NOT NULL,
  username         TEXT NOT NULL,
  avatar_url       TEXT,
  is_sub           INTEGER NOT NULL DEFAULT 0,
  rejected_reason  TEXT,              -- shown in the host panel only
  joined_at        INTEGER NOT NULL,
  PRIMARY KEY (giveaway_id, kick_user_id)
);

CREATE TABLE seen_users (
  kick_user_id     TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  first_seen_at    INTEGER NOT NULL,
  PRIMARY KEY (kick_user_id, channel_id)
);

CREATE TABLE claims (
  giveaway_id      TEXT NOT NULL REFERENCES giveaways (id),
  kick_user_id     TEXT NOT NULL,
  claimed_at       INTEGER NOT NULL,
  PRIMARY KEY (giveaway_id)
);

-- Kick webhook dedupe (Kick-Event-Message-Id), used from phase 4.
CREATE TABLE webhook_events (
  message_id       TEXT PRIMARY KEY,
  received_at      INTEGER NOT NULL
);
