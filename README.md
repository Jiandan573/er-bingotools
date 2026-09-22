## v17.2.0 联机房间

默认连接 Render，普通用户无需密钥；包含裁判房间、只读加入、挂载接管、历史、小窗及 QQ 比赛播报。
房间与历史仅存内存，服务器重启后清空。

- [使用说明](docs/QQ比赛播报使用说明.md)
- [服务接口与维护](docs/房间服务接口.md)

# BingoTools

BingoTools 是一款用于 Bingo 直播场景的工具，支持在单个窗口中并排播放两个直播间、本地屏幕采集、画面裁切、放大布局、倒计时/秒表、随机数等功能。

本版本将直播播放方式从「iframe 嵌入 B站播放器 / 抖音截屏采集」改造为「通过原生取流逻辑拿到真实直播流地址，经同源反向代理在 `<video>` 中直接播放」，从而绕过浏览器 CORS 与自定义请求头限制，并交付单一可执行文件。

## 比赛播报（v17.1.0）

Windows 版已集成比赛计时、QQ 开始/结束通知、比分和用时同步，以及群内 @查询。
请先阅读 [QQ 比赛播报使用说明](docs/QQ比赛播报使用说明.md)，在全局设置填写 Render 地址和使用密钥。

## 功能特性

- **双直播间播放**：支持同时播放左右两个直播间。
- **B站直播**：直接解析 Bilibili 直播流地址。
- **抖音直播**：直接解析 Douyin 直播流地址（含 `a_bogus` 签名与 `ttwid` Cookie 流程）。
- **本地采集**：通过 `getDisplayMedia` 采集本地窗口/屏幕。
- **画面裁切**：对网络流或本地画面进行区域裁切与放大。
- **同源代理**：后端反向代理注入 `Referer` / `Cookie` / `User-Agent`，前端无需跨域。
- **单文件可执行**：Wails v2 + Go，Windows 下单 `.exe` 运行。

## 技术栈

- **后端**：Go 1.26+
- **桌面框架**：Wails v2
- **前端**：单文件 HTML + hls.js + flv.js
- **签名算法**：SM3、RC4、`a_bogus`（抖音）

## 快速开始

### 环境要求

- Go 1.26 或更高版本
- Wails CLI v2.13 或更高版本
- Linux 构建需要 `libwebkit2gtk-4.1-dev`
- Windows 交叉编译需要 `mingw-w64`（Linux）或 Windows 本机环境

### 安装依赖（Ubuntu/WSL）

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev gcc-mingw-w64
```

### 构建

```bash
# Windows 可执行文件（在 Linux/WSL 上交叉编译）
wails build -platform windows/amd64

# Linux 可执行文件
wails build -tags webkit2_41 -platform linux/amd64
```

构建产物位于项目根目录：

- `bingotools-windows-amd64.exe`
- `bingotools-linux-amd64`

### 运行

Windows：

```powershell
.\bingotools-windows-amd64.exe
```

Linux：

```bash
./bingotools-linux-amd64
```

> 注意：Windows 版本依赖系统已安装 WebView2 Runtime（Windows 11 自带；Windows 10 旧版可能需要单独安装）。

## 项目结构

```
bingotools/
├── main.go                    # Wails 入口
├── wails.json                 # Wails 构建配置
├── go.mod / go.sum            # Go 模块
├── bingotools.html            # 单文件前端（与 frontend/dist/index.html 同步）
├── frontend/
│   └── dist/
│       ├── index.html         # 嵌入到二进制的前端
│       ├── hls.min.js         # HLS 播放库
│       └── flv.min.js         # FLV 播放库
├── internal/
│   ├── app/app.go             # Wails 绑定方法 + 取流编排
│   ├── proxy/proxy.go         # 同源反向代理
│   ├── douyin/douyin.go       # 抖音直播取流
│   ├── bilibili/bilibili.go   # Bilibili 直播取流
│   └── absign/ab_sign.go      # 抖音 a_bogus 签名实现
├── cmd/
│   ├── headless/main.go       # 无窗口端到端验证器
│   └── e2e-frontend/main.go   # 前端 E2E 辅助 server
├── scripts/
│   └── patch_p4.py            # 前端改造自动化补丁（历史记录）
└── PLAN.md                    # 完整改造计划与进度
```

## 输入格式

在设置直播间时支持以下格式：

- B站：纯数字房间号，如 `6`
- 抖音：纯数字直播间 ID，如 `577242340198`
- 抖音直播 URL：
  - `https://live.douyin.com/577242340198`
  - `https://www.douyin.com/follow/live/577242340198`
  - `https://www.douyin.com/user/abc?from_room_id=577242340198`

## 开发与测试

```bash
# 运行全部 Go 测试
go test ./...

# 运行无窗口验证器（B站）
go run ./cmd/headless bilibili 6

# 运行无窗口验证器（抖音）
go run ./cmd/headless douyin 577242340198

# 或直接传入抖音 URL
go run ./cmd/headless douyin 'https://www.douyin.com/follow/live/577242340198'
```

## 已知限制

- 抖音 `a_bogus` 签名可能随抖音前端更新而失效，需要持续维护。
- 长时间直播播放可能因流地址过期而中断，当前版本需要手动重新设置直播间。
- Windows 版本需要 WebView2 Runtime。

# 许可证说明

本项目采用自定义私有限制许可：
1. 任何人可下载、本地使用、本地修改自用（不支持商用，如有需要请提前联系作者）；
2. 禁止将修改后的代码、衍生工具上传、发布、分享、售卖到任何公开平台；
3. 仅允许个人内部使用，不允许二次分发；
4. 如需对外发布修改版，必须提前联系作者获得书面授权。
