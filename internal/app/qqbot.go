package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// QQBotResponse preserves the API status so the UI can distinguish validation failures.
type QQBotResponse struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
}

// CallQQBot forwards desktop match requests without relying on WebView CORS.
// Credentials are supplied by the user's settings, never embedded in the executable.
func (a *App) CallQQBot(serviceURL, clientKey, endpoint, body, idempotencyKey string) (QQBotResponse, error) {
	return callQQBot(a.ctx, serviceURL, clientKey, endpoint, body, idempotencyKey)
}

// CallRoomService accepts only fixed room routes; arbitrary proxying is forbidden.
func (a *App) CallRoomService(serviceURL, token, endpoint, body string) (QQBotResponse, error) {
	return callRoomService(a.ctx, serviceURL, token, endpoint, body)
}

func callRoomService(parent context.Context, serviceURL, token, endpoint, body string) (QQBotResponse, error) {
	allowed := map[string]bool{
		"/health": true, "/api/v2/session": true, "/api/v2/list": true,
		"/api/v2/create": true, "/api/v2/get": true, "/api/v2/join": true,
		"/api/v2/leave": true, "/api/v2/heartbeat": true, "/api/v2/update": true,
		"/api/v2/settings": true, "/api/v2/kick": true, "/api/v2/start": true,
		"/api/v2/end": true, "/api/v2/mount": true, "/api/v2/takeover": true,
		"/api/v2/remount": true, "/api/v2/retry": true, "/api/v2/delete": true,
		"/api/v2/dev-auth": true, "/api/v2/dev/settings": true, "/api/v2/dev/logout": true,
	}
	if !allowed[endpoint] {
		return QQBotResponse{}, errors.New("不支持的房间接口")
	}
	method := http.MethodPost
	if endpoint == "/health" {
		method = http.MethodGet
	}
	return botHTTP(parent, serviceURL, token, endpoint, body, "", method, 131072, 8388608)
}

func callQQBot(parent context.Context, serviceURL, clientKey, endpoint, body, idempotencyKey string) (QQBotResponse, error) {
	switch endpoint {
	case "/api/v1/matches/start", "/api/v1/matches/score", "/api/v1/matches/end":
	default:
		return QQBotResponse{}, errors.New("不支持的比赛接口")
	}
	if strings.TrimSpace(clientKey) == "" {
		return QQBotResponse{}, errors.New("使用密钥无效")
	}
	return botHTTP(parent, serviceURL, clientKey, endpoint, body, idempotencyKey, http.MethodPost, 16384, 65536)
}

func botHTTP(parent context.Context, serviceURL, clientKey, endpoint, body, idempotencyKey, method string, requestLimit, responseLimit int64) (QQBotResponse, error) {
	var result QQBotResponse
	base, err := url.Parse(strings.TrimSpace(serviceURL))
	if err != nil || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return result, errors.New("Render 服务地址格式不正确")
	}
	local := base.Hostname() == "localhost" || base.Hostname() == "127.0.0.1" || base.Hostname() == "::1"
	if base.Scheme != "https" && !(base.Scheme == "http" && local) {
		return result, errors.New("请使用 HTTPS 服务地址；HTTP 仅用于本机调试")
	}
	clientKey = strings.TrimSpace(clientKey)
	if strings.ContainsAny(clientKey+idempotencyKey, "\r\n") {
		return result, errors.New("使用密钥或请求标识无效")
	}
	if int64(len(body)) > requestLimit || !json.Valid([]byte(body)) {
		return result, errors.New("比赛请求内容无效")
	}
	base.Path = strings.TrimRight(base.Path, "/") + endpoint
	base.RawPath = ""
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, 85*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, base.String(), strings.NewReader(body))
	if err != nil {
		return result, errors.New("无法创建比赛请求")
	}
	req.Header.Set("Content-Type", "application/json")
	if clientKey != "" {
		req.Header.Set("Authorization", "Bearer "+clientKey)
	}
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	client := &http.Client{
		Timeout: 85 * time.Second,
		// Never forward the user's bearer key to a redirect destination.
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := client.Do(req)
	if err != nil {
		return result, errors.New("无法连接 Render 或请求超时；请检查网络，重试播报前先核对 QQ 群")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, responseLimit+1))
	if err != nil || int64(len(data)) > responseLimit {
		return result, errors.New("服务响应读取失败；重试播报前请先核对 QQ 群")
	}
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return result, errors.New("服务地址发生跳转，请填写最终 HTTPS 地址")
	}
	// Avoid reflecting the use key even if a misconfigured service echoes request headers.
	clean := string(data)
	if clientKey != "" {
		clean = strings.ReplaceAll(clean, clientKey, "[redacted]")
	}
	return QQBotResponse{Status: response.StatusCode, Body: clean}, nil
}
