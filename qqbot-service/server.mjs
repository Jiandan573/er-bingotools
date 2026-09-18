import './local-config.mjs';
import { QQEvents } from './events.mjs';
import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8787);
const HOST = String(process.env.HOST || '0.0.0.0');
const QQ_APP_ID = String(process.env.QQ_APP_ID || '').trim();
const QQ_APP_SECRET = String(process.env.QQ_APP_SECRET || '').trim();
const QQ_GROUP_OPENID = String(process.env.QQ_GROUP_OPENID || '').trim();
const BOT_CLIENT_KEY = String(process.env.BOT_CLIENT_KEY || '');
const QQ_API_BASE = String(process.env.QQ_API_BASE || 'https://api.sgroup.qq.com').replace(/\/+$/, '');
const QQ_TOKEN_URL = String(process.env.QQ_TOKEN_URL || 'https://bots.qq.com/app/getAppAccessToken');
const DATABASE_URL = String(
  process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL || ''
).trim();

let pool = null;
let databaseReady = false;
let cachedAccessToken = '';
let accessTokenExpiresAt = 0;
const recentDeliveries = new Map();
let tokenRequest;
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ||
  'http://localhost:8000,http://127.0.0.1:8000,http://localhost:8787,http://127.0.0.1:8787').split(',').map(s => s.trim()).filter(Boolean));
let sendWindowStarted = Date.now();
let sendsInWindow = 0;

function reserveSendSlot() {
  if (Date.now() - sendWindowStarted >= 60000) {
    sendWindowStarted = Date.now();
    sendsInWindow = 0;
  }
  if (sendsInWindow >= 12) throw fail('群播报过于频繁，请一分钟后重试（所有使用者合计每分钟最多 12 次）', 429);
  sendsInWindow++;
}

const qqEvents = new QQEvents({
  connectInfo: async () => {
    const token = await getAccessToken();
    const gateway = await fetchJson(`${QQ_API_BASE}/gateway`, {
      headers: { Authorization: `QQBot ${token}`, 'X-Union-Appid': QQ_APP_ID }
    }, 'QQ gateway');
    return { url: gateway.url, token };
  },
  log: message => console.log(safeError(message))
});

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

function jsonResponse(res, status, payload) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

function setCorsHeaders(req, res) {
  const origin = String(req.headers.origin || '');
  if (origin && allowedOrigins.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendError(res, status, message, details = {}) {
  jsonResponse(res, status, { ok: false, error: safeError(message), ...details });
}

function safeError(value) {
  let result = String(value || 'request failed');
  for (const secret of [QQ_APP_SECRET, BOT_CLIENT_KEY, cachedAccessToken, DATABASE_URL]) {
    if (secret) result = result.split(secret).join('[redacted]');
  }
  return result.slice(0, 500);
}

function fail(message, status = 400, uncertain = false) {
  return Object.assign(new Error(message), { status, uncertain });
}

function isAuthorized(req) {
  const header = String(req.headers.authorization || '');
  const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!supplied || !BOT_CLIENT_KEY) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(BOT_CLIENT_KEY);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) {
      throw fail('request body is too large', 413);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('request body must be valid JSON');
  }
}

async function fetchJson(url, options = {}, label = 'request', sending = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw fail(`${label}: invalid JSON response (${response.status})`, 502, sending);
    }
    if (!data || typeof data !== 'object') throw fail(`${label}: invalid response`, 502, sending);
    if (!response.ok || (data.code !== undefined && String(data.code) !== '0')) {
      const detail = data.message || data.msg || response.statusText;
      throw fail(`${label} failed (HTTP ${response.status}, code ${data.code ?? '-'}): ${detail}`,
        502, sending && response.status >= 500);
    }
    return data;
  } catch (error) {
    if (error.status) throw error;
    throw fail(`${label}: ${error.name === 'AbortError' ? 'request timed out' : 'network failure'}`, 502, sending);
  } finally {
    clearTimeout(timeout);
  }
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < accessTokenExpiresAt) {
    return cachedAccessToken;
  }
  if (!QQ_APP_ID || !QQ_APP_SECRET) {
    throw fail('QQ_APP_ID and QQ_APP_SECRET are not configured', 503);
  }
  if (tokenRequest) return tokenRequest;
  tokenRequest = (async () => {
  const data = await fetchJson(
    QQ_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: QQ_APP_ID,
        clientSecret: QQ_APP_SECRET
      })
    },
    'QQ access token request'
  );

  const token = String(data.access_token || '').trim();
  const expiresIn = Number(data.expires_in);
  if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) throw fail('QQ token response is invalid', 502);

  cachedAccessToken = token;
  accessTokenExpiresAt = Date.now() + Math.max(0, expiresIn - Math.min(120, expiresIn * 0.1)) * 1000;
  return cachedAccessToken;
  })();
  try { return await tokenRequest; } finally { tokenRequest = null; }
}

async function sendGroupMessage(content) {
  if (!QQ_GROUP_OPENID) {
    throw fail('QQ_GROUP_OPENID is not configured', 503);
  }
  reserveSendSlot();
  const accessToken = await getAccessToken();
  const result = await fetchJson(
    `${QQ_API_BASE}/v2/groups/${encodeURIComponent(QQ_GROUP_OPENID)}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `QQBot ${accessToken}`,
        'X-Union-Appid': QQ_APP_ID,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content,
        msg_type: 0
      })
    },
    'QQ 主动群消息（不依赖 @ 或回复上下文）', true
  );
  if (!result.id && !result.message_id) throw fail('QQ response has no message ID; delivery is uncertain', 502, true);
  return result;
}

function cleanText(value, fallback = '') {
  if (value != null && typeof value !== 'string') throw fail('text fields must be strings');
  const text = (value || '').trim();
  if (text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) throw fail('text field is too long or contains control characters');
  return text || fallback;
}

function normalizeParticipant(value) {
  const participant = value && typeof value === 'object' ? value : {};
  return {
    name: cleanText(participant.name, '未命名'),
    platform: cleanText(participant.platform, '未知平台'),
    room: cleanText(participant.room, '未设置'),
    title: cleanText(participant.title)
  };
}

export function validateMatchPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('request must be an object');
  const payload = body && typeof body === 'object' ? body : {};
  const referee = payload.referee && typeof payload.referee === 'object'
    ? payload.referee
    : {};
  const room = cleanText(referee.room);
  const title = cleanText(referee.title);
  if (!room) throw new Error('referee.room is required');
  if (!title) throw new Error('referee.title is required');

  const startedAt = cleanText(payload.started_at, new Date().toISOString());
  const startedDate = new Date(startedAt);
  if (Number.isNaN(startedDate.getTime())) {
    throw new Error('started_at must be a valid date');
  }

  return {
    started_at: startedDate.toISOString(),
    referee: { room, title, platform: cleanText(referee.platform, 'bilibili') },
    left: normalizeParticipant(payload.left),
    right: normalizeParticipant(payload.right)
  };
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date).replace(/\//g, '-');
}

export function liveRoomAddress(platform, room) {
  if (platform === 'local') return '本地采集（无直播间地址）';
  if (!room || room === '未设置') return '未设置';
  if (/^https?:\/\//i.test(room)) {
    const url = new URL(room);
    if (url.username || url.password) throw fail('直播间地址不能包含账号密码');
    return url.href;
  }
  if (platform === 'bilibili' && /^\d+$/.test(room)) return `https://live.bilibili.com/${room}`;
  if (platform === 'douyin' && /^[a-zA-Z0-9_-]+$/.test(room)) return `https://live.douyin.com/${room}`;
  throw fail('请填写完整的直播间 http/https 地址，或选择正确平台并填写房间号');
}

export function formatMatchMessage(match, { test = false } = {}) {
  const participantLines = (label, participant) => [
    `${label}：${participant.name}`,
    `直播间：${liveRoomAddress(participant.platform, participant.room)}`
  ];

  return [
    test ? '🎮 Bingo 比赛播报（测试）' : '🎮 Bingo 比赛开始',
    `比赛时间：${formatDateTime(match.started_at)}（北京时间）`,
    '',
    `裁判直播间：${liveRoomAddress(match.referee.platform || 'bilibili', match.referee.room)}`,
    '',
    ...participantLines('红方', match.left),
    '',
    ...participantLines('蓝方', match.right)
  ].join('\n');
}

// Reserve the request before sending. A pending/unknown record is never sent again
// automatically: QQ may already have accepted it before a network interruption.
async function deliverMatch(key, fingerprint, match, message) {
  if ((DATABASE_URL && !databaseReady) || (!DATABASE_URL && process.env.RENDER)) {
    throw fail('比赛记录数据库未就绪；尚未向 QQ 发送', 503);
  }
  if (pool) {
    let row;
    try {
      const inserted = await pool.query(
        `INSERT INTO bingotools_match_events
         (started_at, referee, left_player, right_player, message_content,
          delivery_status, idempotency_key, payload_hash)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [match.started_at, match.referee, match.left, match.right, message, key, fingerprint]);
      if (!inserted.rowCount) {
        row = (await pool.query('SELECT * FROM bingotools_match_events WHERE idempotency_key = $1', [key])).rows[0];
        if (row.payload_hash !== fingerprint) throw fail('同一次请求的比赛内容发生变化', 409);
        if (row.delivery_status === 'sent') return { ok: true, duplicate: true, qq_message_id: row.qq_message_id, storage: { saved: true } };
        if (row.delivery_status === 'failed') return { ok: false, error: row.error, retryable: true, storage: { saved: true } };
        throw fail('此请求正在处理或发送结果未知，请先查看 QQ 群，勿重复播报', 409, true);
      }
    } catch (error) {
      if (error.status) throw error;
      throw fail('数据库记录失败；尚未向 QQ 发送', 503);
    }
  }
  let result;
  try {
    const qq = await sendGroupMessage(message);
    result = { ok: true, qq_message_id: String(qq.id || qq.message_id) };
  } catch (error) {
    result = { ok: false, error: safeError(error.message), uncertain: Boolean(error.uncertain), retryable: !error.uncertain };
  }
  result.storage = { saved: false, reason: '本地测试未配置数据库，记录不会持久保存' };
  if (pool) {
    try {
      await pool.query(
        `UPDATE bingotools_match_events SET delivery_status = $2, qq_message_id = $3, error = $4
         WHERE idempotency_key = $1`,
        [key, result.ok ? 'sent' : result.uncertain ? 'unknown' : 'failed', result.qq_message_id || null, result.error || null]);
      result.storage = { saved: true };
    } catch {
      result.storage = { saved: false, reason: '比赛已登记，但发送结果写入失败；请核对 QQ 群' };
    }
  }
  return result;
}

async function handleTestMessage(req, res) {
  const match = validateMatchPayload(await readJsonBody(req));
  const content = formatMatchMessage(match, { test: true });
  const result = await sendGroupMessage(content);
  jsonResponse(res, 200, {
    ok: true,
    message: 'QQ 机器人连接成功',
    qq: result
  });
}

async function handleMatchStart(req, res) {
  const match = validateMatchPayload(await readJsonBody(req));
  const key = String(req.headers['idempotency-key'] || '').trim();
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key)) throw fail('需要有效的 Idempotency-Key');
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(match)).digest('hex');
  // Shared promise prevents simultaneous requests from both sending.
  for (const [oldKey, entry] of recentDeliveries) {
    if (entry.finished && Date.now() - entry.created > 24 * 3600 * 1000) recentDeliveries.delete(oldKey);
  }
  let entry = recentDeliveries.get(key);
  if (entry && entry.fingerprint !== fingerprint) throw fail('同一次请求的比赛内容发生变化', 409);
  const duplicate = Boolean(entry);
  if (!entry) {
    if (recentDeliveries.size >= 2000) throw fail('服务请求记录已满，请稍后再试', 429);
    entry = { fingerprint, created: Date.now(), finished: false };
    entry.promise = deliverMatch(key, fingerprint, match, formatMatchMessage(match));
    recentDeliveries.set(key, entry);
    entry.promise.then(() => { entry.finished = true; }, () => { recentDeliveries.delete(key); });
  }
  const result = await entry.promise;
  if (duplicate && result.ok) result.duplicate = true;
  jsonResponse(res, result.ok ? 200 : 502, result);
}

async function initDatabase() {
  if (!DATABASE_URL) return;
  try {
    const { Pool } = await import('pg');
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: true, ...(process.env.SUPABASE_CA_CERT ? { ca: process.env.SUPABASE_CA_CERT.replace(/\\n/g, '\n') } : {}) },
      connectionTimeoutMillis: 10000,
      query_timeout: 10000,
      max: 3
    });
  } catch (error) {
    console.error('[database] dependency initialization failed');
    return;
  }
  try {
    await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    await pool.query('ALTER TABLE bingotools_match_events ADD COLUMN IF NOT EXISTS idempotency_key TEXT');
    await pool.query('ALTER TABLE bingotools_match_events ADD COLUMN IF NOT EXISTS payload_hash TEXT');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS bingotools_match_events_idempotency_key_idx ON bingotools_match_events (idempotency_key) WHERE idempotency_key IS NOT NULL');
    databaseReady = true;
    console.log('[database] ready');
  } catch (error) {
    databaseReady = false;
    console.error('[database] initialization failed; check connection, TLS certificate and schema permissions');
  }
}

async function handleRequest(req, res) {
  setCorsHeaders(req, res);
  if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) {
    sendError(res, 403, '网页来源未获允许；请使用本地 HTTP 调试网页，或由管理员配置 ALLOWED_ORIGINS');
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = requestUrl.pathname;

  if (req.method === 'GET' && path === '/') {
    // Render 仅提供 API。HTML 保留在本地，未来由 exe 调用同一接口。
    jsonResponse(res, 200, {
      ok: true, service: 'bingotools-qqbot-service', mode: 'api-only', health: '/health'
    });
    return;
  }

  if (req.method === 'GET' && path === '/health') {
    jsonResponse(res, 200, {
      ok: true,
      service: 'bingotools-qqbot-service',
      database: DATABASE_URL ? (databaseReady ? 'ready' : 'error') : 'disabled',
      qq_configured: Boolean(QQ_APP_ID && QQ_APP_SECRET && QQ_GROUP_OPENID)
    });
    return;
  }

  if (!BOT_CLIENT_KEY) {
    sendError(res, 503, '服务端尚未配置 BOT_CLIENT_KEY');
    return;
  }
  if (!isAuthorized(req)) {
    sendError(res, 401, 'invalid client key');
    return;
  }

  try {
    if (req.method === 'GET' && path === '/api/v1/qq/status') {
      jsonResponse(res, 200, { ok: true, events: qqEvents.status(), target_group_configured: Boolean(QQ_GROUP_OPENID) });
      return;
    }
    if (req.method === 'GET' && path === '/api/v1/qq/groups') {
      jsonResponse(res, 200, { ok: true, groups: qqEvents.listGroups() });
      return;
    }
    if (req.method === 'POST' && path === '/api/v1/qq/test') {
      await handleTestMessage(req, res);
      return;
    }
    if (req.method === 'POST' && path === '/api/v1/matches/start') {
      await handleMatchStart(req, res);
      return;
    }
    sendError(res, 404, 'not found');
  } catch (error) {
    sendError(res, error.status || 400, error.message || 'request failed', { uncertain: Boolean(error.uncertain) });
  }
}

export function createServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error('[server] unhandled request error:', error);
      if (!res.headersSent) sendError(res, 500, 'internal server error');
      else res.end();
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await initDatabase();
  const server = createServer();
  server.on('error', error => { console.error('Server could not listen:', error.code); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    qqEvents.stop();
    server.close(async () => { await pool?.end(); process.exit(0); });
    setTimeout(() => process.exit(1), 5000).unref();
  });
  server.listen(PORT, HOST, () => {
    console.log(`QQ bot service listening on http://${HOST}:${PORT}`);
    if (process.env.QQ_EVENTS_ENABLED === 'true') {
      if (QQ_APP_ID && QQ_APP_SECRET && BOT_CLIENT_KEY) qqEvents.start();
      else console.log('[qq-events] 未启动：请先填写 AppID、AppSecret 和 BOT_CLIENT_KEY');
    }
  });
}
