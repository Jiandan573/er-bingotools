import crypto from 'node:crypto';

const error = (message, status = 400) => Object.assign(new Error(message), { status });
export function scores(value) {
  if (!value || !Number.isFinite(value.red) || !Number.isFinite(value.blue) ||
      Math.abs(value.red) > 1000000 || Math.abs(value.blue) > 1000000) throw error('红蓝方比分无效');
  return { red: value.red, blue: value.blue };
}
export class Matches {
  constructor({ pool, requireDatabase, send, normalize, formatStart, address, cleanError }) {
    Object.assign(this, { pool, requireDatabase, send, normalize, formatStart, address, cleanError });
    this.memory = new Map();
    this.locks = new Map();
  }
  async locked(id, fn) {
    const before = this.locks.get(id) || Promise.resolve();
    const next = before.catch(() => {}).then(fn);
    this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  db() {
    const db = this.pool();
    if (this.requireDatabase() && !db) throw error('比赛记录数据库未就绪；尚未向 QQ 发送', 503);
    return db;
  }
  async get(id) {
    const db = this.db();
    return db ? (await db.query('SELECT data FROM bingotools_live_matches WHERE id=$1', [id])).rows[0]?.data : this.memory.get(id);
  }
  async insert(row) {
    const db = this.db();
    if (db) return Boolean((await db.query('INSERT INTO bingotools_live_matches(id,data) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id', [row.id, row])).rowCount);
    if (this.memory.has(row.id)) return false;
    if (this.memory.size >= 2000) throw error('本地比赛记录已满', 503);
    this.memory.set(row.id, structuredClone(row)); return true;
  }
  async save(row) {
    const db = this.db();
    if (db) await db.query('UPDATE bingotools_live_matches SET data=$2 WHERE id=$1', [row.id, row]);
    else this.memory.set(row.id, structuredClone(row));
  }
  checkId(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw error('比赛请求标识无效');
    return id;
  }
  async notify(row, field, text) {
    // 先持久登记发送，再请求 QQ。发送结果未知时不得自动重复发送。
    row[field] = 'pending'; await this.save(row);
    try { await this.send(text); row[field] = 'sent'; }
    catch (e) { row[field] = e.uncertain ? 'unknown' : 'failed'; row.error = this.cleanError(e.message); }
    try { await this.save(row); }
    catch { throw error('发送结果记录失败，请先核对 QQ 群，不要重复播报', 503); }
    return row[field] === 'sent' ? { ok: true, match_id: row.id } :
      { ok: false, match_id: row.id, error: row.error, uncertain: row[field] === 'unknown' };
  }
  async start(id, body) {
    this.checkId(id);
    const match = this.normalize(body);
    const score = scores(body.scores);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ match, score })).digest('hex');
    return this.locked(id, async () => {
      let row = { id, match, scores: score, revision: 0, state: 'active', updated_at: new Date().toISOString(), fingerprint, start_delivery: 'pending' };
      // 校验链接须在写入前完成。
      const text = this.formatStart(match);
      if (!await this.insert(row)) {
        row = await this.get(id);
        if (row.fingerprint !== fingerprint) throw error('同一次开始请求内容发生变化', 409);
        if (row.start_delivery === 'sent') return { ok: true, match_id: id, duplicate: true };
        if (row.start_delivery === 'failed') return this.notify(row, 'start_delivery', text);
        throw error('开始播报尚未确认成功，请核对 QQ 群及服务记录；不会自动重复发送', 409);
      }
      return this.notify(row, 'start_delivery', text);
    });
  }
  async update(body, finish = false) {
    const id = this.checkId(body.match_id);
    const score = scores(body.scores);
    if (!Number.isSafeInteger(body.revision) || body.revision < 1) throw error('比分版本无效');
    return this.locked(id, async () => {
      const row = await this.get(id);
      if (!row || row.start_delivery !== 'sent') throw error('未找到已成功开始的比赛', 404);
      if (row.state === 'ended') {
        if (!finish) throw error('比赛已结束，不再更新比分', 409);
        if (row.scores.red !== score.red || row.scores.blue !== score.blue) throw error('最终比分已锁定', 409);
        if (row.end_delivery === 'sent') return { ok: true, duplicate: true, match_id: id };
        if (row.end_delivery === 'failed') return this.notify(row, 'end_delivery', this.summary(row, true));
        throw error('比赛已结束，结束通知尚未确认送达，请核对 QQ 群；不会重复发送', 409);
      }
      if (body.revision <= row.revision) {
        if (finish) throw error('比分版本过期，请刷新状态后重试', 409);
        return { ok: true, stale: true };
      }
      row.scores = score; row.revision = body.revision; row.updated_at = new Date().toISOString();
      if (!finish) { await this.save(row); return { ok: true }; }
      row.state = 'ended'; row.ended_at = row.updated_at;
      return this.notify(row, 'end_delivery', this.summary(row, true));
    });
  }
  summary(row, ended = false) {
    const m = row.match;
    return [ended ? '🏁 Bingo 比赛结束' : '🎮 正在进行的 Bingo 比赛',
      `裁判：${m.referee.title}`,
      `裁判直播间：${this.address(m.referee.platform || 'bilibili', m.referee.room)}`,
      `${ended ? '最终得分' : '当前比分'}：`,
      `红方 ${m.left.name}：${row.scores.red} 分`,
      `蓝方 ${m.right.name}：${row.scores.blue} 分`,
      `比分同步时间：${new Date(row.updated_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`
    ].join('\n');
  }
  async current() {
    const db = this.db();
    const rows = db ? (await db.query("SELECT data FROM bingotools_live_matches WHERE data->>'state'='active' AND data->>'start_delivery'='sent' ORDER BY data->>'updated_at' DESC LIMIT 11")).rows.map(r => r.data) :
      [...this.memory.values()].filter(r => r.state === 'active' && r.start_delivery === 'sent');
    if (!rows.length) return '目前没有正在进行的比赛。';
    let result = '';
    for (const row of rows.slice(0, 10)) {
      const text = this.summary(row);
      if (result.length + text.length > 3500) { result += '\n\n其余比赛暂未展示。'; break; }
      result += (result ? '\n\n' : '') + text;
    }
    return result + (rows.length > 10 ? '\n\n其余比赛暂未展示。' : '');
  }
}
