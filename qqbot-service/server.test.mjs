import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMatchMessage, validateMatchPayload, liveRoomAddress } from './server.mjs';

test('validateMatchPayload requires referee room and title', () => {
  assert.throws(
    () => validateMatchPayload({ referee: { room: '123' } }),
    /referee.title is required/
  );
});

test('formatMatchMessage contains referee and players without rules or match id', () => {
  const match = validateMatchPayload({
    started_at: '2026-09-18T12:00:00Z',
    referee: { room: '123456', title: '裁判直播' },
    left: { name: '红方选手', platform: 'bilibili', room: '111', title: '红方直播' },
    right: { name: '蓝方选手', platform: 'douyin', room: '222', title: '蓝方直播' }
  });
  const message = formatMatchMessage(match);
  assert.match(message, /比赛时间：2026-09-18 20:00（北京时间）/);
  assert.match(message, /裁判直播间：https:\/\/live.bilibili.com\/123456/);
  assert.match(message, /https:\/\/live.bilibili.com\/111/);
  assert.match(message, /https:\/\/live.douyin.com\/222/);
  assert.match(message, /红方：红方选手/);
  assert.match(message, /蓝方：蓝方选手/);
  assert.match(message, /裁判：裁判直播/);
  assert.doesNotMatch(message, /rules|比赛编号|match_id|直播间标题|红方直播|蓝方直播/);
  const preview = formatMatchMessage(match, { test: true });
  assert.match(preview, /比赛播报（测试）/);
  assert.doesNotMatch(preview, /比赛开始/);
});

test('live addresses preserve full links, support referee platform and reject ambiguous rooms', () => {
  assert.equal(liveRoomAddress('douyin', 'https://live.douyin.com/abc'), 'https://live.douyin.com/abc');
  assert.equal(liveRoomAddress('bilibili', ''), '未设置');
  assert.equal(liveRoomAddress('local', 'camera'), '本地采集（无直播间地址）');
  assert.throws(() => liveRoomAddress('unknown', '123'), /正确平台/);
  assert.throws(() => liveRoomAddress('bilibili', 'javascript:alert(1)'), /正确平台/);
  const match = validateMatchPayload({ referee: { room: '456', title: 'test', platform: 'douyin' } });
  assert.match(formatMatchMessage(match), /裁判直播间：https:\/\/live.douyin.com\/456/);
});
