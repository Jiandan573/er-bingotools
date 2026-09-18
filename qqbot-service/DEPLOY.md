# Render 免费部署：固定 QQ 群

## 为什么上传代码

Mac 本地服务只在本机运行。要让其他人独立访问、Mac 关机后仍可用，需要云端运行
Node 服务。QQ AppSecret 必须留在该服务内，不能写进公开 HTML。
GitHub 是把程序交付给 Render 并更新的途径；代码本身可以公开，凭证不能公开。
无需将 Go/Wails 或 exe 部署到 Render，也无需再部署一个单独的网站。

## 本次配置：本地 HTML → Render API → QQ

- Node Web Service 只提供 Bot API；`/` 返回服务说明 JSON，不托管网页。
- HTML 留在本地，通过 HTTP 打开；测试与比赛播报需要 `BOT_CLIENT_KEY`。
- 所有人向同一个 `QQ_GROUP_OPENID` 播报。
- 每个运行实例所有使用者合计每分钟最多发起 12 次发送。
- 开启 WebSocket（`QQ_EVENTS_ENABLED=true`）接收 @查询；开始/结束仍为主动播报。
- 默认在内存保存比赛与比分，无需数据库；重启或重新部署会清空记录。
- 免费实例冷启动时网页请求最多等 90 秒；不自动重试发送，超时请先核对 QQ 群。
- Go/Wails 的直播解析/代理不在本服务中；正式 exe 接入留到后续阶段。

## 1. 上传这些文件

```text
render.yaml
qqbot-service/
  package.json
  package-lock.json
  server.mjs
  events.mjs
  matches.mjs
  local-config.mjs
  schema.sql
  ...测试及说明文件
```

不要上传 `.local-config.json`、`.env`、`node_modules` 或数据库连接密码。
更新提交后确认仓库首页存在 `qqbot-service`，且里面能看到 `package.json`、`server.mjs`。
本地 HTML 不需要上传到 Render。

## 2. 数据库可选

当前使用内存模式，无需配置 Supabase。需要重启后保留比赛记录时，才配置
`SUPABASE_DATABASE_URL`。配置了数据库但连接失败时，服务拒绝比赛请求，避免误记。
如需自定义可信证书，使用 `SUPABASE_CA_CERT`，不要关闭 TLS 校验。

## 3. 配置 Render

优先使用仓库根目录的 `render.yaml` 创建 Blueprint。也可修改已有 Web Service：

| 设置 | 值 |
| --- | --- |
| Runtime / Language | Node |
| Branch | master（当前仓库实际分支） |
| Root Directory | 留空 |
| Build Command | `npm --prefix qqbot-service ci` |
| Start Command | `npm --prefix qqbot-service start` |
| Health Check Path | `/health` |
| Instance Type | Free |

运行环境变量：

| 变量 | 配置 |
| --- | --- |
| NODE_VERSION | `24` |
| HOST | `0.0.0.0` |
| QQ_EVENTS_ENABLED | `true` |
| QQ_APP_ID | 现有机器人的 AppID |
| QQ_APP_SECRET | 现有机器人的密钥；仅管理员填写 |
| QQ_GROUP_OPENID | 已取得的固定群标识 |
| BOT_CLIENT_KEY | 使用者持有的独立使用密钥，Blueprint 可自动生成 |
| SUPABASE_DATABASE_URL | 可选；当前不填写 |

不要上传本地配置来代替 Render 环境变量。云端会忽略本地配置文件。
Render 自动提供 `PORT`。设置：

```text
ALLOWED_ORIGINS=http://localhost:8000,http://127.0.0.1:8000
```

需要允许其他调试网页时明确列入 `ALLOWED_ORIGINS`，不要使用 `*` 或 `null`。
Blueprint 不要求数据库。已有服务请手动把 QQ_EVENTS_ENABLED 更新为 true。

## 4. 验收

1. 部署日志显示 HTTP 服务启动，打开 Render 地址的 `/health`：
   `ok:true`、`qq_configured:true`。数据库暂未配置时 `database:"disabled"` 属于预期。
2. 本机运行（只需要 HTML 服务，不需要本机 Node Bot）：

   ```bash
   cd /Users/wangyinan/Downloads/er-bingotools/index
   python3 -m http.server 8000 --bind 127.0.0.1
   ```

3. 打开 `http://localhost:8000/bingotools-V17.html`，不要双击 HTML。
4. 全局设置 → QQ Bot 连接：服务地址填 `https://你的服务.onrender.com`（不加 /health），
   客户端密钥填与 Render 中 `BOT_CLIENT_KEY` 相同的值，保存。
5. 点击计时器下方“开始比赛”，填写裁判信息。确认计时器启动、群收到开始播报。
6. 修改红蓝方分数，约 1 秒后在群里 @机器人，核对裁判地址、名字和比分。
   点击“比赛结束”，核对最终得分与计时器暂停；再次 @应不再列出已结束比赛。
7. 错误密钥不能播报；配置文件不能通过 URL 下载。

免费实例不是持续在线保证：休眠、平台配额和外部数据库可用性可能影响响应。
服务启动正常不代表 QQ 允许发送，最终以 QQ API 返回和群内实际消息为准。
