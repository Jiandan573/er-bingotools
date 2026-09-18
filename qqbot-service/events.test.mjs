import test from 'node:test';
import assert from 'node:assert/strict';
import { QQEvents } from './events.mjs';

class FakeSocket extends EventTarget {
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.dispatchEvent(new Event('close')); }
  receive(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
}

async function receiver(t) {
  const events = new QQEvents({
    connectInfo: async () => ({ url: 'wss://qq.example.test', token: 'test-token' }),
    Socket: FakeSocket, log: () => {}
  });
  events.stopped = false;
  await events.connect();
  t.after(() => events.stop());
  return events;
}

test('Hello → Identify → Ready; group event exposes no message content or author', async t => {
  const events = await receiver(t);
  const socket = events.socket;
  socket.receive({ op: 10, d: { heartbeat_interval: 30000 } });
  assert.deepEqual(socket.sent[0], {
    op: 2, d: { token: 'QQBot test-token', intents: 33554432, shard: [0, 1] }
  });
  socket.receive({ op: 0, s: 1, t: 'READY', d: { session_id: 'session' } });
  assert.equal(events.status().state, 'ready');
  socket.receive({ op: 0, s: 2, t: 'GROUP_AT_MESSAGE_CREATE',
    d: { group_openid: 'group1', id: 'msg1', content: 'private', author: { id: 'user' } } });
  assert.equal(events.listGroups()[0].group_openid, 'group1');
  assert.doesNotMatch(JSON.stringify(events.listGroups()), /private|author|msg1|user/);
  // Replayed delivery must not duplicate the discovered group.
  socket.receive({ op: 0, s: 2, t: 'GROUP_AT_MESSAGE_CREATE', d: { group_openid: 'group1', id: 'msg1' } });
  assert.equal(events.listGroups().length, 1);
});

test('resume uses previous session/sequence; invalid session clears both', async t => {
  const events = await receiver(t);
  events.session = 'resume-session';
  events.seq = 7;
  events.socket.receive({ op: 10, d: { heartbeat_interval: 30000 } });
  assert.deepEqual(events.socket.sent[0], { op: 6, d: {
    token: 'QQBot test-token', session_id: 'resume-session', seq: 7
  } });
  events.socket.receive({ op: 9, d: false });
  assert.equal(events.session, '');
  assert.equal(events.seq, null);
  assert.equal(events.state, 'reconnecting');
});

test('authentication failure halts retries; late socket events cannot restart a stopped client', async t => {
  const events = await receiver(t);
  const socket = events.socket;
  const closed = new Event('close');
  Object.defineProperty(closed, 'code', { value: 4004 });
  socket.dispatchEvent(closed);
  assert.equal(events.state, 'error');
  assert.equal(events.stopped, true);
  assert.equal(events.socket, null);
  socket.dispatchEvent(new Event('error'));
  assert.equal(events.state, 'error');
});

test('heartbeat timeout reconnects instead of reporting a stale ready connection', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const events = await receiver(t);
  const socket = events.socket;
  socket.receive({ op: 10, d: { heartbeat_interval: 1000 } });
  socket.receive({ op: 0, s: 3, t: 'READY', d: { session_id: 's' } });
  t.mock.timers.tick(1000);
  assert.deepEqual(socket.sent.at(-1), { op: 1, d: 3 });
  t.mock.timers.tick(1000);
  assert.equal(events.state, 'reconnecting');
});
