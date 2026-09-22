import { readFile } from 'node:fs/promises';

// 本地文件的值只补充环境变量；Render 环境变量始终优先。
try {
  const config = process.env.RENDER ? {} :
    JSON.parse(await readFile(new URL('./.local-config.json', import.meta.url), 'utf8'));
  for (const key of ['QQ_APP_ID', 'QQ_APP_SECRET', 'QQ_GROUP_OPENID', 'BOT_CLIENT_KEY',
    'QQ_EVENTS_ENABLED', 'HOST', 'PORT', 'ALLOWED_ORIGINS', 'BINGOTOOLS_DEV_CODE']) {
    if (typeof config[key] === 'string' && process.env[key] === undefined) process.env[key] = config[key];
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error('本地配置读取失败，请重新运行 npm run setup');
}
