import test from 'node:test';
import assert from 'node:assert/strict';

// 独立测试进程模拟 Render，不读取用户本地密钥，也不连接 QQ / Supabase。
Object.assign(process.env, {
  RENDER: 'true', RENDER_EXTERNAL_URL: 'https://bingo.example.test',
  PUBLIC_BASE_URL: '', ALLOWED_ORIGINS: 'http://localhost:8000',
  QQ_APP_ID: 'mock-app', QQ_APP_SECRET: 'mock-app-secret',
  QQ_GROUP_OPENID: 'mock-group', BOT_CLIENT_KEY: 'mock-client-key',
  QQ_EVENTS_ENABLED: 'false', SUPABASE_DATABASE_URL: '', DATABASE_URL: ''
});
const { createServer } = await import('./server.mjs');

test('API-only hosting, authenticated sends, local HTML CORS and cloud storage requirement', async t => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  let sent = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith(base)) return realFetch(url, options);
    if (String(url) === 'https://bots.qq.com/app/getAppAccessToken') {
      return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 7200 }));
    }
    assert.equal(String(url), 'https://api.sgroup.qq.com/v2/groups/mock-group/messages');
    assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(), ['content', 'msg_type']);
    sent++;
    return new Response(JSON.stringify({ id: `mock-${sent}` }));
  });

  const page = await fetch(base);
  assert.equal(page.status, 200);
  const info = await page.json();
  assert.equal(info.mode, 'api-only');
  assert.doesNotMatch(JSON.stringify(info), /mock-client-key|mock-app-secret|mock-group/);
  for (const path of ['/bingotools-V17.html', '/.local-config.json', '/server.mjs', '/api/v1/qq/groups']) {
    assert.equal((await fetch(base + path)).status, 401);
  }
  const headers = {
    Authorization: 'Bearer mock-client-key',
    Origin: 'http://localhost:8000', 'Content-Type': 'application/json'
  };
  const preflight = await fetch(base + '/api/v1/qq/test', {
    method: 'OPTIONS', headers: { Origin: headers.Origin, 'Access-Control-Request-Method': 'POST' }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), headers.Origin);
  assert.equal((await fetch(base + '/health', { headers: { Origin: 'https://untrusted.example' } })).status, 403);

  const body = JSON.stringify({ referee: { room: '123', title: 'test' } });
  const sendTest = () => fetch(base + '/api/v1/qq/test', { method: 'POST', headers, body });
  assert.equal((await fetch(base + '/api/v1/qq/test', { method: 'POST', body })).status, 401);
  assert.equal(sent, 0);
  assert.equal((await sendTest()).status, 200);
  assert.equal(sent, 1);
  const match = await fetch(base + '/api/v1/matches/start', {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': 'cloud-match-123' }, body
  });
  assert.equal(match.status, 503);
  assert.match((await match.json()).error, /数据库未就绪/);
  assert.equal(sent, 1);
  for (let i = 1; i < 12; i++) assert.equal((await sendTest()).status, 200);
  assert.equal((await sendTest()).status, 429);
  assert.equal(sent, 12);
});
