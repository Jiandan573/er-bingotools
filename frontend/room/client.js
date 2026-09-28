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
  let previousRoom = '', popup = false, pinned = false;
  const states = { waiting: '等待开始', countdown: '准备倒计时', playing: '比赛进行中', mounted: '已挂载（暂停）', ended: '比赛已结束' };
  const store = () => localStorage.setItem(KEY, JSON.stringify(saved));
  const isOffline = () => !!saved.offlineMode;
  function localProxyBase() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return '';
    if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return '';
    return location.origin + '/qqbot';
  }
  const service = () => localProxyBase() || getQQBotConfig().serviceUrl;
  const now = () => Date.now() + offset;
  const canEdit = () => !room || (room.canControl && connected && ['waiting', 'playing'].includes(room.state));
  function revealConnPanel() {
    if (typeof settings !== 'undefined' && !settings.showMemoConn) {
      settings.showMemoConn = 1;
      if (typeof saveSettingsToLocal === 'function') saveSettingsToLocal();
      if (typeof applyMemoConnVisibility === 'function') applyMemoConnVisibility();
    }
  }
  function paintConn(kind, title, detail, revealOnErr = false) {
    const el = $('memoConnStatus');
    if (el) {
      el.textContent = title || '';
      el.classList.remove('is-ok', 'is-off', 'is-err');
      if (kind) el.classList.add(kind);
    }
    const detailEl = $('memoConnDetail');
    if (detailEl && detail != null) {
      detailEl.textContent = detail;
      detailEl.classList.toggle('is-err', kind === 'is-err');
    }
    if (revealOnErr && kind === 'is-err') revealConnPanel();
  }
  const status = message => {
    const msg = message || '';
    if (isOffline()) paintConn('is-off', '单机模式', msg || '未连接服务器，仅本地使用');
    else if (!connected) paintConn('is-err', '未连接', msg || service() || '未配置服务器地址', true);
    else paintConn('is-ok', '已连接', msg || service().replace(/^https?:\/\//, ''));
  };
  const clock = n => [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60].map(x => String(x).padStart(2, '0')).join(':');
  async function deleteRoom(id) {
    try {
      await api('/delete', { id });
    } catch (e) {
      // 兼容未部署的旧服务端：仍要求 revision
      if (e.status === 409 || /已更新|revision/i.test(e.message || '')) {
        const fresh = await api('/get', { id });
        await api('/delete', { id, revision: fresh.room.rev });
        return;
      }
      throw e;
    }
  }
  function localRoster() {
    if (window.BingoRoster?.getLocal) return window.BingoRoster.getLocal();
    return [];
  }
  async function syncRosterFromServer() {
    return run(async () => {
      if (isOffline()) throw new Error('单机模式不能同步服务端选手名册');
      if (!connected) await connect();
      const data = await api('/roster');
      if (!window.BingoRoster?.mergeFromServer) throw new Error('当前页面不支持选手名册同步，请刷新页面');
      const result = window.BingoRoster.mergeFromServer(data.roster || []);
      showToast(`已从服务端合并 ${result.added} 条，更新 ${result.updated} 条${result.conflicts ? `，处理冲突 ${result.conflicts} 条` : ''}`);
    });
  }
  async function syncRosterToServer() {
    return run(async () => {
      if (isOffline()) throw new Error('单机模式不能同步服务端选手名册');
      if (!connected) await connect();
      if (!developer) throw new Error('同步到服务端需要开发者权限');
      const data = await api('/roster/push', { entries: localRoster() });
      if (window.BingoRoster?.mergeFromServer) window.BingoRoster.mergeFromServer(data.roster || []);
      showToast(`已同步到服务端：新增 ${data.added || 0} 条，更新 ${data.updated || 0} 条`);
    });
  }

  // BOARD_ADAPTER

  function invalidate(message) {
    saved.token = ''; saved.room = ''; delete saved.pendingCreate; room = null; dirty = false; developer = false;
    store(); connected = false; pauseStopwatch(); status(message); chrome();
  }
  function rememberInstance(instance) {
    if (!instance) return;
    if (saved.instance && saved.instance !== instance) {
      saved.token = '';
      saved.room = '';
      delete saved.pendingCreate;
      room = null;
      dirty = false;
      developer = false;
      connected = false;
      status('服务器已重启，正在重新连接…');
    }
    saved.instance = instance;
    store();
  }
  async function request(path, body = {}) {
    const url = service();
    if (!url) throw new Error('请先在全局设置填写服务器地址');
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
      const isHealth = path === '/health';
      try {
        const headers = {};
        if (!isHealth) headers['Content-Type'] = 'application/json';
        if (saved.token) headers.Authorization = 'Bearer ' + saved.token;
        const response = await fetch(url + path, {
          method: isHealth ? 'GET' : 'POST',
          headers,
          ...(isHealth ? {} : { body: JSON.stringify(body == null ? {} : body) }),
          signal: controller.signal,
          redirect: 'follow',
          mode: 'cors',
          credentials: 'omit'
        });
        code = response.status;
        try { data = await response.json(); }
        catch { throw new Error('服务返回格式错误（HTTP ' + code + '）'); }
      } catch (e) {
        if (e && e.status) throw e;
        if (e.name === 'AbortError') throw new Error('唤醒服务超过 90 秒，请稍后重试');
        if (location.protocol === 'file:') {
          throw new Error('请用 http://127.0.0.1:8000 打开页面（先运行 node scripts/serve-html.mjs），不要双击 HTML');
        }
        throw new Error('无法连接服务：' + (e.message || '网络错误') + '（当前地址 ' + url + '）。浏览器请用 http://127.0.0.1:8000/bingotools.html；桌面版请确认全局设置里的服务地址为 https://bingotools-qqbot-api.onrender.com');
      } finally { clearTimeout(timer); }
    }
    if (data && data.instance) rememberInstance(data.instance);
    if (data && data.serverTime) offset = data.serverTime - (Date.now() + start) / 2;
    if (code < 200 || code >= 300 || data.ok === false) {
      if (code === 401) invalidate('会话已过期，请重新连接');
      const errText = (data && data.error) || ('请求失败 HTTP ' + code);
      if (code === 403 && /网页来源|ORIGIN|CORS|Allow-Origin/i.test(errText)) {
        throw Object.assign(new Error('云端拒绝了当前页面来源。请用 http://127.0.0.1:8000/bingotools.html（先运行 node scripts/serve-html.mjs），或重新部署 qqbot-service 的 CORS 修复'), { status: code });
      }
      throw Object.assign(new Error(errText), { status: code });
    }
    return data;
  }
  const api = (path, body) => request('/api/v2' + path, body);
  async function connect() {
    if (isOffline()) {
      connected = false;
      status('单机模式：不连接服务器');
      chrome();
      return;
    }
    if (connecting) return connecting;
    connecting = (async () => {
      status('正在连接 / 唤醒服务器…');
      const target = service();
      if (!target) throw new Error('未配置服务器地址');
      if (window.go?.app?.App && !window.go.app.App.CallRoomService) {
        throw new Error('桌面桥接 CallRoomService 未加载，请重新编译桌面版后再连云端');
      }
      if (saved.url && saved.url !== target) {
        saved.token = '';
        saved.room = '';
        delete saved.pendingCreate;
        room = null;
      }
      saved.url = target; store();
      // /health 仅用于唤醒冷启动；失败不阻断（CORS/旧桌面桥等）
      try { await request('/health'); } catch (e) { /* continue to session */ }
      if (!saved.token) {
        const session = await api('/session', {});
        saved.token = session.token; store();
      }
      let list;
      try { list = await api('/list', {}); }
      catch (e) {
        if (![401, 403].includes(e.status)) throw e;
        saved.token = (await api('/session', {})).token; store();
        list = await api('/list', {});
      }
      connected = true; listing = list.rooms; developer = list.developer;
      if (saved.room) {
        try { accept((await api('/get', { id: saved.room })).room, true); }
        catch (e) {
          if ([403, 404].includes(e.status)) { saved.room = ''; room = null; store(); }
          else { saved.room = ''; room = null; store(); status('上次房间已失效，已重新连接'); }
        }
      }
      chrome();
    })().catch(e => {
      connected = false;
      status(e.message || '连接失败');
      chrome();
      throw e;
    }).finally(() => { connecting = null; });
    return connecting;
  }
  function accept(next, force = false) {
    if (room && room.id === next.id && next.rev < room.rev) return;
    const changed = !room || room.id !== next.id;
    const lostControl = room?.canControl && !next.canControl;
    room = next; saved.room = next.id; store();
    if (force || changed || !next.canControl || lostControl) { dirty = false; applyBoard(next.board); }
    chrome();
  }
  function applyTimerButtonLabels() {
    const begin = $('beginMatchBtn'), pause = $('pauseMatchBtn'), end = $('endMatchBtn');
    const offlineTimer = isOffline() && !room;
    if (begin) begin.textContent = offlineTimer ? '开始计时' : '开始比赛';
    if (pause) pause.textContent = offlineTimer ? '暂停' : '暂停比赛';
    if (end) end.textContent = offlineTimer ? '重置' : '比赛结束';
  }
  function chrome() {
    if (!$('beginMatchBtn')) return;
    applyTimerButtonLabels();
    const offlineTimer = isOffline() && !room;
    const localRunning = !room && typeof activeMatch !== 'undefined' && activeMatch && !activeMatch.endedAt;
    const canPauseRoom = !!room?.canControl && ['waiting', 'playing', 'countdown'].includes(room?.state);
    if (offlineTimer) {
      $('beginMatchBtn').disabled = busy || !!stopwatchRunning;
      if ($('pauseMatchBtn')) $('pauseMatchBtn').disabled = busy || !stopwatchRunning;
      if ($('endMatchBtn')) $('endMatchBtn').disabled = busy || (!stopwatchRunning && !(stopwatchSeconds > 0));
    } else {
      $('beginMatchBtn').disabled = busy || localRunning || (!!room && (!room.canControl || room.state !== 'waiting'));
      if ($('pauseMatchBtn')) $('pauseMatchBtn').disabled = busy || (!canPauseRoom && !(localRunning && stopwatchRunning));
      if ($('endMatchBtn')) {
        $('endMatchBtn').disabled = busy || (room
          ? (!room.canControl || ['ended', 'mounted'].includes(room.state))
          : !localRunning);
      }
    }
    if ($('endLocalOnlyBtn')) $('endLocalOnlyBtn').classList.add('hide');
    if ($('matchStatus')) {
      if (room) $('matchStatus').textContent = `${states[room.state] || room.state} · ${room.isHost ? '裁判' : room.canControl ? '开发者' : '只读'}`;
      else if (localRunning) $('matchStatus').textContent = activeMatch.local || isOffline() ? '比赛进行中（仅本地）' : '比赛进行中';
      else $('matchStatus').textContent = '比赛未开始';
    }
    if (room) {
      if (!room.canControl) {
        $('t1').innerText = room.scores.red; $('t2').innerText = room.scores.blue;
      }
      const notifications = Object.entries(room.delivery || {}).map(([k, v]) => `${k === 'start' ? '开始' : '结束'}播报：${({ pending: '排队发送中', sent: '已发送', failed: '失败', unknown: '结果未确认，请核对 QQ 群' })[v.status]}${v.error ? ' · ' + v.error : ''}`).join('；');
      if (connected) status(notifications || '房间已连接，数据保存在服务器内存');
      stopwatchSeconds = room.elapsed_seconds + (room.state === 'playing' ? Math.max(0, Math.floor((now() - lastReceivedAt) / 1000)) : 0);
      updateStopwatchDisplay();
    } else if (isOffline()) {
      status('单机模式：不连接服务器');
    }
    if ($('roomMount')) $('roomMount').disabled = !canPauseRoom;
    if ($('roomLeave')) $('roomLeave').disabled = !room;
    if ($('roomDelete')) {
      const canDelete = !!room && (room.isHost || (developer && ['mounted', 'ended'].includes(room.state)));
      $('roomDelete').disabled = !canDelete;
    }
    if ($('roomListBtn')) $('roomListBtn').disabled = isOffline();
    if ($('memoConnReconnect')) $('memoConnReconnect').disabled = isOffline() || busy || !!connecting;
    if ($('roomDevControls')) $('roomDevControls').hidden = !developer;
    if (typeof updateSetServerVisibility === 'function') updateSetServerVisibility(developer);
    document.body.classList.toggle('room-readonly', !!room && !canEdit());
    document.body.classList.toggle('offline-mode', isOffline());
    if (popup) mini();
  }
  function startOfflineTimer() {
    if (typeof startStopwatch === 'function') startStopwatch();
    chrome();
  }
  function pauseOfflineTimer() {
    if (typeof pauseStopwatch === 'function') pauseStopwatch();
    chrome();
  }
  function resetOfflineTimer() {
    if (typeof resetStopwatch === 'function') resetStopwatch();
    if (typeof activeMatch !== 'undefined' && activeMatch && !activeMatch.endedAt) {
      activeMatch.endedAt = new Date().toISOString();
      activeMatch.elapsedSeconds = stopwatchSeconds;
      if (typeof saveActiveMatch === 'function') saveActiveMatch();
    }
    chrome();
  }
  function mini() {
    if (!popup || !$('roomMini')) return;
    const b = room?.board || collectBoard();
    const scores = room?.scores || currentMatchScores();
    const left = room?.match?.left?.name || (typeof settings !== 'undefined' ? settings.redTeamName : '红方');
    const right = room?.match?.right?.name || (typeof settings !== 'undefined' ? settings.blueTeamName : '蓝方');
    $('roomMiniTitle').textContent = `${left} ${scores.red ?? 0} : ${scores.blue ?? 0} ${right} · ${clock(stopwatchSeconds)}`;
    $('roomMiniGrid').innerHTML = b.red.map((v, i) => `<div style="background:${v && b.blue[i] ? '#795548' : v ? '#782626' : b.blue[i] ? '#254b7e' : '#25272c'}">${esc(b.cellTexts?.[i] || i + 1)}</div>`).join('');
  }
  function toggleMini() {
    popup = !popup;
    if ($('roomMini')) $('roomMini').hidden = !popup;
    if (popup) mini();
    if (!popup && pinned) { pinned = false; window.runtime?.WindowSetAlwaysOnTop?.(false); }
  }
  let lastReceivedAt = now();
  const originalAccept = accept;
  accept = function(next, force) { if (!room || next.rev >= room.rev || next.id !== room.id) lastReceivedAt = now(); originalAccept(next, force); };
  function schedule() {
    if (session.applying || !room?.canControl || !canEdit()) return;
    dirty = true; generation++;
    clearTimeout(updateTimer); updateTimer = setTimeout(() => flush().catch(e => status(e.message)), 400);
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
    if (pollBusy || flushing || isOffline()) return;
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
      if (!busy && $('roomModal') && !$('roomModal').classList.contains('modal-hide')) await refreshList();
    } catch (e) {
      if ([403, 404].includes(e.status)) { room = null; saved.room = ''; dirty = false; store(); }
      connected = false; status('连接中断，显示上次同步数据：' + e.message); chrome();
    } finally { pollBusy = false; }
  }
  function armPoll() {
    const ms = room && !room.canControl ? 800 : 2500;
    setTimeout(async () => { try { await poll(); } finally { armPoll(); } }, ms);
  }
  async function run(fn) {
    if (busy) return;
    busy = true; chrome();
    try { await fn(); }
    catch (e) { showToast(e.message); status(e.message); }
    finally { busy = false; chrome(); }
  }
  function form(waiting = false) {
    if (isOffline() && !room) {
      if (waiting) { showToast('单机模式不能创建房间'); return; }
      startOfflineTimer();
      return;
    }
    if (isOffline() && waiting) { showToast('单机模式不能创建房间'); return; }
    if (room && !['ended', 'mounted'].includes(room.state)) {
      if (waiting) {
        if (!developer) { showToast('请先结束或挂载当前房间'); return; }
      } else {
        run(() => action('/start')); return;
      }
    }
    createOnly = waiting;
    pendingMatchPayload = null;
    const r = loadRefereeInfo();
    $('refereePlatformInput').value = r.platform || 'bilibili';
    $('refereeRoomInput').value = r.room || ''; $('refereeTitleInput').value = r.title || '';
    $('matchStartModalTitle').textContent = waiting ? '创建等待房间' : '开始比赛';
    $('saveAndStartMatchBtn').textContent = waiting ? '保存并创建' : (isOffline() ? '本地开始' : '保存并开始');
    if ($('startLocalOnlyBtn')) $('startLocalOnlyBtn').classList.toggle('hide', !isOffline());
    showMatchStartError('');
    if (typeof fillMatchStartPlayerForm === 'function') fillMatchStartPlayerForm();
    updateMatchStartPreview();
    $('matchStartModal').classList.remove('modal-hide');
  }
  async function create() {
    if (isOffline() && !room) {
      if (createOnly) { showToast('单机模式不能创建房间'); return; }
      startOfflineTimer();
      return;
    }
    const r = validateRefereeForm(); if (!r) return;
    await run(async () => {
      if (!connected) await connect();
      if (typeof applyMatchStartPlayerNames === 'function') applyMatchStartPlayerNames();
      saveRefereeInfo(r.room, r.title);
      saved.pendingCreate ||= { request_id: crypto.randomUUID(), match: buildMatchStartPayload(r.room, r.title), board: collectBoard(), scores: currentMatchScores() };
      store();
      let result;
      try { result = await api('/create', saved.pendingCreate); }
      catch (e) { if ([400, 403, 404, 409].includes(e.status)) { delete saved.pendingCreate; store(); } throw e; }
      delete saved.pendingCreate; store();
      hideMatchStartModal();
      const keepCurrent = createOnly && developer && room && !['ended', 'mounted'].includes(room.state);
      if (!keepCurrent) accept(result.room);
      if (!createOnly) await action('/start');
      else showToast('等待房间已创建，可在比赛列表中查看');
      if ($('roomModal') && !$('roomModal').classList.contains('modal-hide')) await refreshList();
    });
  }
  async function finish() {
    if (isOffline() && !room) {
      resetOfflineTimer();
      return;
    }
    if (!room) {
      if (typeof activeMatch === 'undefined' || !activeMatch || activeMatch.endedAt) return;
      const score = currentMatchScores();
      if (!confirm(`确认结束？红方 ${score.red}，蓝方 ${score.blue} 分。`)) return;
      pauseStopwatch();
      activeMatch.elapsedSeconds = stopwatchSeconds;
      activeMatch.endedAt = new Date().toISOString();
      if (typeof saveActiveMatch === 'function') saveActiveMatch();
      status('已在本地结束');
      chrome();
      return;
    }
    if (!room.canControl || !confirm(`确认结束？红方 ${currentMatchScores().red}，蓝方 ${currentMatchScores().blue} 分。`)) return;
    await run(() => action('/end', { board: collectBoard(), scores: currentMatchScores() }));
  }
  async function pauseMatch() {
    if (isOffline() && !room) {
      pauseOfflineTimer();
      return;
    }
    if (room?.canControl && ['waiting', 'playing', 'countdown'].includes(room.state)) {
      await run(() => action('/mount'));
      showToast('比赛已挂载并暂停');
      return;
    }
    if (!room && typeof activeMatch !== 'undefined' && activeMatch && !activeMatch.endedAt) {
      pauseStopwatch();
      showToast('计时已暂停');
      chrome();
      return;
    }
    showToast('当前没有可暂停的比赛');
  }
  async function refreshList() {
    const data = await api('/list');
    listing = data.rooms; developer = data.developer;
    $('roomCards').innerHTML = ['waiting', 'countdown', 'playing', 'mounted', 'ended'].map(state => {
      const rows = listing.filter(r => r.state === state).sort((a, b) => b.updatedAt - a.updatedAt);
      return `<section class="room-section"><h3 class="room-section-title">${states[state]}（${rows.length}）</h3>`
        + (rows.length ? rows.map(r => `<article class="room-card">
        <div class="room-card-title"><strong>${esc(r.match.left.name)} vs ${esc(r.match.right.name)}</strong><span>${r.scores.red} : ${r.scores.blue}</span></div>
        <p class="room-card-meta">裁判：${esc(r.match.referee.title)} · 用时 ${clock(r.elapsed_seconds)} · ${r.members.length}/10 人</p>
        <div class="room-card-actions">
          <button type="button" class="modal-btn" data-room="${r.id}" data-op="detail">详情</button>
          ${!['mounted', 'ended'].includes(state) ? `<button type="button" class="modal-btn btn-confirm" data-room="${r.id}" data-op="join">加入</button>` : ''}
          ${state === 'mounted' ? `<button type="button" class="modal-btn btn-theme-blue" data-room="${r.id}" data-op="takeover">接管</button>` : ''}
          ${state === 'ended' && r.canControl ? `<button type="button" class="modal-btn" data-room="${r.id}" data-op="remount">重新挂载</button>` : ''}
          ${(state === 'mounted' || state === 'ended') && (developer || r.isHost) ? `<button type="button" class="modal-btn btn-cancel" data-room="${r.id}" data-op="delete">${state === 'ended' ? '删除记录' : '删除挂载'}</button>` : ''}
        </div>
      </article>`).join('') : '<p class="room-empty">暂无</p>')
        + '</section>';
    }).join('');
    if (room) $('roomMembers').innerHTML = room.members.map(m => `<div class="room-member">${esc(m.name)} · ${m.online ? '在线' : '离线'}${room.canControl && !m.isSelf ? ` <button type="button" class="modal-btn" data-member="${m.id}">移出</button>` : ''}</div>`).join('');
    else $('roomMembers').textContent = '尚未加入房间';
    chrome();
  }
  async function openList() {
    if (isOffline()) { showToast('单机模式已开启，比赛列表不可用'); return; }
    $('roomModal').classList.remove('modal-hide');
    await run(async () => {
      if (!connected) await connect();
      await refreshList();
    });
  }
  async function join(id) {
    if (room?.isHost && !['mounted', 'ended'].includes(room.state) && room.id !== id) throw new Error('请先结束或挂载当前裁判房间');
    const name = ($('setLocalUserName')?.value || saved.name || '观众').trim() || '观众';
    if (!saved.name && !$('setLocalUserName')?.value) {
      const typed = prompt('你的显示名字', name); if (!typed?.trim()) return;
      saved.name = typed.trim();
    } else {
      saved.name = name;
    }
    store();
    if ($('setLocalUserName')) $('setLocalUserName').value = saved.name;
    if (room && room.id !== id && !room.isHost) await api('/leave', { id: room.id });
    const data = await api('/join', { id, name });
    accept(data.room, true); $('roomModal').classList.add('modal-hide');
  }
  let detailRoomId = '';
  function durationText(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return `${Math.floor(sec / 3600)}小时${Math.floor(sec / 60) % 60}分${sec % 60}秒`;
  }
  function formatRoomDetail(r) {
    const m = r.match || {};
    const left = m.left || {};
    const right = m.right || {};
    const ref = m.referee || {};
    const scores = r.scores || {};
    const ended = r.state === 'ended';
    const del = { pending: '排队发送中', sent: '已发送', failed: '失败', unknown: '结果未确认，请核对 QQ 群' };
    const lines = [
      ended ? '🏁 Bingo 比赛结束' : `🎮 ${states[r.state] || 'Bingo 比赛'}`,
      `裁判：${ref.title || ''}`,
      `裁判直播间：${ref.room || '未设置'}`,
      `红方 ${left.name || '红方'}：${scores.red ?? 0} 分`,
      `蓝方 ${right.name || '蓝方'}：${scores.blue ?? 0} 分`,
      `${ended ? '比赛用时' : '比赛已进行'}：${durationText(r.elapsed_seconds)}`
    ];
    if (r.delivery?.start || r.delivery?.end) {
      lines.push('');
      if (r.delivery.start) lines.push(`开始播报：${del[r.delivery.start.status] || r.delivery.start.status}${r.delivery.start.error ? ' · ' + r.delivery.start.error : ''}`);
      if (r.delivery.end) lines.push(`结束播报：${del[r.delivery.end.status] || r.delivery.end.status}${r.delivery.end.error ? ' · ' + r.delivery.end.error : ''}`);
    }
    if (r.members?.length) {
      lines.push('', '成员：');
      r.members.forEach(mem => {
        lines.push(`· ${mem.name || '成员'}${mem.online ? '（在线）' : '（离线）'}${mem.isSelf ? '（我）' : ''}`);
      });
    }
    if (r.records?.length) {
      lines.push('', '记录：');
      r.records.forEach(rec => {
        lines.push(`· ${rec.action || '操作'}${rec.referee ? ' · ' + rec.referee : ''}`);
      });
    }
    return lines.join('\n');
  }
  async function card(e) {
    const b = e.target.closest('[data-op]'); if (!b) return;
    await run(async () => {
      const r = listing.find(r => r.id === b.dataset.room); if (!r) return;
      if (b.dataset.op === 'detail') {
        const area = $('roomDetailArea');
        const box = $('roomDetail');
        const open = area && !area.classList.contains('hide-room-detail');
        if (detailRoomId === r.id && open) {
          detailRoomId = '';
          if (box) box.textContent = '';
          if (area) area.classList.add('hide-room-detail');
          document.querySelectorAll('[data-op="detail"]').forEach(btn => btn.classList.remove('is-active'));
          return;
        }
        const data = await api('/get', { id: r.id });
        detailRoomId = r.id;
        if (box) box.textContent = formatRoomDetail(data.room);
        if (area) area.classList.remove('hide-room-detail');
        document.querySelectorAll('[data-op="detail"]').forEach(btn => {
          btn.classList.toggle('is-active', btn.dataset.room === r.id);
        });
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
      } else if (b.dataset.op === 'delete' && confirm(r.state === 'ended' ? '删除这场已结束比赛？' : '删除这场挂载比赛？')) {
        await deleteRoom(r.id);
        if (room?.id === r.id) { room = null; saved.room = ''; dirty = false; store(); chrome(); }
        showToast('已删除');
      }
      if (b.dataset.op !== 'detail') {
        detailRoomId = '';
        if ($('roomDetail')) $('roomDetail').textContent = '';
        if ($('roomDetailArea')) $('roomDetailArea').classList.add('hide-room-detail');
        await refreshList();
      }
    });
  }
  function buildUI() {
    const style = document.createElement('style');
    style.textContent = [
      '.timer-box-stopwatch .match-status,.timer-box-stopwatch #matchSyncStatus{display:none!important}',
      '#roomModal.modal-overlay{align-items:flex-start;overflow:auto;z-index:1100;padding:24px 16px}',
      '#roomModal .modal.room-modal{max-width:1000px;width:100%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;gap:12px;padding:20px 22px 18px}',
      '#roomModal .room-modal-head{display:flex;align-items:center;gap:12px;flex-shrink:0}',
      '#roomModal .room-modal-head .modal-title{flex:1;margin:0}',
      '#roomModal .room-modal-layout{flex:1;min-height:0;display:flex;align-items:stretch;gap:0}',
      '#roomModal .room-modal-body{flex:1;min-width:0;min-height:0;overflow:auto;padding-right:6px;display:flex;flex-direction:column;gap:14px}',
      '#roomModal .room-detail-area{flex-shrink:0;width:220px;min-width:200px;padding:0 4px 0 8px;border-left:1px solid #333;align-self:stretch;display:flex}',
      '#roomModal .room-detail-area.hide-room-detail{display:none!important}',
      '#roomModal .room-detail-panel{width:100%;display:flex;flex-direction:column;gap:8px;background:#1a1a1a;border:2px solid #333;border-radius:8px;padding:10px 8px;min-height:0;max-height:100%;overflow:hidden}',
      '#roomModal .room-detail-title{font-size:13px;color:#ffcc80;font-weight:bold;text-align:center;line-height:1.2;flex-shrink:0}',
      '#roomModal .room-toolbar,#roomModal .room-current-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '#roomModal .room-toolbar .modal-input{flex:1;min-width:160px;margin:0}',
      '#roomModal .room-section{margin-top:4px}',
      '#roomModal .room-section-title{margin:12px 0 8px;font-size:15px;color:#ffcc80}',
      '#roomModal .room-empty{margin:0;color:#888;font-size:13px}',
      '.room-card{padding:12px;margin:0 0 8px;border:1px solid #444;border-radius:8px;background:#16181c}',
      '.room-card-title{display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;align-items:center}',
      '.room-card-meta{margin:6px 0 0;color:#bbb;font-size:12px;line-height:1.5}',
      '.room-card-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}',
      '.room-card-actions .modal-btn{padding:6px 10px;font-size:12px}',
      '.room-member{display:flex;align-items:center;gap:8px;margin:4px 0;color:#ddd;font-size:13px}',
      '.room-readonly #grid{pointer-events:none;opacity:.85}',
      '.room-readonly .add-score-btn,.room-readonly .extra-score-btns,.room-readonly .btn-reset{pointer-events:none;opacity:.55}',
      '#roomDetail{white-space:pre-wrap;overflow:auto;margin:0;padding:0;background:transparent;border:none;font-size:13px;line-height:1.7;color:#ddd;font-family:inherit;flex:1;min-height:0}',
      '.room-card-actions .modal-btn.is-active{outline:1px solid #ffcc80}',
      '#roomMini{position:fixed;top:70px;left:30px;width:460px;height:420px;min-width:250px;min-height:250px;resize:both;overflow:auto;background:#16181c;border:1px solid #777;z-index:1200;padding:12px;border-radius:10px}',
      '#roomMiniBar{cursor:move;touch-action:none}',
      '#roomMiniGrid{display:grid;grid-template-columns:repeat(5,1fr);gap:3px;height:80%}',
      '#roomMiniGrid>div{padding:5px;overflow:hidden;display:flex;align-items:center;justify-content:center}'
    ].join('');
    document.head.append(style);
    const toolbar = $('btnsToolbar');
    if (toolbar) {
      toolbar.classList.remove('bt-has-room-row');
      const staleStatus = $('btRoomStatus');
      if (staleStatus) staleStatus.remove();
      const btns = toolbar.querySelector('.btns') || toolbar;
      const row = $('btRoomBtnRow');
      if (row) {
        row.querySelectorAll('button').forEach(btn => {
          if (btn.id === 'beginMatchBtn' || btn.id === 'endMatchBtn' || btn.id === 'roomMiniBtn') { btn.remove(); return; }
          btns.appendChild(btn);
        });
        row.remove();
      }
      const miniBtn = $('roomMiniBtn');
      if (miniBtn) miniBtn.remove();
      if (!$('roomListBtn')) {
        const list = document.createElement('button');
        list.type = 'button'; list.className = 'btn-set bt-room-btn'; list.id = 'roomListBtn'; list.textContent = '比赛列表';
        btns.appendChild(list);
      }
      if (!$('roomMiniBtn')) {
        const miniButton = document.createElement('button');
        miniButton.type = 'button'; miniButton.className = 'btn-set bt-room-btn'; miniButton.id = 'roomMiniBtn'; miniButton.textContent = '小窗';
        btns.appendChild(miniButton);
      }
    }
    const wrap = $('bingoTableWrap');
    if (wrap) wrap.classList.remove('bt-has-room-row');
    if ($('roomModal')) $('roomModal').remove();
    if ($('roomMini')) $('roomMini').remove();
    const root = document.createElement('div');
    root.innerHTML = `<div id="roomModal" class="modal-overlay modal-hide"><div class="modal room-modal">
      <div class="room-modal-head"><h2 class="modal-title">比赛列表</h2><button type="button" class="modal-btn btn-cancel" id="roomClose">关闭</button></div>
      <div class="room-modal-layout">
        <div class="room-modal-body">
          <p class="crop-hint" style="margin:0">公开使用，无需密钥。房间、挂载与历史仅保存在服务器内存，重启后清空。</p>
          <div class="room-toolbar">
            <button type="button" class="modal-btn btn-confirm" id="roomRefresh">刷新 / 重连</button>
            <button type="button" class="modal-btn btn-theme-blue" id="roomCreate">创建等待房间</button>
          </div>
          <div class="set-ui-card">
            <div class="set-ui-card-label">当前房间</div>
            <div class="room-current-actions" style="margin-top:8px">
              <button type="button" class="modal-btn" id="roomMount">挂载并暂停</button>
              <button type="button" class="modal-btn btn-cancel" id="roomDelete">删除当前房间</button>
              <button type="button" class="modal-btn btn-cancel" id="roomLeave">离开当前房间</button>
            </div>
            <div id="roomMembers" style="margin-top:10px"></div>
            <div class="room-current-actions" style="margin-top:10px">
              <button type="button" class="modal-btn" id="roomRetryStart">重试失败的开始通知</button>
              <button type="button" class="modal-btn" id="roomRetryEnd">重试失败的结束通知</button>
            </div>
          </div>
          <div id="roomCards"></div>
        </div>
        <div class="room-detail-area hide-room-detail" id="roomDetailArea">
          <div class="room-detail-panel">
            <div class="room-detail-title">比赛详情</div>
            <pre id="roomDetail"></pre>
          </div>
        </div>
      </div>
    </div></div><div id="roomMini" hidden><div id="roomMiniBar"><b>比赛小窗（拖动）</b> <button type="button" id="roomMiniClose">关闭</button> <button type="button" id="roomPin">置顶</button>
      <input type="number" id="roomFont" value="18" min="8" max="72" aria-label="小窗字体" style="width:52px"></div><p id="roomMiniTitle"></p><div id="roomMiniGrid"></div></div>`;
    document.body.append(root);
    const on = (id, fn) => { const node = $(id); if (node) node.onclick = fn; };
    on('roomListBtn', openList);
    on('beginMatchBtn', () => {
      if (isOffline() && !room) { startOfflineTimer(); return; }
      form(false);
    });
    on('endMatchBtn', finish);
    on('endLocalOnlyBtn', () => typeof endMatchLocally === 'function' && endMatchLocally());
    on('roomClose', () => $('roomModal').classList.add('modal-hide'));
    on('roomMiniBtn', toggleMini); on('roomMiniClose', toggleMini);
    on('roomPin', () => { pinned = !pinned; window.runtime?.WindowSetAlwaysOnTop?.(pinned); });
    if ($('roomPin')) $('roomPin').disabled = !window.runtime?.WindowSetAlwaysOnTop;
    if ($('roomPin')) $('roomPin').title = '桌面版支持窗口置顶';
    if ($('roomFont')) $('roomFont').oninput = () => { $('roomMiniGrid').style.fontSize = Math.max(8, Math.min(72, Number($('roomFont').value))) + 'px'; };
    let drag;
    if ($('roomMiniBar')) $('roomMiniBar').onpointerdown = e => {
      if (e.target.closest('button,input')) return;
      drag = { x: e.clientX, y: e.clientY, left: $('roomMini').offsetLeft, top: $('roomMini').offsetTop };
      $('roomMiniBar').setPointerCapture(e.pointerId);
    };
    if ($('roomMiniBar')) $('roomMiniBar').onpointermove = e => {
      if (!drag) return;
      $('roomMini').style.left = Math.max(0, Math.min(innerWidth - 100, drag.left + e.clientX - drag.x)) + 'px';
      $('roomMini').style.top = Math.max(0, Math.min(innerHeight - 50, drag.top + e.clientY - drag.y)) + 'px';
    };
    if ($('roomMiniBar')) $('roomMiniBar').onpointerup = () => { drag = null; };
    on('roomRefresh', () => run(async () => { await connect(); await refreshList(); }));
    on('roomCreate', () => { $('roomModal').classList.add('modal-hide'); form(true); });
    if ($('roomCards')) $('roomCards').onclick = card;
    on('roomMount', () => run(() => action('/mount')));
    on('roomDelete', () => run(async () => {
      if (!room) return;
      if (!(room.isHost || (developer && ['mounted', 'ended'].includes(room.state)))) {
        throw new Error('只有裁判可以删除当前房间，或管理员删除挂载/已结束房间');
      }
      const label = states[room.state] || room.state;
      if (!confirm(`确认删除当前房间（${label}）？删除后无法恢复。`)) return;
      const id = room.id;
      await deleteRoom(id);
      room = null; saved.room = ''; dirty = false; store(); pauseStopwatch(); chrome();
      showToast('房间已删除');
      if ($('roomModal') && !$('roomModal').classList.contains('modal-hide')) await refreshList();
    }));
    on('memoConnReconnect', () => run(async () => {
      if (isOffline()) throw new Error('请先在全局设置关闭单机模式');
      await connect();
      status('已连接 · ' + service().replace(/^https?:\/\//, ''));
      showToast('已重新连接');
    }));
    on('pauseMatchBtn', () => { pauseMatch(); });
    on('roomLeave', () => run(async () => {
      await action('/leave'); previousRoom = saved.room; room = null; saved.room = ''; dirty = false; store(); pauseStopwatch(); chrome(); await refreshList();
    }));
    if ($('roomMembers')) $('roomMembers').onclick = e => { const id = e.target.dataset.member; if (id) run(() => action('/kick', { member: id })); };
    on('roomRetryStart', () => run(() => action('/retry', { kind: 'start' })));
    on('roomRetryEnd', () => run(() => action('/retry', { kind: 'end' })));
    on('roomDevLogin', () => run(async () => {
      if (isOffline()) throw new Error('请先关闭单机模式再验证管理员');
      if (!connected) await connect();
      await api('/dev-auth', { code: $('roomDevCode').value }); $('roomDevCode').value = ''; developer = true;
      const data = await api('/dev/settings');
      $('roomAutoEnabled').checked = data.settings.enabled; $('roomAutoInterval').value = data.settings.interval;
      if (typeof switchSetTab === 'function') switchSetTab('room');
      chrome();
      showToast('管理员已开启');
    }));
    on('roomDevLogout', () => run(async () => { await api('/dev/logout'); developer = false; chrome(); showToast('管理员已关闭'); }));
    on('roomAutoSave', () => run(async () => {
      await api('/dev/settings', { enabled: $('roomAutoEnabled').checked, interval: Number($('roomAutoInterval').value) }); showToast('服务端定时播报设置已保存');
    }));
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
  window.showMatchStartModal = () => {
    if (isOffline() && !room) { startOfflineTimer(); return; }
    form(false);
  };
  window.saveAndStartMatch = create;
  window.endCurrentMatch = finish;
  window.syncMatchScore = schedule;
  window.updateMatchStatus = chrome;
  function setOfflineMode(on) {
    saved.offlineMode = !!on;
    store();
    if (saved.offlineMode) {
      connected = false;
      connecting = null;
      if ($('matchStartModal')) $('matchStartModal').classList.add('modal-hide');
      status('单机模式：不连接服务器');
      chrome();
      return;
    }
    chrome();
    connect().then(() => {
      status('已连接 · ' + service().replace(/^https?:\/\//, ''));
      showToast('已连接服务器');
    }).catch(err => {
      status(err.message || '连接失败');
      showToast(err.message || '连接失败');
    });
  }
  window.addEventListener('load', () => {
    buildUI(); pauseStopwatch(); chrome();
    if (isOffline()) {
      status('单机模式：不连接服务器');
    } else {
      connect().then(() => {
        status('已连接 · ' + service().replace(/^https?:\/\//, ''));
      }).catch(err => {
        showToast(err.message || '连接服务器失败');
        status(err.message || '连接失败');
      });
    }
    armPoll();
    setInterval(() => { if (connected || isOffline()) chrome(); }, 250);
  });
  window.BingoRooms = {
    connect, openList, collectBoard, applyBoard, getRoom: () => room, isConnected: () => connected, serviceUrl: service,
    isDeveloper: () => developer, isOffline, setOfflineMode, pauseMatch,
    syncRosterFromServer, syncRosterToServer,
    setHint: (message, isErr) => {
      if (isErr) paintConn('is-err', connected ? '已连接' : '未连接', message || '', true);
      else if (isOffline()) paintConn('is-off', '单机模式', message || '未连接服务器，仅本地使用');
      else if (connected) paintConn('is-ok', '已连接', message || service().replace(/^https?:\/\//, ''));
      else paintConn('is-err', '未连接', message || '', true);
    },
    setLocalName: name => { saved.name = String(name || '').trim(); store(); }
  };
})();
