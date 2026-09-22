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
test('countdown, atomic takeover, frozen time, end dedupe and history reset', async () => {
  const t = setup(); let r = t.create();
  r = t.call('/start', { id: r.id, revision: r.rev }).room;
  assert.equal(r.state, 'countdown'); assert.equal(t.sent.length, 0);
  t.call('/start', { id: r.id, revision: r.rev }); t.advance(5000); await microtasks();
  assert.equal(t.sent.length, 1);
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
  assert.doesNotMatch(t.sent.join(''), /识别码|比赛编号|直播间标题/);
  assert.equal(r.elapsed_seconds, 13); assert.equal(t.rooms.current(), '');
  const fresh = t.call('/remount', { id: r.id, request_id: 'remount-1' }, t.guest).room;
  assert.notEqual(fresh.id, r.id); assert.equal(fresh.elapsed_seconds, 0);
  assert.equal(t.call('/remount', { id: r.id, request_id: 'remount-1' }, t.guest).room.id, fresh.id);
});
test('notification failure preserves game; uncertain delivery is not retried', async () => {
  const t = setup(async () => { throw Object.assign(new Error('timeout'), { uncertain: true }); });
  let r = t.create(); t.call('/start', { id: r.id, revision: r.rev }); t.advance(5000); await microtasks();
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
test('one active host, IP limit, and server-only periodic summary', async () => {
  const t = setup(); let r = t.create();
  assert.throws(t.create, /已有/);
  t.call('/dev-auth', { code: 'test-dev' });
  t.call('/dev/settings', { enabled: true, interval: 5 });
  t.advance(300000); await microtasks(); assert.equal(t.sent.length, 0);
  t.call('/start', { id: r.id, revision: r.rev }); t.advance(5000); await microtasks();
  t.advance(300000); await microtasks(); assert.equal(t.sent.length, 2);
  assert.match(t.sent[1], /正在进行/);
  const x = setup();
  for (let i = 0; i < 5; i++) {
    const token = x.session('session' + i);
    x.call('/create', { match, board: board(), scores: { red: 0, blue: 0 } }, token, 'same-ip');
  }
  assert.throws(() => x.call('/create', { match, board: board(), scores: { red: 0, blue: 0 } }, x.guest, 'same-ip'), /频繁/);
});
test('bounded notification queue serializes senders and reports overflow', async () => {
  let release; const order = [];
  const q = new NotificationQueue(async n => { order.push(n); if (n === 1) await new Promise(r => { release = r; }); }, { interval: 0, limit: 2 });
  const a = q.enqueue(1); const b = q.enqueue(2);
  await assert.rejects(q.enqueue(3), /队列已满/); await microtasks();
  assert.deepEqual(order, [1]); release(); await Promise.all([a, b]); assert.deepEqual(order, [1, 2]);
});
