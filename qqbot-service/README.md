# BingoTools QQ Bot Service

独立的 Node.js 服务，负责接收网页事件、调用 QQ 官方机器人 API，并把比赛开始记录写入 Supabase Postgres。

## 本地运行

### Mac：接收群事件并获取 group_openid

需要 Node.js 24（最低 22.4）和 Python 3。无需上传 GitHub；未配置数据库时无需安装额外依赖。

```bash
cd /Users/wangyinan/Downloads/er-bingotools/qqbot-service
npm run setup
npm start
```

`setup` 交互输入 AppID 和 AppSecret，第一次 group_openid 留空。密钥输入不回显，
保存在权限为 0600 的 `.local-config.json`，已加入忽略规则，切勿分享或上传。
默认仅监听本机 `127.0.0.1`，环境变量优先于本地文件。

后台使用 WebSocket 时，等待终端显示“QQ 事件连接已就绪”，然后在目标群 @机器人。
另开终端，在同一目录运行 `npm run status`，查看连接状态和 `groups` 中的 `group_openid`。
该查询会自动读取本地客户端密钥；不要把密钥放进 URL。

再次 `npm run setup`，AppID/AppSecret 回车保留，填写取得的 group_openid；
原终端 Ctrl+C 后重新 `npm start`。在 HTML 全局设置中填写
`http://localhost:8787` 和本地配置中的 `BOT_CLIENT_KEY`，直接点击网页“测试 QQ 机器人”。

服务仅收到事件不会自动回复；“连接就绪”和群里实际收到测试消息是两个独立检查。
群标识列表只在内存中保存；固定目标群通过 setup 保存后，重启无需重新 @。
测试和开始比赛均发送主动群消息，不携带 msg_id、event_id 或 msg_seq，不回复或 @某个人，
也不回退到被动回复。接收事件仅用于首次发现群标识，不是发送的前提。
主动消息能否送达仍以 QQ API 实际返回为准；权限、配额或内容被拒绝时显示原始错误，
不把本地服务或事件连接正常当作播报成功。
如果 QQ 不允许当前账号通过 WebSocket 接入，需要改用 Webhook 和可公开访问的 HTTPS
回调地址；本版本不包含 Webhook。请根据真实报错判断，不能把 /health 成功当作 QQ 连通。

查看服务是否启动：`http://localhost:8787/health`。查看事件连接：

```text
GET /api/v1/qq/status
GET /api/v1/qq/groups
Authorization: Bearer <BOT_CLIENT_KEY>
```

### 使用环境变量启动

```bash
cd qqbot-service
npm install
QQ_APP_ID=... \
QQ_APP_SECRET=... \
QQ_GROUP_OPENID=... \
BOT_CLIENT_KEY=local-test-key \
npm start
```

不配置 QQ 环境变量时，服务仍会启动，可用于测试 `/health` 和网页请求格式。

## 环境变量

必需：

```text
QQ_APP_ID
QQ_APP_SECRET
QQ_GROUP_OPENID
BOT_CLIENT_KEY
```

可选：

```text
PORT=8787
SUPABASE_DATABASE_URL=postgresql://...
ALLOWED_ORIGINS=http://localhost:8000,http://127.0.0.1:8000
QQ_EVENTS_ENABLED=true
```

`SUPABASE_DATABASE_URL` 使用 Supabase 项目的 Postgres connection string。未配置时，QQ 发送仍可测试，但比赛记录不会持久化。

## API 测试

```bash
curl http://localhost:8787/health

curl -X POST http://localhost:8787/api/v1/qq/test \
  -H 'Authorization: Bearer local-test-key' \
  -H 'Content-Type: application/json' \
  --data '{"started_at":"2026-09-18T20:00:00+08:00","referee":{"platform":"bilibili","room":"123456","title":"裁判直播"},"left":{"name":"红方选手","platform":"bilibili","room":"111"},"right":{"name":"蓝方选手","platform":"douyin","room":"222"}}'

curl -X POST http://localhost:8787/api/v1/matches/start \
  -H 'Authorization: Bearer local-test-key' \
  -H 'Content-Type: application/json' \
  --data '{"started_at":"2026-09-18T20:00:00+08:00","referee":{"room":"123456","title":"裁判直播"},"left":{"name":"红方","platform":"bilibili","room":"111","title":""},"right":{"name":"蓝方","platform":"douyin","room":"222","title":""}}'
```

## Render

测试接口现在接收与开始比赛相同的比赛信息，播报比赛时间（北京时间）、裁判地址、
红蓝方姓名和各自直播间地址。测试消息带“测试”标记，不登记比赛或改变网页比赛状态。
网页测试按钮会先打开确认弹窗；已有比赛使用其开始时间，否则使用发送时刻。
裁判平台可选择 Bilibili / 抖音，支持房间号或完整 HTTP(S) 地址；标题仍保存但不播报。

云端只提供 Bot API，本地 HTML 和未来的 exe 调用同一套接口。使用仓库根目录的 `render.yaml` 创建 Blueprint，
或在 Web Service 中按以下配置填写（Root Directory 留空，不再填 qqbot-service）：

```text
Runtime: Node
Root Directory: 留空（仓库根目录）
Build Command: npm --prefix qqbot-service ci
Start Command: npm --prefix qqbot-service start
Health Check Path: /health
Plan: Free
```

在 Render 中配置 QQ 环境变量、`BOT_CLIENT_KEY` 和 `SUPABASE_DATABASE_URL`。
详细步骤见同目录 `DEPLOY.md`。服务首页仅返回 API 状态 JSON，不公开 Bingo 网页。
本地 HTML 的全局设置中填写 Render HTTPS 地址和使用密钥。
不向使用者提供 AppSecret、群标识或数据库凭证。
