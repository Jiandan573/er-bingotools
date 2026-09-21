package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestQQBotDesktopBridge(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/api/v1/matches/start" || r.Method != http.MethodPost {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-client-key" || r.Header.Get("Idempotency-Key") != "match-123" {
			t.Error("missing authentication or idempotency header")
		}
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"ok":false,"error":"already ended"}`))
	}))
	defer server.Close()
	result, err := callQQBot(context.Background(), server.URL, "test-client-key", "/api/v1/matches/start", `{}`, "match-123")
	if err != nil || result.Status != 409 || result.Body != `{"ok":false,"error":"already ended"}` || calls != 1 {
		t.Fatalf("result=%+v error=%v calls=%d", result, err, calls)
	}
}

func TestQQBotRejectsUnsafeRequestsAndRedirects(t *testing.T) {
	for _, base := range []string{"http://example.com", "https://user:pass@example.com", "file:///tmp/test", "https://example.com?key=123"} {
		if _, err := callQQBot(nil, base, "key", "/api/v1/matches/start", `{}`, ""); err == nil {
			t.Errorf("accepted invalid URL %q", base)
		}
	}
	if _, err := callQQBot(nil, "https://example.com", "key", "/anything", `{}`, ""); err == nil {
		t.Error("accepted arbitrary endpoint")
	}
	if _, err := callQQBot(nil, "https://example.com", "key", "/api/v1/matches/start", `broken`, ""); err == nil {
		t.Error("accepted invalid JSON")
	}
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("followed redirect with client credentials")
	}))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	if _, err := callQQBot(nil, redirect.URL, "key", "/api/v1/matches/start", `{}`, ""); err == nil {
		t.Error("redirect must be reported to user")
	}
}
