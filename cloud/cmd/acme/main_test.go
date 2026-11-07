package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vatra.cloud/internal/hubauth"
)

const dom = "vatra.test"

type fixture struct {
	srv      *Server
	h        http.Handler
	priv     ed25519.PrivateKey
	hub      string
	calls    []map[string]string
	auth     []string
	fail     atomic.Bool
	now      time.Time
	jti      int
	upstream *httptest.Server
}

func setup(t *testing.T, allow string) *fixture {
	t.Helper()
	f := &fixture{now: time.Unix(1_800_000_000, 0)}
	f.upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var m map[string]string
		_ = json.NewDecoder(r.Body).Decode(&m)
		f.calls = append(f.calls, m)
		f.auth = append(f.auth, r.Header.Get("authorization"))
		if f.fail.Load() {
			w.WriteHeader(500)
			return
		}
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	t.Cleanup(f.upstream.Close)
	f.priv = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{3}, 32))
	f.hub = hubauth.HubID(f.priv.Public().(ed25519.PublicKey))
	if allow == "self" {
		allow = f.hub
	}
	f.srv = NewServer(dom+".", f.upstream.URL, "brv_dns_test", hubauth.New(hubauth.ParseList(allow), hubauth.List{}))
	f.srv.Now = func() time.Time { return f.now }
	f.srv.Logf = t.Logf
	f.h = f.srv.Handler()
	return f
}

func (f *fixture) do(path, fqdn string, aud string) (int, string) {
	f.jti++
	tok := hubauth.Mint(f.priv, aud, f.now, 300, fmt.Sprintf("acme-test-jti-%06d", f.jti))
	body, _ := json.Marshal(map[string]string{"fqdn": fqdn, "value": "txt-value-123"})
	req := httptest.NewRequest("POST", path, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, req)
	return rec.Code, strings.TrimSpace(rec.Body.String())
}

func TestPresentAndCleanup(t *testing.T) {
	f := setup(t, "")
	code, body := f.do("/present", "_acme-challenge."+f.hub+"."+dom+".", hubauth.AudACME)
	if code != 200 || body != `{"ok":true}` {
		t.Fatalf("present = %d %s", code, body)
	}
	code, _ = f.do("/cleanup", strings.ToUpper("_acme-challenge."+f.hub+"."+dom), hubauth.AudACME)
	if code != 200 {
		t.Fatalf("cleanup = %d", code)
	}
	if len(f.calls) != 2 {
		t.Fatalf("upstream calls = %d", len(f.calls))
	}
	want := "_acme-challenge." + f.hub + "." + dom
	if f.calls[0]["fqdn"] != want || f.calls[0]["action"] != "present" || f.calls[0]["value"] != "txt-value-123" {
		t.Fatalf("upstream body %v", f.calls[0])
	}
	if f.calls[1]["fqdn"] != want || f.calls[1]["action"] != "cleanup" {
		t.Fatalf("upstream body %v", f.calls[1])
	}
	if f.auth[0] != "Bearer brv_dns_test" {
		t.Fatal("bearer not forwarded")
	}
}

func TestForbiddenNames(t *testing.T) {
	f := setup(t, "")
	other := hubauth.HubID(ed25519.NewKeyFromSeed(bytes.Repeat([]byte{4}, 32)).Public().(ed25519.PublicKey))
	for _, fqdn := range []string{
		"_acme-challenge." + other + "." + dom,               // another hub
		"_acme-challenge.evil." + f.hub + "." + dom,          // extra label
		"_acme-challenge." + f.hub + "." + dom + ".evil.com", // suffix trick
		"_acme-challenge." + f.hub + "." + dom + "..",        // double dot
		"_acme-challenge." + f.hub + ".evil." + dom,          // label inserted
		"x_acme-challenge." + f.hub + "." + dom,              // prefix trick
		"_acme-challenge." + f.hub + "x." + dom,              // longer label
		f.hub + "." + dom,                                    // no challenge label
		"_acme-challenge." + dom,                             // zone apex
		"_acme-challenge." + f.hub + "." + dom + "\x00",      // NUL
		"",
	} {
		if code, body := f.do("/present", fqdn, hubauth.AudACME); code != 403 || body != `{"error":"forbidden_name"}` {
			t.Fatalf("%q: %d %s", fqdn, code, body)
		}
	}
	if len(f.calls) != 0 {
		t.Fatal("upstream called for a forbidden name")
	}
}

func TestAuth(t *testing.T) {
	f := setup(t, "")
	ok := "_acme-challenge." + f.hub + "." + dom
	if code, _ := f.do("/present", ok, hubauth.AudPush); code != 401 {
		t.Fatalf("wrong aud = %d", code)
	}
	req := httptest.NewRequest("POST", "/present", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("no auth = %d", rec.Code)
	}
	g := setup(t, "aaaaaaaaaaaaaaaa")
	if code, body := g.do("/present", "_acme-challenge."+g.hub+"."+dom, hubauth.AudACME); code != 403 || body != `{"error":"not_allowed"}` {
		t.Fatalf("not on allow list = %d %s", code, body)
	}
	h := setup(t, "self")
	if code, _ := h.do("/present", "_acme-challenge."+h.hub+"."+dom, hubauth.AudACME); code != 200 {
		t.Fatalf("on allow list = %d", code)
	}
}

func TestRateLimit(t *testing.T) {
	f := setup(t, "")
	ok := "_acme-challenge." + f.hub + "." + dom
	for i := 0; i < 10; i++ {
		if code, _ := f.do("/present", ok, hubauth.AudACME); code != 200 {
			t.Fatalf("call %d = %d", i, code)
		}
	}
	code, body := f.do("/present", ok, hubauth.AudACME)
	if code != 429 || !strings.Contains(body, `"rate_limited"`) || !strings.Contains(body, `"retryAfter"`) {
		t.Fatalf("11th = %d %s", code, body)
	}
	f.now = f.now.Add(time.Hour)
	if code, _ := f.do("/present", ok, hubauth.AudACME); code != 200 {
		t.Fatalf("next hour = %d", code)
	}
}

func TestUpstreamFailure(t *testing.T) {
	f := setup(t, "")
	f.fail.Store(true)
	if code, body := f.do("/present", "_acme-challenge."+f.hub+"."+dom, hubauth.AudACME); code != 502 || body != `{"error":"dns_failed"}` {
		t.Fatalf("= %d %s", code, body)
	}
}

func TestHealth(t *testing.T) {
	f := setup(t, "")
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, httptest.NewRequest("GET", "/health", nil))
	if strings.TrimSpace(rec.Body.String()) != `{"configured":true,"ok":true}` {
		t.Fatalf("health = %s", rec.Body.String())
	}
	f.srv.Token = ""
	rec = httptest.NewRecorder()
	f.h.ServeHTTP(rec, httptest.NewRequest("GET", "/health", nil))
	if !strings.Contains(rec.Body.String(), `"configured":false`) {
		t.Fatalf("health = %s", rec.Body.String())
	}
}
