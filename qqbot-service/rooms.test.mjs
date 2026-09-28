import test from 'node:test';
import assert from 'node:assert/strict';
import { Rooms, NotificationQueue } from './rooms.mjs';
import { validateMatchPayload, formatMatchMessage, liveRoomAddress } from './server.mjs';

const board = () => ({
  red: Array(25).fill(false), blue: Array(25).fill(false), first: Array(25).fill(null),
  marks: Array.from({ length: 25 }, () => []), redTime: Array(25).fill(0), blueTime: Array(25).fill(0),
  redName: '红甲', blueName: '蓝乙', settle1: 0, settle2: 0, extra1: 0, extra2: 0
});
const match = { referee: { title: '裁判甲', room: '123', platform: 'bilibili' }, left: { name: '红甲', platform: 'bilibili', room: '456' }, right: { name: '蓝乙', platform: 'douyin', room: '789' } };
const microtasks = () => new Promise(resolve => setImmediate(resolve));
function setup(send) {
  let time = 1000000;
  const sent = [];
  const rooms = new Rooms({ send: send || (async text => sent.push(text)), normalize: validateMatchPayload,
    formatStart: formatMatchMessage, address: liveRoomAddress, devCode: 'test-dev', now: () => time });
  const session = ip => rooms.handle('/session', {}, '', ip).token;
  const host = session('a'), guest = session('b');
  const call = (path, body = {}, token = host, ip = 'a') => rooms.handle(path, body, token, ip);
  const create = () => call('/create', { match, board: board(), scores: { red: 0, blue: 0 } }).room;
  return { rooms, sent, host, guest, call, create, advance: ms => { time += ms; rooms.tick(); }, session };
}
test('public sessions, server-owned roles, CAS and fixed referee labels', () => {
  const t = setup(); const r = t.create();
  assert.equal(r.isHost, true);
  let joined = t.call('/join', { id: r.id, name: '观众' }, t.guest).room;
  assert.equal(joined.canControl, false);
  assert.throws(() => t.call('/update', { id: r.id, revision: joined.rev, role: 'host', board: board(), scores: { red: 999, blue: 0 } }, t.guest), /裁判/);
  const updated = t.call('/update', { id: r.id, revision: joined.rev, board: board(), scores: { red: 3, blue: 2 } }).room;
  assert.throws(() => t.call('/update', { id: r.id, revision: r.rev, board: board(), scores: { red: 1, blue: 0 } }), /已更新/);
  assert.equal(updated.scores.red, 3);
  assert.throws(() => t.call('/dev/settings', { enabled: true, interval: 5 }), /开发者/);
  assert.throws(() => t.call('/dev-auth', { code: 'wrong' }), /错误/);
  t.call('/dev-auth', { code: 'test-dev' });
  assert.throws(() => t.call('/dev/settings', { enabled: true, interval: 1 }), /间隔/);
  assert.equal(t.call('/dev/settings', { enabled: true, interval: 5 }).settings.enabled, true);
  t.advance(8 * 3600000 + 1);
  assert.throws(() => t.call('/dev/settings'), /开发者/);
});
test('shared roster is readable by users and writable only by developer', () => {
  const t = setup();
  assert.deepEqual(t.call('/roster', {}, t.guest).roster, []);
  assert.throws(() => t.call('/roster/push', { entries: [{ name: '红甲', id: '123' }] }, t.guest), /开发者/);
  t.call('/dev-auth', { code: 'test-dev' });
  let result = t.call('/roster/push', { entries: [
    { name: '红甲', id: '123', updatedAt: 1 },
    { name: '红甲新名字', platform: 'bilibili', source: 'https://live.bilibili.com/123/', updatedAt: 2 },
    { name: '本地选手', platform: 'local', source: 'local' },
    { name: '无来源选手' }
  ] });
  assert.equal(result.added, 3);
  assert.equal(result.updated, 1);
  assert.equal(result.roster.length, 3);
  assert.equal(result.roster.find(x => x.platform === 'bilibili').name, '红甲新名字');
  const guestView = t.call('/roster', {}, t.guest).roster;
  assert.equal(guestView.length, 3);
  assert.equal(guestView.some(x => x.platform === 'local' && x.source === 'local'), true);
});
test('start notify, atomic takeover, frozen time, end dedupe and history reset', async () => {
  const t = setup(); let r = t.create();
  r = t.call('/start', { id: r.id, revision: r.rev }).room;
  assert.equal(r.state, 'playing');
  await microtasks(); assert.equal(t.sent.length, 1);
  t.call('/start', { id: r.id, revision: r.rev });
  await microtasks(); assert.equal(t.sent.length, 1);
  t.advance(12000);
  r = t.call('/get', { id: r.id }).room;
  assert.equal(r.elapsed_seconds, 12);
  r = t.call('/mount', { id: r.id, revision: r.rev }).room;
  t.advance(60000); assert.equal(t.call('/get', { id: r.id }).room.elapsed_seconds, 12);
  r = t.call('/takeover', { id: r.id, revision: r.rev, referee: { ...match.referee, title: '裁判乙' } }, t.guest).room;
  assert.equal(r.isHost, true); assert.equal(r.match.referee.title, '裁判乙');
  assert.throws(() => t.call('/takeover', { id: r.id, revision: r.rev, referee: match.referee }), /接管/);
  assert.throws(() => t.call('/end', { id: r.id, revision: r.rev, board: board(), scores: { red: 0, blue: 0 } }), /裁判/);
  t.advance(1000);
  r = t.call('/end', { id: r.id, revision: r.rev, board: board(), scores: { red: 8, blue: 7 } }, t.guest).room;
  t.call('/end', { id: r.id, revision: 0 }, t.guest);
  await microtasks(); assert.equal(t.sent.length, 2);
  assert.match(t.sent[1], /裁判：裁判乙/); assert.match(t.sent[1], /8 分/);
  assert.doesNotMatch(t.sent.join(''), /识别码：/);
  assert.doesNotMatch(t.sent.join(''), /比赛编号|直播间标题/);
  assert.equal(r.elapsed_seconds, 13); assert.equal(t.rooms.current(), '');
  const fresh = t.call('/remount', { id: r.id, request_id: 'remount-1' }, t.guest).room;
  assert.notEqual(fresh.id, r.id); assert.equal(fresh.elapsed_seconds, 0);
  assert.equal(fresh.state, 'mounted');
  assert.throws(() => t.call('/get', { id: r.id }, t.guest), /不存在/);
  assert.equal(t.call('/list', {}, t.guest).rooms.some(x => x.id === r.id), false);
  assert.equal(t.call('/list', {}, t.guest).rooms.some(x => x.id === fresh.id && x.state === 'mounted'), true);
  assert.equal(t.call('/remount', { id: r.id, request_id: 'remount-1' }, t.guest).room.id, fresh.id);
});
test('notification failure preserves game; uncertain delivery is not retried', async () => {
  const t = setup(async () => { throw Object.assign(new Error('timeout'), { uncertain: true }); });
  let r = t.create(); t.call('/start', { id: r.id, revision: r.rev }); await microtasks();
  r = t.call('/get', { id: r.id }).room;
  assert.equal(r.state, 'playing'); assert.equal(r.delivery.start.status, 'unknown');
  assert.throws(() => t.call('/retry', { id: r.id, kind: 'start' }), /未知/);
});
test('presence, member cap, kick and session expiry after instance restart', () => {
  const t = setup(); let r = t.create();
  for (let i = 0; i < 9; i++) t.call('/join', { id: r.id, name: '观众' + i }, t.session('guest' + i));
  assert.throws(() => t.call('/join', { id: r.id, name: '满员' }, t.guest), /已满/);
  t.advance(31000); r = t.call('/get', { id: r.id }).room;
  assert.equal(r.members.every(m => !m.online), true);
  const other = t.rooms.sessions.keys().toArray?.() || [...t.rooms.sessions.keys()];
  const member = r.members[1].id;
  t.call('/kick', { id: r.id, revision: r.rev, member });
  assert.throws(() => t.call('/heartbeat', { id: r.id }, other[2]), /移出/);
  const reset = setup();
  assert.notEqual(t.rooms.instance, reset.rooms.instance);
  assert.throws(() => reset.rooms.handle('/list', {}, t.host), /失效/);
});
test('one active host, admin multi-room, IP limit, and server-only periodic summary', async () => {
  const t = setup(); let r = t.create();
  assert.throws(t.create, /已有/);
  t.call('/dev-auth', { code: 'test-dev' });
  const second = t.create();
  assert.notEqual(second.id, r.id);
  t.call('/dev/settings', { enabled: true, interval: 5 });
  t.advance(300000); await microtasks(); assert.equal(t.sent.length, 0);
  t.call('/start', { id: r.id, revision: r.rev }); await microtasks();
  assert.equal(t.sent.length, 1);
  t.advance(300000); await microtasks(); assert.equal(t.sent.length, 2);
  assert.doesNotMatch(t.sent[0], /识别码：/);
  assert.match(t.sent[1], /正在进行/);
  assert.doesNotMatch(t.sent[1], /识别码：/);
  t.call('/dev-auth', { code: 'test-dev' });
  const ended = t.call('/end', { id: r.id, revision: t.call('/get', { id: r.id }).room.rev, board: board(), scores: { red: 1, blue: 0 } }).room;
  assert.equal(ended.state, 'ended');
  // 删除不依赖 revision（列表 rev 过期时仍可删）
  t.call('/delete', { id: ended.id });
  assert.throws(() => t.call('/get', { id: ended.id }), /不存在/);
  const x = setup();
  for (let i = 0; i < 5; i++) {
    const token = x.session('session' + i);
    x.call('/create', { match, board: board(), scores: { red: 0, blue: 0 } }, token, 'same-ip');
  }
  assert.throws(() => x.call('/create', { match, board: board(), scores: { red: 0, blue: 0 } }, x.guest, 'same-ip'), /频繁/);
});
test('host can delete own room; admin can delete others ended; guest cannot', () => {
  const t = setup();
  const waiting = t.create();
  assert.throws(() => t.call('/delete', { id: waiting.id }, t.guest), /裁判/);
  t.call('/delete', { id: waiting.id });
  assert.throws(() => t.call('/get', { id: waiting.id }), /不存在/);

  const hostRoom = t.create();
  t.call('/start', { id: hostRoom.id, revision: hostRoom.rev });
  const playing = t.call('/get', { id: hostRoom.id }).room;
  t.call('/delete', { id: playing.id });
  assert.throws(() => t.call('/get', { id: playing.id }), /不存在/);

  const shared = setup();
  const owned = shared.create();
  const ended = shared.call('/end', {
    id: owned.id, revision: owned.rev, board: board(), scores: { red: 2, blue: 1 }
  }).room;
  const adminToken = shared.session('admin-ip');
  shared.call('/dev-auth', { code: 'test-dev' }, adminToken, 'admin-ip');
  shared.call('/delete', { id: ended.id }, adminToken, 'admin-ip');
  assert.throws(() => shared.call('/get', { id: ended.id }, adminToken, 'admin-ip'), /不存在/);

  const live = setup();
  const active = live.create();
  const admin2 = live.session('adm2');
  live.call('/dev-auth', { code: 'test-dev' }, admin2, 'adm2');
  assert.throws(() => live.call('/delete', { id: active.id }, admin2, 'adm2'), /挂载或已结束/);
});
test('bounded notification queue serializes senders and reports overflow', async () => {
  let release; const order = [];
  const q = new NotificationQueue(async n => { order.push(n); if (n === 1) await new Promise(r => { release = r; }); }, { interval: 0, limit: 2 });
  const a = q.enqueue(1); const b = q.enqueue(2);
  await assert.rejects(q.enqueue(3), /队列已满/); await microtasks();
  assert.deepEqual(order, [1]); release(); await Promise.all([a, b]); assert.deepEqual(order, [1, 2]);
});
