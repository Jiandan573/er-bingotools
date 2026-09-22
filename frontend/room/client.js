// 单文件网页与桌面版共用；由 scripts/embed-rooms.mjs 内嵌到主 HTML。
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const session = { applying: false };
  const KEY = 'bingotools.rooms.v2';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  let room = null, listing = [], offset = 0, connected = false, busy = false, connecting = null;
  let dirty = false, generation = 0, updateTimer, pollBusy = false, lastBeat = 0, developer = false, createOnly = false;
  let popup = false, pinned = false, previousRoom = '';
  const states = { waiting: '等待开始', countdown: '准备倒计时', playing: '比赛进行中', mounted: '已挂载（暂停）', ended: '比赛已结束' };
  const store = () => localStorage.setItem(KEY, JSON.stringify(saved));
  const service = () => getQQBotConfig().serviceUrl;
  const now = () => Date.now() + offset;
  const canEdit = () => !room || room.state === 'ended' || (room.canControl && connected && ['waiting', 'playing'].includes(room.state));
  const status = message => { if ($('matchSyncStatus')) $('matchSyncStatus').textContent = message; };
  const clock = n => [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60].map(x => String(x).padStart(2, '0')).join(':');

  // BOARD_ADAPTER

  function invalidate(message) {
    saved.token = ''; saved.room = ''; delete saved.pendingCreate; room = null; dirty = false; developer = false;
    store(); connected = false; pauseStopwatch(); status(message); chrome();
  }
  async function request(path, body = {}) {
    const url = service();
    const bridge = window.go?.app?.App?.CallRoomService;
    let code, data;
    const start = Date.now();
    if (bridge) {
      const r = await bridge(url, saved.token || '', path, JSON.stringify(body));
      code = r.status;
      try { data = JSON.parse(r.body); } catch { throw new Error('服务返回格式错误，请检查地址'); }
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90000);
      try {
        const response = await fetch(url + path, {
          method: path === '/health' ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json', ...(saved.token ? { Authorization: 'Bearer ' + saved.token } : {}) },
          ...(path === '/health' ? {} : { body: JSON.stringify(body) }), signal: controller.signal, redirect: 'error'
        });
        code = response.status; data = await response.json();
      } catch (e) { throw new Error(e.name === 'AbortError' ? '唤醒服务超过 90 秒，请稍后重试' : '无法连接服务，请检查网络与 Render 地址'); }
      finally { clearTimeout(timer); }
    }
    if (data.instance && saved.instance && data.instance !== saved.instance) {
      invalidate('服务器已重启，房间、挂载和历史已清空，请重新创建比赛');
      saved.instance = data.instance; store();
      throw Object.assign(new Error('服务器已重启，请重新连接'), { status: 401 });
    }
    if (data.instance) { saved.instance = data.instance; store(); }
    if (data.serverTime) offset = data.serverTime - (Date.now() + start) / 2;
    if (code < 200 || code >= 300 || data.ok === false) {
      if (code === 401) invalidate('会话已过期，请重新连接');
      throw Object.assign(new Error(data.error || '请求失败'), { status: code });
    }
    return data;
  }
  const api = (path, body) => request('/api/v2' + path, body);
  async function connect() {
    if (connecting) return connecting;
    connecting = (async () => {
      status('正在连接 / 唤醒服务器…');
      if (saved.url && saved.url !== service()) invalidate('服务器地址已更改');
      saved.url = service(); store();
      try { await request('/health'); } catch (e) { if (e.status !== 401) throw e; }
      if (!saved.token) { saved.token = (await api('/session')).token; store(); }
      let list;
      try { list = await api('/list'); }
      catch (e) {
        if (e.status !== 401) throw e;
        saved.token = (await api('/session')).token; store(); list = await api('/list');
      }
      connected = true; listing = list.rooms; developer = list.developer;
      if (saved.room) {
        try { accept((await api('/get', { id: saved.room })).room, true); }
        catch (e) { if (e.status !== 404) throw e; saved.room = ''; store(); }
      }
      status('已连接 · 普通用户无需使用密钥'); chrome();
    })().catch(e => { connected = false; status(e.message); chrome(); throw e; }).finally(() => { connecting = null; });
    return connecting;
  }
  function accept(next, force = false) {
    if (room && room.id === next.id && next.rev < room.rev) return;
    const changed = !room || room.id !== next.id;
    const lostControl = room?.canControl && !next.canControl;
    room = next; saved.room = next.id; store();
    if (force || changed || !next.canControl || lostControl) { dirty = false; applyBoard(next.board); }
    chrome(); mini();
  }
  function chrome() {
    if (!$('beginMatchBtn')) return;
    $('beginMatchBtn').disabled = busy || (!!room && (!room.canControl || room.state !== 'waiting'));
    $('endMatchBtn').disabled = busy || !room?.canControl || ['ended', 'mounted'].includes(room?.state);
    $('endLocalOnlyBtn').classList.add('hide');
    $('matchStatus').textContent = room ? `${states[room.state]} · ${room.isHost ? '裁判' : room.canControl ? '开发者' : '只读'}` : '比赛未开始';
    if (room) {
      if (!room.canControl && room.state !== 'ended') {
        $('t1').innerText = room.scores.red; $('t2').innerText = room.scores.blue;
      }
      const notifications = Object.entries(room.delivery).map(([k, v]) => `${k === 'start' ? '开始' : '结束'}播报：${({ pending: '排队发送中', sent: '已发送', failed: '失败', unknown: '结果未确认，请核对 QQ 群' })[v.status]}${v.error ? ' · ' + v.error : ''}`).join('；');
      if (connected) status(notifications || '房间已连接，数据保存在服务器内存');
      stopwatchSeconds = room.elapsed_seconds + (room.state === 'playing' ? Math.max(0, Math.floor((now() - lastReceivedAt) / 1000)) : 0);
      if (room.state === 'countdown') $('stopwatch-display').textContent = `准备 ${Math.max(0, Math.ceil((room.countdownEnd - now()) / 1000))}`;
      else updateStopwatchDisplay();
    }
    $('roomMount').disabled = !room?.canControl || !['waiting', 'playing', 'countdown'].includes(room?.state);
    $('roomLeave').disabled = !room;
    $('roomCountdown').disabled = !room?.canControl;
    if (room && document.activeElement !== $('roomCountdown')) $('roomCountdown').value = room.countdown;
    $('roomCountdownSave').disabled = !room?.canControl;
    $('roomDevControls').hidden = !developer;
    document.body.classList.toggle('room-readonly', !!room && !canEdit());
  }
  let lastReceivedAt = now();
  const originalAccept = accept;
  accept = function(next, force) { if (!room || next.rev >= room.rev || next.id !== room.id) lastReceivedAt = now(); originalAccept(next, force); };
  function schedule() {
    if (session.applying || !room?.canControl || !canEdit()) return;
    dirty = true; generation++;
    clearTimeout(updateTimer); updateTimer = setTimeout(() => flush().catch(e => status(e.message)), 1000);
  }
  let flushing;
  async function flush() {
    if (flushing) { await flushing; if (dirty) return flush(); return; }
    if (!dirty || !room?.canControl || !connected || !['waiting', 'playing'].includes(room.state)) return;
    const id = room.id, rev = room.rev, gen = generation;
    flushing = api('/update', { id, revision: rev, board: collectBoard(), scores: currentMatchScores() }).then(data => {
      if (room?.id !== id) return;
      dirty = generation !== gen; accept(data.room);
    }).catch(async e => {
      if (e.status === 409) {
        accept((await api('/get', { id })).room, true);
        showToast('房间发生并发更新，已载入服务器版本，请重新操作');
      } else { connected = false; status('同步失败，画面已保留：' + e.message); chrome(); }
      throw e;
    }).finally(() => { flushing = null; });
    return flushing;
  }
  async function action(path, extra = {}) {
    if (!room) throw new Error('请先创建或加入房间');
    await flush();
    try {
      const data = await api(path, { id: room.id, revision: room.rev, ...extra });
      if (data.room) accept(data.room);
      return data;
    } catch (e) {
      if (e.status === 409) accept((await api('/get', { id: room.id })).room, true);
      throw e;
    }
  }
  async function poll() {
    if (pollBusy || busy || flushing) return;
    pollBusy = true;
    try {
      if (!connected) { await connect(); return; }
      if (saved.room) {
        const heartbeat = Date.now() - lastBeat >= 10000;
        const data = await api(heartbeat ? '/heartbeat' : '/get', { id: saved.room });
        if (heartbeat) lastBeat = Date.now();
        accept(data.room);
        if (dirty) await flush();
      }
      if (!$('roomModal').classList.contains('modal-hide')) await refreshList();
    } catch (e) {
      if ([403, 404].includes(e.status)) { room = null; saved.room = ''; dirty = false; store(); }
      connected = false; status('连接中断，显示上次同步数据：' + e.message); chrome();
    } finally { pollBusy = false; }
  }
  async function run(fn) {
    if (busy) return;
    busy = true; chrome();
    try { await fn(); }
    catch (e) { showToast(e.message); status(e.message); }
    finally { busy = false; chrome(); }
  }
  function form(waiting = false) {
    if (room && !['ended', 'mounted'].includes(room.state)) {
      if (waiting) { showToast('请先结束或挂载当前房间'); return; }
      run(() => action('/start')); return;
    }
    createOnly = waiting;
    pendingMatchPayload = null;
    const r = loadRefereeInfo();
    $('refereePlatformInput').value = r.platform || 'bilibili';
    $('refereeRoomInput').value = r.room || ''; $('refereeTitleInput').value = r.title || '';
    $('matchStartModalTitle').textContent = waiting ? '创建等待房间' : '开始比赛';
    $('saveAndStartMatchBtn').textContent = waiting ? '保存并创建' : '保存并开始';
    $('startLocalOnlyBtn').classList.add('hide'); showMatchStartError(''); updateMatchStartPreview();
    $('matchStartModal').classList.remove('modal-hide');
  }
  async function create() {
    const r = validateRefereeForm(); if (!r) return;
    await run(async () => {
      if (!connected) await connect();
      saveRefereeInfo(r.room, r.title);
      saved.pendingCreate ||= { request_id: crypto.randomUUID(), match: buildMatchStartPayload(r.room, r.title), board: collectBoard(), scores: currentMatchScores() };
      store();
      let result;
      try { result = await api('/create', saved.pendingCreate); }
      catch (e) { if ([400, 403, 404, 409].includes(e.status)) { delete saved.pendingCreate; store(); } throw e; }
      delete saved.pendingCreate; store();
      accept(result.room); hideMatchStartModal();
      if (!createOnly) await action('/start');
      else showToast('等待房间已创建，可在比赛列表复制识别码');
    });
  }
  async function finish() {
    if (!room?.canControl || !confirm(`确认结束？红方 ${currentMatchScores().red}，蓝方 ${currentMatchScores().blue} 分。`)) return;
    await run(() => action('/end', { board: collectBoard(), scores: currentMatchScores() }));
  }
  async function refreshList() {
    const data = await api('/list');
    listing = data.rooms; developer = data.developer;
    $('roomCards').innerHTML = ['waiting', 'countdown', 'playing', 'mounted', 'ended'].map(state => {
      const rows = listing.filter(r => r.state === state).sort((a, b) => b.updatedAt - a.updatedAt);
      return `<h3>${states[state]}（${rows.length}）</h3>` + rows.map(r => `<article class="room-card">
        <strong>${esc(r.match.left.name)} vs ${esc(r.match.right.name)}</strong> · ${r.scores.red} : ${r.scores.blue}
        <p>裁判：${esc(r.match.referee.title)} · 用时 ${clock(r.elapsed_seconds)}</p>
        <p>识别码：${esc(r.id)} · ${r.members.length}/10 人</p>
        <button data-room="${r.id}" data-op="detail">详情</button>
        <button data-room="${r.id}" data-op="copy">复制识别码</button>
        ${!['mounted', 'ended'].includes(state) ? `<button data-room="${r.id}" data-op="join">加入</button>` : ''}
        ${state === 'mounted' ? `<button data-room="${r.id}" data-op="takeover">接管</button>` : ''}
        ${state === 'ended' && r.canControl ? `<button data-room="${r.id}" data-op="remount">重新挂载</button>` : ''}
        ${state === 'mounted' && developer ? `<button data-room="${r.id}" data-op="delete">删除挂载</button>` : ''}
      </article>`).join('');
    }).join('');
    if (room) $('roomMembers').innerHTML = room.members.map(m => `<div>${esc(m.name)} · ${m.online ? '在线' : '离线'}${room.canControl && !m.isSelf ? ` <button data-member="${m.id}">移出</button>` : ''}</div>`).join('');
    else $('roomMembers').textContent = '尚未加入房间';
    chrome();
  }
  async function openList() {
    $('roomModal').classList.remove('modal-hide');
    await run(async () => { if (!connected) await connect(); await refreshList(); });
  }
  async function join(id) {
    if (room?.isHost && !['mounted', 'ended'].includes(room.state) && room.id !== id) throw new Error('请先结束或挂载当前裁判房间');
    const name = prompt('你的显示名字', saved.name || '观众'); if (!name?.trim()) return;
    saved.name = name.trim(); store();
    if (room && room.id !== id && !room.isHost) await api('/leave', { id: room.id });
    const data = await api('/join', { id, name });
    accept(data.room, true); $('roomModal').classList.add('modal-hide');
  }
  async function card(e) {
    const b = e.target.closest('[data-op]'); if (!b) return;
    await run(async () => {
      const r = listing.find(r => r.id === b.dataset.room); if (!r) return;
      if (b.dataset.op === 'copy') {
        try { await navigator.clipboard.writeText(r.id); showToast('识别码已复制'); }
        catch { prompt('复制房间识别码', r.id); }
      } else if (b.dataset.op === 'detail') {
        const data = await api('/get', { id: r.id });
        $('roomDetail').textContent = JSON.stringify({ 裁判: data.room.match.referee, 选手: [data.room.match.left, data.room.match.right], 比分: data.room.scores, 棋盘: data.room.board, 接管记录: data.room.records, 播报状态: data.room.delivery }, null, 2);
      } else if (b.dataset.op === 'join') await join(r.id);
      else if (b.dataset.op === 'takeover') {
        const previous = loadRefereeInfo();
        const title = prompt('接管裁判名字', previous.title || ''); if (!title?.trim()) return;
        const address = prompt('裁判直播间完整地址', previous.room || ''); if (!address?.trim()) return;
        const referee = { title, room: address, platform: previous.platform || 'bilibili' };
        const result = await api('/takeover', { id: r.id, revision: r.rev, referee });
        accept(result.room, true); $('roomModal').classList.add('modal-hide');
      } else if (b.dataset.op === 'remount') {
        await api('/remount', { id: r.id, request_id: crypto.randomUUID() });
      } else if (b.dataset.op === 'delete' && confirm('删除这场挂载比赛？')) await api('/delete', { id: r.id, revision: r.rev });
      await refreshList();
    });
  }
  function mini() {
    if (!popup) return;
    const b = room?.board || collectBoard();
    $('roomMiniTitle').textContent = `${room?.match.left.name || '红方'} ${room?.scores.red ?? currentMatchScores().red} : ${room?.scores.blue ?? currentMatchScores().blue} ${room?.match.right.name || '蓝方'} · ${clock(stopwatchSeconds)}`;
    $('roomMiniGrid').innerHTML = b.red.map((v, i) => `<div style="background:${v && b.blue[i] ? '#795548' : v ? '#782626' : b.blue[i] ? '#254b7e' : '#25272c'}">${esc(b.cellTexts?.[i] || i + 1)}</div>`).join('');
  }
  function toggleMini() {
    popup = !popup; $('roomMini').hidden = !popup; mini();
    if (!popup && pinned) { pinned = false; window.runtime?.WindowSetAlwaysOnTop?.(false); }
  }
  function buildUI() {
    const style = document.createElement('style');
    style.textContent = `.timer-box-stopwatch{overflow:auto}.timer-box-stopwatch .match-status{flex-shrink:0;max-width:none;overflow:visible}.room-card{padding:12px;margin:8px 0;border:1px solid #555;border-radius:8px}.room-card button{margin:4px}.room-readonly #grid{pointer-events:none;opacity:.85}#roomModal .modal{max-width:820px;max-height:85vh;overflow:auto}#roomDetail{white-space:pre-wrap;max-height:240px;overflow:auto}#roomMini{position:fixed;top:70px;left:30px;width:460px;height:420px;min-width:250px;min-height:250px;resize:both;overflow:auto;background:#16181c;border:1px solid #777;z-index:1200;padding:12px;border-radius:10px}#roomMiniBar{cursor:move;touch-action:none}#roomMiniGrid{display:grid;grid-template-columns:repeat(5,1fr);gap:3px;height:80%}#roomMiniGrid>div{padding:5px;overflow:hidden;display:flex;align-items:center;justify-content:center}`;
    document.head.append(style);
    const toolbar = document.createElement('span');
    toolbar.innerHTML = `<button type="button" id="roomListBtn">比赛列表</button> <button type="button" id="roomMiniBtn">小窗</button>`;
    $('btnsToolbar').append(toolbar);
    const root = document.createElement('div');
    root.innerHTML = `<div id="roomModal" class="modal-overlay modal-hide"><div class="modal">
      <div class="modal-title">比赛房间</div><p>公开使用，无需密钥。房间、挂载与历史仅保存在内存，服务器重启后清空。</p>
      <button id="roomClose">关闭</button> <button id="roomRefresh">刷新 / 重连</button> <button id="roomCreate">创建等待房间</button>
      <input id="roomJoinCode" placeholder="房间识别码"><button id="roomJoin">加入</button>
      <p><button id="roomMount">挂载并暂停</button> <button id="roomLeave">离开当前房间</button></p>
      <label>准备倒计时（秒）<input type="number" min="0" max="60" value="5" id="roomCountdown"></label><button id="roomCountdownSave">保存</button>
      <div id="roomMembers"></div><p><button id="roomRetryStart">重试明确失败的开始通知</button> <button id="roomRetryEnd">重试明确失败的结束通知</button></p>
      <div id="roomCards"></div><pre id="roomDetail"></pre></div></div>
      <div id="roomMini" hidden><div id="roomMiniBar"><b>比赛小窗（拖动）</b> <button id="roomMiniClose">关闭</button> <button id="roomPin">置顶</button>
      <input type="number" id="roomFont" value="18" min="8" max="72" aria-label="小窗字体" style="width:52px"></div><p id="roomMiniTitle"></p><div id="roomMiniGrid"></div></div>`;
    document.body.append(root);
    const section = document.createElement('section'); section.className = 'set-section';
    section.innerHTML = `<h3>开发者模式</h3><p>普通用户不需要开启；权限由服务器验证。</p><input id="roomDevCode" type="password" placeholder="开发者识别码" autocomplete="off">
      <button id="roomDevLogin">开启</button> <button id="roomDevLogout">关闭</button>
      <div id="roomDevControls" hidden><label><input type="checkbox" id="roomAutoEnabled">定时群汇总</label>
      <label>间隔（分钟）<input id="roomAutoInterval" type="number" min="5" max="1440" value="5"></label><button id="roomAutoSave">保存服务端设置</button></div>`;
    $('qqBotServiceUrl').closest('section').after(section);
    $('roomListBtn').onclick = openList; $('roomClose').onclick = () => $('roomModal').classList.add('modal-hide');
    $('roomRefresh').onclick = () => run(async () => { await connect(); await refreshList(); });
    $('roomCreate').onclick = () => { $('roomModal').classList.add('modal-hide'); form(true); };
    $('roomJoin').onclick = () => run(() => join($('roomJoinCode').value.trim()));
    $('roomCards').onclick = card;
    $('roomMount').onclick = () => run(() => action('/mount'));
    $('roomLeave').onclick = () => run(async () => {
      await action('/leave'); previousRoom = saved.room; room = null; saved.room = ''; dirty = false; store(); pauseStopwatch(); chrome(); await refreshList();
    });
    $('roomCountdownSave').onclick = () => run(() => action('/settings', { countdown: Number($('roomCountdown').value) }));
    $('roomMembers').onclick = e => { const id = e.target.dataset.member; if (id) run(() => action('/kick', { member: id })); };
    $('roomRetryStart').onclick = () => run(() => action('/retry', { kind: 'start' }));
    $('roomRetryEnd').onclick = () => run(() => action('/retry', { kind: 'end' }));
    $('roomDevLogin').onclick = () => run(async () => {
      if (!connected) await connect();
      await api('/dev-auth', { code: $('roomDevCode').value }); $('roomDevCode').value = ''; developer = true;
      const data = await api('/dev/settings');
      $('roomAutoEnabled').checked = data.settings.enabled; $('roomAutoInterval').value = data.settings.interval; chrome();
    });
    $('roomDevLogout').onclick = () => run(async () => { await api('/dev/logout'); developer = false; chrome(); });
    $('roomAutoSave').onclick = () => run(async () => {
      await api('/dev/settings', { enabled: $('roomAutoEnabled').checked, interval: Number($('roomAutoInterval').value) }); showToast('服务端定时播报设置已保存');
    });
    $('roomMiniBtn').onclick = toggleMini; $('roomMiniClose').onclick = toggleMini;
    $('roomPin').disabled = !window.runtime?.WindowSetAlwaysOnTop;
    $('roomPin').title = '桌面版支持窗口置顶';
    $('roomPin').onclick = () => { pinned = !pinned; window.runtime.WindowSetAlwaysOnTop(pinned); };
    $('roomFont').oninput = () => { $('roomMiniGrid').style.fontSize = Math.max(8, Math.min(72, Number($('roomFont').value))) + 'px'; };
    let drag;
    $('roomMiniBar').onpointerdown = e => {
      if (e.target.closest('button,input')) return;
      drag = { x: e.clientX, y: e.clientY, left: $('roomMini').offsetLeft, top: $('roomMini').offsetTop };
      $('roomMiniBar').setPointerCapture(e.pointerId);
    };
    $('roomMiniBar').onpointermove = e => {
      if (!drag) return;
      $('roomMini').style.left = Math.max(0, Math.min(innerWidth - 100, drag.left + e.clientX - drag.x)) + 'px';
      $('roomMini').style.top = Math.max(0, Math.min(innerHeight - 50, drag.top + e.clientY - drag.y)) + 'px';
    };
    $('roomMiniBar').onpointerup = () => { drag = null; };
  }
  const save = window.saveGameState;
  const boardLocked = window.isBoardLockedMode;
  window.isBoardLockedMode = () => !canEdit() || boardLocked();
  window.saveGameState = function(...args) { const result = save(...args); schedule(); return result; };
  for (const name of ['setRed', 'setBlue', 'resetCell', 'add1', 'add2', 'adjustExtra', 'resetSettle', 'resetAll', 'saveSettings', 'toggleCellMark', 'clearCellMarks']) {
    const fn = window[name]; if (typeof fn !== 'function') continue;
    window[name] = function(...args) { if (!canEdit()) { showToast('当前房间只读或连接已中断'); return; } const result = fn(...args); schedule(); return result; };
  }
  window.loadMatchState = () => { activeMatch = null; pendingMatchPayload = null; pauseStopwatch(); };
  window.showMatchStartModal = () => form(false);
  window.saveAndStartMatch = create;
  window.endCurrentMatch = finish;
  window.syncMatchScore = schedule;
  window.updateMatchStatus = chrome;
  window.saveQQBotConfig = () => run(async () => {
    let url;
    try { url = new URL($('qqBotServiceUrl').value.trim()); } catch { throw new Error('服务地址格式不正确'); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('请使用 HTTPS 地址');
    if (room && !['ended', 'mounted'].includes(room.state)) throw new Error('请先结束或挂载比赛再切换服务器');
    localStorage.setItem(QQ_BOT_CONFIG_KEY, JSON.stringify({ serviceUrl: url.href.replace(/\/+$/, ''), clientKey: getQQBotConfig().clientKey }));
    await connect();
  });
  window.addEventListener('load', () => {
    buildUI(); pauseStopwatch(); chrome(); connect().catch(() => {});
    setInterval(poll, 3000);
    setInterval(() => { if (connected) chrome(); mini(); }, 250);
  });
  window.BingoRooms = { connect, openList, collectBoard, applyBoard, getRoom: () => room };
})();
