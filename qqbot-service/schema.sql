CREATE TABLE IF NOT EXISTS bingotools_match_events (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  referee JSONB NOT NULL,
  left_player JSONB NOT NULL,
  right_player JSONB NOT NULL,
  message_content TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  qq_message_id TEXT,
  error TEXT,
  idempotency_key TEXT UNIQUE,
  payload_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- 浏览器不直接访问比赛表；由服务器数据库连接写入。
ALTER TABLE bingotools_match_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS bingotools_live_matches (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL
);
ALTER TABLE bingotools_live_matches ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS bingotools_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- v2 room state. Tokens are stored only as SHA-256 hashes; room and board
-- payloads remain JSONB while fields used for CAS and elapsed time are columns.
CREATE TABLE IF NOT EXISTS bingotools_sessions (
  token_hash TEXT PRIMARY KEY,
  stable_id TEXT NOT NULL UNIQUE,
  expires_at_ms BIGINT NOT NULL,
  dev_until_ms BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bingotools_rooms (
  id TEXT PRIMARY KEY,
  host_session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  match JSONB NOT NULL,
  board JSONB NOT NULL,
  scores JSONB NOT NULL,
  elapsed_seconds BIGINT NOT NULL DEFAULT 0,
  running_since_ms BIGINT,
  started_at_ms BIGINT,
  countdown_seconds INTEGER NOT NULL DEFAULT 0,
  countdown_end_ms BIGINT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  records JSONB NOT NULL DEFAULT '[]'::jsonb,
  remounts JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS bingotools_rooms_state_updated_idx ON bingotools_rooms (state, updated_at_ms);
CREATE TABLE IF NOT EXISTS bingotools_room_members (
  room_id TEXT NOT NULL REFERENCES bingotools_rooms(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  name TEXT NOT NULL,
  seen_at_ms BIGINT NOT NULL,
  PRIMARY KEY (room_id, member_id)
);
CREATE TABLE IF NOT EXISTS bingotools_room_notifications (
  room_id TEXT NOT NULL REFERENCES bingotools_rooms(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (room_id, kind)
);
CREATE TABLE IF NOT EXISTS bingotools_roster (
  roster_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  source TEXT NOT NULL,
  room TEXT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS bingotools_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  interval_minutes INTEGER NOT NULL DEFAULT 5
);
CREATE TABLE IF NOT EXISTS bingotools_idempotency (
  session_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  room_id TEXT,
  PRIMARY KEY (session_hash, action, request_id)
);
