CREATE TABLE IF NOT EXISTS telegram_links (
  chat_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_link_codes (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS telegram_links_user_id ON telegram_links(user_id);
CREATE INDEX IF NOT EXISTS telegram_link_codes_expires_at ON telegram_link_codes(expires_at);
