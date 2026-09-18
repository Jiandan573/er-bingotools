import './local-config.mjs';

const key = process.env.BOT_CLIENT_KEY;
if (!key) {
  console.error('请先运行 npm run setup');
  process.exitCode = 1;
} else {
  try {
    for (const path of ['status', 'groups']) {
      const response = await fetch(`http://127.0.0.1:${Number(process.env.PORT || 8787)}/api/v1/qq/${path}`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000)
      });
      const data = await response.json();
      console.log(JSON.stringify(data, null, 2));
      if (!response.ok) process.exitCode = 1;
    }
  } catch {
    console.error('无法连接本地服务，请先在另一个终端运行 npm start');
    process.exitCode = 1;
  }
}
