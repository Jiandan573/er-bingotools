// QQ 群事件接收；只保存群标识，不记录群成员或消息正文。
export class QQEvents {
  constructor({ connectInfo, Socket = globalThis.WebSocket, log = console.log }) {
    this.connectInfo = connectInfo;
    this.Socket = Socket;
    this.log = log;
    this.groups = new Map();
    this.state = 'disabled';
    this.lastError = '';
    this.session = '';
    this.seq = null;
    this.stopped = true;
    this.attempt = 0;
  }

  status() {
    return { state: this.state, error: this.lastError, discovered_groups: this.groups.size };
  }

  listGroups() {
    return [...this.groups.values()].map(({ group_openid, last_seen }) => ({ group_openid, last_seen }));
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.detach();
    this.state = 'stopped';
  }

  detach() {
    clearInterval(this.heartbeat);
    clearTimeout(this.deadline);
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(); } catch { /* 已断开 */ }
  }

  reconnect(message, fresh = false) {
    if (this.stopped) return;
    this.lastError = message;
    this.state = 'reconnecting';
    if (fresh) { this.session = ''; this.seq = null; }
    this.detach();
    clearTimeout(this.retry);
    const delay = Math.min(60000, 1000 * 2 ** Math.min(this.attempt++, 6));
    this.log(`[qq-events] ${message}；${Math.round(delay / 1000)} 秒后重试`);
    this.retry = setTimeout(() => void this.connect(), delay);
  }

  async connect() {
    this.state = 'connecting';
    try {
      if (!this.Socket) throw new Error('需要 Node.js 22.4+，推荐 Node.js 24');
      const { url, token } = await this.connectInfo();
      if (this.stopped) return;
      if (!url?.startsWith('wss://')) throw new Error('QQ 未返回有效的安全 WebSocket 地址');
      const socket = new this.Socket(url);
      this.socket = socket;
      this.deadline = setTimeout(() => this.reconnect('QQ 连接或鉴权超时'), 20000);
      socket.addEventListener('message', event => {
        if (this.socket !== socket) return;
        try { this.receive(JSON.parse(event.data), token); }
        catch { this.reconnect('QQ 事件格式错误'); }
      });
      socket.addEventListener('error', () => {
        if (this.socket === socket) this.reconnect('WebSocket 连接失败；请检查网络及账号是否仍支持该接入方式');
      });
      socket.addEventListener('close', event => {
        if (this.socket !== socket) return;
        // 不输出平台原始 reason，避免凭证进入日志。
        if ([4004, 4013, 4014].includes(event.code)) {
          this.stop();
          this.state = 'error';
          this.lastError = `QQ 拒绝鉴权或事件权限（${event.code}）；检查凭证、群事件权限及接入方式后重启`;
          this.log(`[qq-events] ${this.lastError}`);
          return;
        }
        this.reconnect(`QQ 连接断开（${event.code}）`, [4006, 4007, 4009].includes(event.code));
      });
    } catch (error) {
      this.reconnect(error.message);
    }
  }

  send(op, d) {
    this.socket?.send(JSON.stringify({ op, d }));
  }

  receive(frame, token) {
    if (Number.isInteger(frame.s)) this.seq = frame.s;
    if (frame.op === 10) {
      const interval = frame.d?.heartbeat_interval;
      if (!Number.isFinite(interval) || interval < 1000) throw new Error('invalid heartbeat');
      clearInterval(this.heartbeat);
      this.acked = true;
      this.heartbeat = setInterval(() => {
        if (!this.acked) return this.reconnect('QQ 心跳确认超时');
        this.acked = false;
        this.send(1, this.seq);
      }, interval);
      if (this.session) {
        this.send(6, { token: `QQBot ${token}`, session_id: this.session, seq: this.seq });
      } else {
        this.send(2, { token: `QQBot ${token}`, intents: 1 << 25, shard: [0, 1] });
      }
    } else if (frame.op === 11) {
      this.acked = true;
    } else if (frame.op === 1) {
      this.send(1, this.seq);
    } else if (frame.op === 7) {
      this.reconnect('QQ 要求重新连接');
    } else if (frame.op === 9) {
      this.reconnect('QQ 会话无效，重新鉴权', true);
    } else if (frame.op === 0) {
      if (frame.t === 'READY' || frame.t === 'RESUMED') {
        if (frame.t === 'READY') this.session = frame.d?.session_id || '';
        clearTimeout(this.deadline);
        this.state = 'ready';
        this.lastError = '';
        this.attempt = 0;
        this.log('[qq-events] QQ 事件连接已就绪；仅首次获取群标识需要在群中 @机器人，已配置目标群可直接从网页发送');
      }
      if (frame.t === 'GROUP_AT_MESSAGE_CREATE') {
        const id = frame.d?.group_openid;
        if (typeof id !== 'string' || !id || id.length > 256 || /[\x00-\x20\x7f]/.test(id)) return;
        const old = this.groups.get(id);
        if (old?.message_id === frame.d.id) return;
        if (!old && this.groups.size >= 100) this.groups.delete(this.groups.keys().next().value);
        this.groups.set(id, {
          group_openid: id, last_seen: new Date().toISOString(),
          message_id: typeof frame.d.id === 'string' ? frame.d.id : ''
        });
        this.log(`[qq-events] 收到群事件，group_openid=${id}；使用 npm run status 查看`);
      }
    }
  }
}
