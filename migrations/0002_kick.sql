-- Phase 4/5: Kick login sessions and chat subscription state.

CREATE TABLE oauth_states (
  state            TEXT PRIMARY KEY,
  verifier         TEXT NOT NULL,      -- PKCE code verifier
  role             TEXT NOT NULL,      -- host | winner
  created_at       INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash       TEXT PRIMARY KEY,   -- sha256 of the cookie value; the raw token is never stored
  kick_user_id     TEXT NOT NULL,
  username         TEXT NOT NULL,
  avatar_url       TEXT,
  role             TEXT NOT NULL,      -- host | winner
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL
);

CREATE TABLE channel_state (
  channel_id           TEXT PRIMARY KEY,
  broadcaster_user_id  TEXT,
  broadcaster_username TEXT,
  chat_sub_id          TEXT,           -- chat.message.sent subscription, only while entries are open
  ban_sub_id           TEXT,           -- moderation.banned subscription, kept while a host is set up
  sub_error            TEXT,
  last_chat_at         INTEGER
);
