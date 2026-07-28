# Agent Guide for BingoTools

This document helps AI coding agents understand the project structure, build system, and conventions.

## Project Overview

BingoTools is a Wails v2 (Go) desktop app that plays Bilibili and Douyin live streams directly through a same-origin reverse proxy, replacing the previous iframe/screen-capture approach.

Key design decisions:
- **Single-file frontend**: `bingotools.html` / `frontend/dist/index.html` is a self-contained HTML/JS/CSS app.
- **No Python/yt-dlp dependency**: Stream extraction logic is rewritten in Go.
- **Same-origin proxy**: Backend serves streams via `/live/stream/<side>` to bypass browser CORS and custom-header limits.
- **Offline playback libraries**: `hls.min.js` and `flv.min.js` are vendored in `frontend/dist/`.

## Repository Layout

```
bingotools/
├── main.go                    # Wails entry, embeds frontend/dist
├── wails.json                 # Wails config (static frontend, no npm build)
├── go.mod / go.sum
├── bingotools.html            # Source of truth for the single-file frontend
├── frontend/dist/             # Embedded into the binary
│   ├── index.html             # Kept in sync with bingotools.html
│   ├── hls.min.js
│   └── flv.min.js
├── internal/
│   ├── app/app.go             # App struct, Wails bindings, ResolveLive orchestration
│   ├── proxy/proxy.go         # Reverse proxy: /live/stream/<side>[/<segment>]
│   ├── douyin/douyin.go       # Douyin live stream extraction
│   ├── bilibili/bilibili.go   # Bilibili live stream extraction
│   └── absign/ab_sign.go      # Douyin a_bogus signature (SM3 + RC4)
├── cmd/
│   ├── headless/main.go       # End-to-end validator using net/http + ffmpeg
│   └── e2e-frontend/main.go   # Helper server for frontend integration tests
└── scripts/patch_p4.py        # Historical patch script for the P4 frontend refactor
```

## Build Commands

### Prerequisites

- Go 1.26+
- Wails CLI v2.13+ (installed at `/home/soar/go/bin/wails`)
- Linux dev: `libwebkit2gtk-4.1-dev`
- Windows cross-compile from Linux: `gcc-mingw-w64`

### Windows executable (cross-compile from WSL/Linux)

```bash
export PATH="/home/soar/go/bin:$PATH"
wails build -platform windows/amd64
cp build/bin/bingotools.exe ./bingotools-windows-amd64.exe
```

### Linux executable

```bash
export PATH="/home/soar/go/bin:$PATH"
wails build -tags webkit2_41 -platform linux/amd64
cp build/bin/bingotools ./bingotools-linux-amd64
```

### Direct Go build (for quick checks, no Wails packaging)

```bash
# Linux
CGO_ENABLED=1 go build -tags webkit2_41,production -o bingotools .

# Windows
CC=x86_64-w64-mingw32-gcc CGO_ENABLED=1 GOOS=windows GOARCH=amd64 go build -ldflags="-H windowsgui" -o bingotools.exe .
```

## Test Commands

```bash
# All Go tests
go test ./...

# Specific packages
go test ./internal/absign/... -v
go test ./internal/douyin/... -v
go test ./internal/proxy/... -v
go test ./internal/bilibili/... -v

# Vet
go vet ./...
```

## End-to-End Validation

```bash
# Bilibili room 6
go run ./cmd/headless bilibili 6

# Douyin numeric room id
go run ./cmd/headless douyin 577242340198

# Douyin URL variants
go run ./cmd/headless douyin 'https://live.douyin.com/577242340198'
go run ./cmd/headless douyin 'https://www.douyin.com/follow/live/577242340198'
```

The headless validator starts the proxy, calls `ResolveLive`, and runs `ffmpeg` against `/live/stream/1` to confirm playable A/V streams.

## Coding Conventions

- **Go**: Standard formatting (`gofmt`), idiomatic error handling.
- **Frontend**: Single-file HTML. When modifying, edit `bingotools.html` then sync to `frontend/dist/index.html`:
  ```bash
  cp bingotools.html frontend/dist/index.html
  ```
- **Comments**: Use Chinese for user-facing comments in the frontend; Go code uses English comments.
- **No external frontend build**: Do not add `package.json` or npm build steps unless explicitly requested.

## Important Implementation Notes

### Douyin `a_bogus` signature

- Located in `internal/absign/ab_sign.go`.
- Ported from the yt-dlp fork (`douyin-live-support` branch).
- Uses Python code-point semantics; Go implementation uses `[]rune` for exact byte-level compatibility.
- Golden tests in `internal/absign/ab_sign_test.go` compare against fixed-timestamp Python output.

### Same-origin proxy

- Located in `internal/proxy/proxy.go`.
- Handles `/live/stream/<side>` (main stream) and `/live/stream/<side>/<segment>` (HLS segments).
- Injects `Referer`, `Cookie`, and `User-Agent`.
- Rewrites relative HLS segment URIs to absolute `/live/stream/<side>/<segment>` paths to avoid player base-URL issues.

### Stream source format

`ResolveLive(side int, source string)` accepts strings like:
- `bilibili:6`
- `douyin:577242340198`
- `douyin:https://www.douyin.com/follow/live/577242340198`

## Git Workflow

- `main` is the default branch.
- Use conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`).
- Keep `build/`, binaries, and `node_modules/` out of git (see `.gitignore`).
