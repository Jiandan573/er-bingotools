import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const clone = value => structuredClone(value);
const text = (value, max = 100) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw fail('文字内容无效');
  return value.trim();
};
const same = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// All QQ producers share this bounded queue; uncertain sends are never retried here.
export class NotificationQueue {
  constructor(send, { interval = 5100, limit = 100 } = {}) {
    this.send = send; this.interval = interval; this.limit = limit;
    this.pending = 0; this.tail = Promise.resolve(); this.last = 0;
  }
  enqueue(...args) {
    if (this.pending >= this.limit) return Promise.reject(fail('群通知队列已满，请稍后重试', 429));
    this.pending++;
    const task = this.tail.then(async () => {
      const delay = this.last + this.interval - Date.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      this.last = Date.now();
      return this.send(...args);
    });
    this.tail = task.catch(() => {}).finally(() => { this.pending--; });
    return task;
  }
}

export class Rooms {
  constructor({ send, normalize, formatStart, address, cleanError = String, devCode = '', now = Date.now }) {
    Object.assign(this, { send, normalize, formatStart, address, cleanError, devCode, now });
    this.instance = randomUUID(); this.sessions = new Map(); this.rooms = new Map();
    this.rates = new Map(); this.settings = { enabled: false, interval: 5 };
    this.lastSummary = 0; this.summaryPending = false;
  }
  rate(key, max, window = 60000) {
    const now = this.now();
    let row = this.rates.get(key);
    if (!row || row.until <= now) { row = { count: 0, until: now + window }; this.rates.set(key, row); }
    if (++row.count > max) throw fail('请求过于频繁，请稍后重试', 429);
  }
  sweep() {
    for (const [key, row] of this.rates) if (row.until <= this.now()) this.rates.delete(key);
    for (const [key, session] of this.sessions) if (session.expires <= this.now()) this.sessions.delete(key);
  }
  session(token) {
    const s = this.sessions.get(token);
    if (!s || s.expires <= this.now()) throw fail('会话失效或服务器已重启，请重新连接', 401);
    s.expires = this.now() + 30 * 86400000;
    return s;
  }
  admin(s) { return s.devUntil > this.now(); }
  host(s, r) {
    if (r.host !== s.id && !this.admin(s)) throw fail('只有本场裁判可以操作', 403);
  }
  revision(r, body) {
    if (!Number.isSafeInteger(body.revision) || body.revision !== r.rev) throw fail('房间已更新，请刷新后重试', 409);
  }
  room(id) {
    const r = this.rooms.get(id);
    if (!r) throw fail('房间已不存在，可能因服务器重启而清空', 404);
    return r;
  }
  oneHost(s) {
    if ([...this.rooms.values()].some(r => r.host === s.id && !['ended', 'mounted'].includes(r.state)))
      throw fail('你已有未结束的房间，请先结束或挂载', 409);
  }
  board(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 120000) throw fail('棋盘数据无效');
    for (const key of ['red', 'blue', 'first', 'marks', 'redTime', 'blueTime'])
      if (!Array.isArray(value[key]) || value[key].length !== 25) throw fail('棋盘必须包含 25 格');
    const out = {};
    for (const key of ['red', 'blue']) out[key] = value[key].map(Boolean);
    out.first = value.first.map(v => ['R', 'B'].includes(v) ? v : null);
    out.marks = value.marks.map(v => {
      if (!Array.isArray(v) || v.length > 30 || v.some(x => typeof x !== 'string' || x.length > 200)) throw fail('标记内容无效');
      return [...v];
    });
    for (const key of ['redTime', 'blueTime']) out[key] = value[key].map(v => this.number(v));
    for (const key of ['settle1', 'settle2', 'extra1', 'extra2']) out[key] = this.number(value[key] || 0);
    out.settleHistory = Array.isArray(value.settleHistory) ? clone(value.settleHistory).slice(-100) : [];
    out.cellTexts = Array.isArray(value.cellTexts) && value.cellTexts.length === 25
      ? value.cellTexts.map(v => String(v).slice(0, 2000)) : null;
    out.redName = text(value.redName || '红方'); out.blueName = text(value.blueName || '蓝方');
    out.scoring = {};
    for (const key of ['maxTasksPerLine', 'halfScoreForLate', 'allowLateFill', 'bingoScore', 'bingoScoreRest',
      'maxBingoCountRed', 'maxBingoCountBlue', 'maxGlobalSettleCount', 'maxSettleCount', 'settleScorePerTime', 'settleScoreRest']) {
      if (value.scoring?.[key] !== undefined) {
        const n = value.scoring[key];
        if (!Number.isInteger(n) || n < 0 || n > 1000) throw fail('计分设置无效');
        out.scoring[key] = n;
      }
    }
    if (value.scoring?.rowScores !== undefined) {
      const rows = value.scoring.rowScores;
      if (!Array.isArray(rows) || rows.length !== 5 || rows.some(v => !Number.isInteger(v) || v < 0 || v > 1000)) throw fail('行分设置无效');
      out.scoring.rowScores = [...rows];
    }
    return out;
  }
  number(v) {
    if (!Number.isFinite(v) || Math.abs(v) > 1e15) throw fail('数值无效');
    return v;
  }
  scores(v) {
    if (!v || !Number.isFinite(v.red) || !Number.isFinite(v.blue) || Math.max(Math.abs(v.red), Math.abs(v.blue)) > 1e6) throw fail('比分无效');
    return { red: v.red, blue: v.blue };
  }
  elapsed(r) { return r.elapsed + (r.state === 'playing' ? Math.max(0, Math.floor((this.now() - r.anchor) / 1000)) : 0); }
  view(r, s, detailed = true) {
    const { host, ...data } = r;
    const view = clone(data);
    view.isHost = host === s.id; view.canControl = view.isHost || this.admin(s);
    view.members = r.members.map(m => ({ ...m, online: this.now() - m.seen < 30000, isSelf: m.id === s.id }));
    view.elapsed_seconds = this.elapsed(r);
    if (!detailed) delete view.board;
    return view;
  }
  changed(r) { r.rev++; r.updatedAt = this.now(); }
  capacity() {
    while (this.rooms.size >= 2000) {
      const old = [...this.rooms.values()].filter(r => r.state === 'ended').sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!old) throw fail('房间容量已满，请稍后重试', 503);
      this.rooms.delete(old.id);
    }
  }
  summary(r, ended = false) {
    const m = r.match, sec = this.elapsed(r);
    return [
      ended ? '🏁 Bingo 比赛结束' : '🎮 正在进行的 Bingo 比赛',
      `裁判：${m.referee.title}`, `裁判直播间：${this.address(m.referee.platform, m.referee.room)}`,
      `红方 ${m.left.name}：${r.scores.red} 分`, `蓝方 ${m.right.name}：${r.scores.blue} 分`,
      `${ended ? '比赛用时' : '比赛已进行'}：${Math.floor(sec / 3600)}小时${Math.floor(sec / 60) % 60}分${sec % 60}秒`,
      `比分同步时间：${new Date(r.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`
    ].join('\n');
  }
  current() {
    const active = [...this.rooms.values()].filter(r => r.state === 'playing');
    if (!active.length) return '';
    let result = '';
    for (const r of active) {
      const part = this.summary(r);
      if ((result + part).length > 3400) { result += '\n\n其余比赛暂未展示。'; break; }
      result += (result ? '\n\n' : '') + part;
    }
    return result;
  }
  notify(r, kind) {
    if (r.delivery[kind] && r.delivery[kind].status !== 'failed') return;
    const state = { status: 'pending', error: '' };
    r.delivery[kind] = state;
    const content = kind === 'start' ? this.formatStart(r.match) : this.summary(r, true);
    Promise.resolve().then(() => this.send(content)).then(() => { state.status = 'sent'; }, error => {
      state.status = error.uncertain ? 'unknown' : 'failed';
      state.error = this.cleanError(error.message);
    });
  }
  tick() {
    this.sweep();
    for (const r of this.rooms.values()) {
      if (r.state === 'countdown' && r.countdownEnd <= this.now()) {
        r.state = 'playing'; r.anchor = r.countdownEnd; r.startedAt = r.anchor;
        r.match.started_at = new Date(r.startedAt).toISOString();
        this.changed(r); this.notify(r, 'start');
      }
    }
    if (this.settings.enabled && !this.summaryPending && this.now() - this.lastSummary >= this.settings.interval * 60000) {
      this.lastSummary = this.now();
      const content = this.current();
      if (content) {
        this.summaryPending = true;
        Promise.resolve().then(() => this.send(content)).catch(e => { this.settings.lastError = this.cleanError(e.message); })
          .finally(() => { this.summaryPending = false; });
      }
    }
  }
  handle(path, body = {}, token = '', ip = 'unknown') {
    this.tick();
    if (path === '/session') {
      this.rate('session:' + ip, 30);
      if (this.sessions.size >= 10000) throw fail('会话容量已满', 503);
      const key = randomBytes(32).toString('hex');
      this.sessions.set(key, { id: randomUUID(), devUntil: 0, expires: this.now() + 30 * 86400000, creates: new Map() });
      return { token: key };
    }
    const s = this.session(token);
    this.rate('request:' + s.id, 240);
    if (path === '/dev-auth') {
      this.rate('dev:' + ip, 5);
      if (!this.devCode) throw fail('服务端未设置开发者识别码', 503);
      if (typeof body.code !== 'string' || !same(body.code, this.devCode)) throw fail('识别码错误', 403);
      s.devUntil = this.now() + 8 * 3600000; return { expiresAt: s.devUntil };
    }
    if (path === '/dev/logout') { s.devUntil = 0; return {}; }
    if (path === '/dev/settings') {
      if (!this.admin(s)) throw fail('需要开发者权限', 403);
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean' || !Number.isInteger(body.interval) || body.interval < 5 || body.interval > 1440) throw fail('播报间隔须为 5–1440 分钟');
        this.settings = { enabled: body.enabled, interval: body.interval };
        this.lastSummary = this.now();
      }
      return { settings: clone(this.settings) };
    }
    if (path === '/list') return { rooms: [...this.rooms.values()].map(r => this.view(r, s, false)), developer: this.admin(s) };
    if (path === '/create') {
      const requestKey = body.request_id === undefined ? '' : text(body.request_id);
      const fingerprint = createHash('sha256').update(JSON.stringify({ match: body.match, board: body.board, scores: body.scores })).digest('hex');
      if (requestKey && s.creates.has(requestKey)) {
        const old = s.creates.get(requestKey);
        if (old.fingerprint !== fingerprint) throw fail('同一次创建请求内容发生变化', 409);
        return { room: this.view(this.room(old.id), s) };
      }
      this.oneHost(s); this.rate('create:' + ip, 5); this.capacity();
      const match = this.normalize(body.match);
      this.formatStart(match); // Validate every live address before storing.
      const board = this.board(body.board), scores = this.scores(body.scores);
      const id = randomBytes(8).toString('hex');
      const r = { id, host: s.id, match, board, scores, state: 'waiting', rev: 1, elapsed: 0, anchor: 0,
        startedAt: 0, countdown: 5, countdownEnd: 0, createdAt: this.now(), updatedAt: this.now(),
        members: [{ id: s.id, name: match.referee.title, seen: this.now() }], delivery: {}, records: [], remounts: {} };
      this.rooms.set(id, r);
      if (requestKey) {
        s.creates.set(requestKey, { id, fingerprint });
        if (s.creates.size > 100) s.creates.delete(s.creates.keys().next().value);
      }
      return { room: this.view(r, s) };
    }
    const r = this.room(body.id);
    if (path === '/get') return { room: this.view(r, s) };
    if (path === '/join') {
      if (['mounted', 'ended'].includes(r.state)) throw fail('该房间当前不能加入', 409);
      if (!r.members.some(m => m.id === s.id)) {
        if (r.members.length >= 10) throw fail('房间已满（10/10）', 409);
        r.members.push({ id: s.id, name: text(body.name || '观众'), seen: this.now() });
      }
      return { room: this.view(r, s) };
    }
    if (path === '/heartbeat') {
      const m = r.members.find(m => m.id === s.id);
      if (!m) throw fail('你已离开或被移出房间', 403);
      m.seen = this.now(); return { room: this.view(r, s) };
    }
    if (path === '/leave') {
      if (r.host === s.id && !['ended', 'mounted'].includes(r.state)) throw fail('裁判请先结束或挂载比赛', 409);
      r.members = r.members.filter(m => m.id !== s.id); return {};
    }
    if (path === '/takeover') {
      if (r.state !== 'mounted') throw fail('比赛已被接管或不在挂载状态', 409);
      this.revision(r, body); this.oneHost(s);
      const referee = this.normalize({ ...r.match, referee: body.referee }).referee;
      this.address(referee.platform, referee.room);
      r.host = s.id; r.match.referee = referee; r.members = [{ id: s.id, name: referee.title, seen: this.now() }];
      r.state = r.startedAt ? 'playing' : 'waiting'; r.anchor = this.now();
      r.records.push({ action: 'takeover', referee: referee.title, at: this.now() }); this.changed(r);
      return { room: this.view(r, s) };
    }
    this.host(s, r);
    if (path === '/remount') {
      if (r.state !== 'ended') throw fail('只有已结束比赛可以重新挂载', 409);
      const key = text(body.request_id);
      if (r.remounts[key]) return { room: this.view(this.room(r.remounts[key]), s) };
      this.rate('create:' + ip, 5); this.capacity();
      const copy = clone(r);
      copy.id = randomBytes(8).toString('hex'); copy.state = 'mounted'; copy.rev = 1;
      copy.elapsed = 0; copy.anchor = 0; copy.startedAt = 0; copy.countdownEnd = 0;
      copy.delivery = {}; copy.members = []; copy.remounts = {}; copy.records = [{ action: 'remount', at: this.now() }];
      copy.createdAt = copy.updatedAt = this.now();
      this.rooms.set(copy.id, copy); r.remounts[key] = copy.id; this.changed(r);
      return { room: this.view(copy, s) };
    }
    if (path === '/retry') {
      const kind = body.kind;
      if (!['start', 'end'].includes(kind) || r.delivery[kind]?.status !== 'failed') throw fail('仅明确失败的通知可以重试；未知结果请先核对 QQ 群', 409);
      this.notify(r, kind); return { room: this.view(r, s) };
    }
    if (path === '/start' && ['countdown', 'playing'].includes(r.state)) return { room: this.view(r, s) };
    if (path === '/end' && r.state === 'ended') return { room: this.view(r, s) };
    this.revision(r, body);
    switch (path) {
      case '/update':
        if (!['waiting', 'playing'].includes(r.state)) throw fail('当前状态不能修改棋盘', 409);
        { const board = this.board(body.board), scores = this.scores(body.scores);
          r.board = board; r.scores = scores; }
        break;
      case '/settings':
        if (!Number.isInteger(body.countdown) || body.countdown < 0 || body.countdown > 60) throw fail('倒计时须为 0–60 秒');
        r.countdown = body.countdown; break;
      case '/kick':
        if (body.member === r.host) throw fail('不能移除裁判');
        r.members = r.members.filter(m => m.id !== body.member); break;
      case '/start':
        if (r.state !== 'waiting') throw fail('当前状态不能开始', 409);
        r.state = 'countdown'; r.countdownEnd = this.now() + r.countdown * 1000; break;
      case '/mount':
        if (!['waiting', 'playing', 'countdown'].includes(r.state)) throw fail('当前状态不能挂载', 409);
        r.elapsed = this.elapsed(r); r.state = 'mounted'; r.countdownEnd = 0;
        r.records.push({ action: 'mount', referee: r.match.referee.title, at: this.now() }); break;
      case '/end':
        if (!['waiting', 'playing', 'countdown'].includes(r.state)) throw fail('请先接管挂载比赛', 409);
        { const board = this.board(body.board), score = this.scores(body.scores);
          r.board = board; r.scores = score; }
        r.elapsed = this.elapsed(r); r.state = 'ended'; r.countdownEnd = 0;
        this.changed(r); this.notify(r, 'end'); return { room: this.view(r, s) };
      case '/delete':
        if (!this.admin(s) || r.state !== 'mounted') throw fail('仅开发者可删除挂载比赛', 403);
        this.rooms.delete(r.id); return {};
      default: throw fail('接口不存在', 404);
    }
    this.changed(r); this.tick();
    return { room: this.view(r, s) };
  }
}
