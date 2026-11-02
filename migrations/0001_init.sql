-- SplitApp: Grundschema (Cloudflare D1 / SQLite)

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CHF',
  invite_token TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- user_id ist NULL, solange niemand dieses Mitglied (Platzhalter) übernommen hat.
CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (group_id, user_id)
);
CREATE INDEX members_user ON members(user_id);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','payment')),
  description TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  date TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  notes TEXT,
  split_type TEXT NOT NULL DEFAULT 'equal',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_via TEXT NOT NULL DEFAULT 'web',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT,
  deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TEXT
);
CREATE INDEX expenses_group ON expenses(group_id, date DESC, id DESC);

CREATE TABLE expense_payers (
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id),
  amount INTEGER NOT NULL,
  PRIMARY KEY (expense_id, member_id)
);
CREATE INDEX expense_payers_member ON expense_payers(member_id);

CREATE TABLE expense_shares (
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id),
  amount INTEGER NOT NULL,
  value REAL,
  PRIMARY KEY (expense_id, member_id)
);
CREATE INDEX expense_shares_member ON expense_shares(member_id);

CREATE TABLE activity (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  via TEXT NOT NULL,
  action TEXT NOT NULL,
  expense_id INTEGER,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX activity_group ON activity(group_id, id DESC);
