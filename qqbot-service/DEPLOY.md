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
- 已知群标识后云端关闭 WebSocket（`QQ_EVENTS_ENABLED=false`），主动发送无需事件长连接。
- 比赛存入外部 Postgres；云端没有数据库时拒绝开始比赛，避免悄悄丢失记录。
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
  local-config.mjs
  schema.sql
  ...测试及说明文件
```

不要上传 `.local-config.json`、`.env`、`node_modules` 或数据库连接密码。
更新提交后确认仓库首页存在 `qqbot-service`，且里面能看到 `package.json`、`server.mjs`。
本地 HTML 不需要上传到 Render。

## 2. 数据库分两步

先验证连接和“测试 QQ 机器人”时，可以暂不配置数据库。
当前代码在 Render 上执行“开始比赛”必须连接数据库，因为该操作承诺保存比赛记录。
先跑通测试消息，再按下面步骤配置数据库完成正式比赛播报。

在 Supabase 项目中通过 Connect 获取 Postgres 连接字符串，填入实际数据库密码。
使用适合你的连接环境的连接方式；IPv4 环境通常可选择 Session pooler。
连接字符串仅填写到 Render 的 `SUPABASE_DATABASE_URL`，不要发到聊天或写入仓库。
服务器启动时创建/更新比赛表并开启 RLS，网页不直接访问 Supabase。
若 TLS 校验失败，请配置官方提供的 CA 证书（`SUPABASE_CA_CERT`），不要关闭校验。

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
| QQ_EVENTS_ENABLED | `false` |
| QQ_APP_ID | 现有机器人的 AppID |
| QQ_APP_SECRET | 现有机器人的密钥；仅管理员填写 |
| QQ_GROUP_OPENID | 已取得的固定群标识 |
| BOT_CLIENT_KEY | 使用者持有的独立使用密钥，Blueprint 可自动生成 |
| SUPABASE_DATABASE_URL | 数据库连接字符串 |

不要上传本地配置来代替 Render 环境变量。云端会忽略本地配置文件。
Render 自动提供 `PORT`。设置：

```text
ALLOWED_ORIGINS=http://localhost:8000,http://127.0.0.1:8000
```

需要允许其他调试网页时明确列入 `ALLOWED_ORIGINS`，不要使用 `*` 或 `null`。
数据库还没准备好时，先用手动 Web Service 配置，暂不添加 `SUPABASE_DATABASE_URL`。
根目录 Blueprint 会要求数据库变量，适合已有数据库时使用。

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
5. 不 @机器人，点击“测试 QQ 机器人”，确认比赛信息并发送，核对群消息。
6. 配置数据库并重新部署后，`/health` 应显示 `database:"ready"`；
   点击“开始比赛”，核对 QQ 群与数据库发送状态。
7. 错误密钥不能播报；配置文件不能通过 URL 下载。

免费实例不是持续在线保证：休眠、平台配额和外部数据库可用性可能影响响应。
服务启动正常不代表 QQ 允许发送，最终以 QQ API 返回和群内实际消息为准。
