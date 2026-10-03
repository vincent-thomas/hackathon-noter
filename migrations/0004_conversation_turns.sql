-- Recent exchanges per conversation, so "change that to 4 o'clock" and "say that again?" have context.
CREATE TABLE IF NOT EXISTS conversation_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation TEXT NOT NULL,
  said TEXT NOT NULL,
  answered TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS conversation_turns_recent ON conversation_turns(user_id, conversation, id);
