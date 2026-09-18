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
