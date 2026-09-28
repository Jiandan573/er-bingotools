import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT || 8000);
const UPSTREAM = String(process.env.QQBOT_UPSTREAM || 'https://bingotools-qqbot-api.onrender.com').replace(/\/+$/, '');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function proxyToUpstream(req, res, pathname, search) {
  const targetPath = pathname.slice('/qqbot'.length) || '/';
  const targetUrl = UPSTREAM + targetPath + (search || '');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
      'Cache-Control': 'no-store'
    });
    res.end();
    return;
  }
  const headers = {
    Accept: req.headers.accept || 'application/json',
    'User-Agent': 'BingoTools-local-proxy'
  };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  if (req.headers['idempotency-key']) headers['Idempotency-Key'] = req.headers['idempotency-key'];
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  let upstream;
  try {
    upstream = await fetch(targetUrl, { method: req.method, headers, body, redirect: 'follow' });
  } catch (err) {
    const message = JSON.stringify({ ok: false, error: '本地代理无法连接云端：' + (err.message || err) });
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(message);
    return;
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  const outHeaders = {
    'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  res.writeHead(upstream.status, outHeaders);
  res.end(buf);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/qqbot' || pathname.startsWith('/qqbot/')) {
      await proxyToUpstream(req, res, pathname, url.search);
      return;
    }
    if (pathname === '/') pathname = '/bingotools.html';
    const file = normalize(join(root, pathname));
    if (!file.startsWith(root)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${port}/bingotools.html`);
  console.log(`房间服务同源代理: http://127.0.0.1:${port}/qqbot  →  ${UPSTREAM}`);
  console.log('Chrome 请走上面的本地地址；不要双击 HTML。');
});
