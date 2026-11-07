package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"vatra.cloud/internal/hubauth"
	"vatra.cloud/internal/relaytoken"
)

type fakeAPNs struct {
	calls []struct {
		sandbox bool
		token   string
		p       Push
	}
	res Result
	err error
}

func (f *fakeAPNs) SendAPNs(_ context.Context, sandbox bool, token string, p Push, _ time.Time) (Result, error) {
	f.calls = append(f.calls, struct {
		sandbox bool
		token   string
		p       Push
	}{sandbox, token, p})
	if f.res.Status == 0 && f.err == nil {
		return Result{Status: 200}, nil
	}
	return f.res, f.err
}

type fakeFCM struct {
	tokens []string
	res    Result
}

func (f *fakeFCM) SendFCM(_ context.Context, token string, _ Push, _ time.Time) (Result, error) {
	f.tokens = append(f.tokens, token)
	if f.res.Status == 0 {
		return Result{Status: 200}, nil
	}
	return f.res, nil
}

type fx struct {
	s    *Server
	h    http.Handler
	apns *fakeAPNs
	fcm  *fakeFCM
	now  time.Time
	jti  int
}

func key(seed byte) (ed25519.PrivateKey, string) {
	k := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{seed}, 32))
	return k, hubauth.HubID(k.Public().(ed25519.PublicKey))
}

func newFx(t *testing.T, allow string) *fx {
	t.Helper()
	aead, err := newAEAD(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	f := &fx{apns: &fakeAPNs{}, fcm: &fakeFCM{}, now: time.Date(2027, 1, 1, 12, 0, 0, 0, time.UTC)}
	f.s = NewServer("vatra.test", hubauth.New(hubauth.ParseList(allow), hubauth.List{}))
	f.s.Handles, f.s.APNs, f.s.FCM = aead, f.apns, f.fcm
	f.s.Now = func() time.Time { return f.now }
	f.s.Logf = t.Logf
	f.h = f.s.Handler()
	return f
}

func (f *fx) req(method, path string, body any, auth string, hdr map[string]string) (int, map[string]any) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	r := httptest.NewRequest(method, path, rd)
	if auth != "" {
		r.Header.Set("Authorization", "Bearer "+auth)
	}
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, r)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func (f *fx) jwt(priv ed25519.PrivateKey, aud string) string {
	f.jti++
	return hubauth.Mint(priv, aud, f.now, 300, fmt.Sprintf("push-test-jti-%07d", f.jti))
}

func (f *fx) handle(t *testing.T, platform, token, hub string) string {
	t.Helper()
	code, out := f.req("POST", "/v1/handles", map[string]string{"platform": platform, "token": token, "hub": hub}, "", map[string]string{"X-Forwarded-For": "198.51.100.9"})
	if code != 200 {
		t.Fatalf("handle = %d %v", code, out)
	}
	return out["handle"].(string)
}

func alert(h string) map[string]any {
	return map[string]any{"handle": h, "type": "alert", "priority": "high", "collapse": "c1", "ttl": 60, "kind": "intercom", "data": map[string]string{"v": "1", "id": "card1", "e": "abc", "full": "1", "type": "card"}}
}

func TestHandleRoundTripAndWrongHub(t *testing.T) {
	f := newFx(t, "")
	priv, hub := key(1)
	other, _ := key(2)
	h := f.handle(t, "apns-sandbox", "devtok", hub)
	if !strings.HasPrefix(h, "h1.") || strings.Contains(h, "devtok") {
		t.Fatalf("handle %q", h)
	}
	opened, err := open(f.s.Handles, h)
	if err != nil || opened != (handle{P: "apns-sandbox", T: "devtok", H: hub}) {
		t.Fatalf("open = %+v %v", opened, err)
	}
	code, out := f.req("POST", "/v1/push", alert(h), f.jwt(priv, hubauth.AudPush), nil)
	if code != 200 || out["status"] != float64(200) {
		t.Fatalf("push = %d %v", code, out)
	}
	if len(f.apns.calls) != 1 || !f.apns.calls[0].sandbox || f.apns.calls[0].token != "devtok" {
		t.Fatalf("apns calls %+v", f.apns.calls)
	}
	code, out = f.req("POST", "/v1/push", alert(h), f.jwt(other, hubauth.AudPush), nil)
	if code != 403 || out["error"] != "wrong_hub" {
		t.Fatalf("wrong hub = %d %v", code, out)
	}
	// tampered handle
	b := []byte(h)
	b[len(b)-2] ^= 1
	if code, _ := f.req("POST", "/v1/push", alert(string(b)), f.jwt(priv, hubauth.AudPush), nil); code != 400 {
		t.Fatalf("tampered handle = %d", code)
	}
	// AAD binds the purpose
	pt, _ := json.Marshal(handle{P: "fcm", T: "x", H: hub})
	nonce := make([]byte, 12)
	forged := "h1." + base64.RawURLEncoding.EncodeToString(f.s.Handles.Seal(nonce, nonce, pt, []byte("other-aad")))
	if code, _ := f.req("POST", "/v1/push", alert(forged), f.jwt(priv, hubauth.AudPush), nil); code != 400 {
		t.Fatalf("wrong aad = %d", code)
	}
	if code, _ := f.req("POST", "/v1/push", alert(h), "", nil); code != 401 {
		t.Fatalf("no auth = %d", code)
	}
}

func TestHandleValidationAndIPLimit(t *testing.T) {
	f := newFx(t, "")
	_, hub := key(1)
	for _, b := range []map[string]string{
		{"platform": "web", "token": "t", "hub": hub},
		{"platform": "fcm", "token": "", "hub": hub},
		{"platform": "fcm", "token": "t", "hub": "not-a-hub"},
	} {
		if code, _ := f.req("POST", "/v1/handles", b, "", map[string]string{"X-Forwarded-For": "203.0.113.1"}); code != 400 {
			t.Fatalf("%v = %d", b, code)
		}
	}
	body := map[string]string{"platform": "fcm", "token": "t", "hub": hub}
	xff := map[string]string{"X-Forwarded-For": "203.0.113.5, 10.0.0.1"}
	for i := 0; i < 30; i++ {
		if code, _ := f.req("POST", "/v1/handles", body, "", xff); code != 200 {
			t.Fatalf("call %d = %d", i, code)
		}
	}
	if code, out := f.req("POST", "/v1/handles", body, "", xff); code != 429 || out["error"] != "rate_limited" {
		t.Fatalf("31st = %d %v", code, out)
	}
	if code, _ := f.req("POST", "/v1/handles", body, "", map[string]string{"X-Forwarded-For": "203.0.113.6, 203.0.113.5"}); code != 200 {
		t.Fatal("first hop not used as the key")
	}
}

func TestPushLimits(t *testing.T) {
	f := newFx(t, "")
	priv, hub := key(1)
	f.s.perHandle.Limit, f.s.perHub.Limit, f.s.perHubCritical.Limit = 3, 5, 2
	h1 := f.handle(t, "fcm", "a", hub)
	h2 := f.handle(t, "fcm", "b", hub)
	send := func(h string, critical bool) int {
		b := alert(h)
		b["critical"] = critical
		code, _ := f.req("POST", "/v1/push", b, f.jwt(priv, hubauth.AudPush), nil)
		return code
	}
	for i := 0; i < 3; i++ {
		if send(h1, false) != 200 {
			t.Fatal("under handle limit refused")
		}
	}
	if send(h1, false) != 429 {
		t.Fatal("per-handle limit not applied")
	}
	if send(h2, false) != 200 || send(h2, false) != 200 {
		t.Fatal("hub budget")
	}
	if code := send(h2, false); code != 429 {
		t.Fatalf("per-hub limit = %d", code)
	}
	// critical has its own hub bucket (handle h3 is fresh)
	h3 := f.handle(t, "fcm", "c", hub)
	if send(h3, true) != 200 || send(h3, true) != 200 {
		t.Fatal("critical bucket")
	}
	if send(h3, true) != 429 {
		t.Fatal("critical limit not applied")
	}
	// next UTC day resets
	f.now = f.now.Add(13 * time.Hour)
	if send(h1, false) != 200 {
		t.Fatal("day did not reset")
	}
}

func TestGoneAndNotConfigured(t *testing.T) {
	f := newFx(t, "")
	priv, hub := key(1)
	ha := f.handle(t, "apns", "a", hub)
	hf := f.handle(t, "fcm", "f", hub)
	f.apns.res = Result{Status: 410, Gone: true}
	if code, out := f.req("POST", "/v1/push", alert(ha), f.jwt(priv, hubauth.AudPush), nil); code != 200 || out["status"] != float64(410) || out["gone"] != true {
		t.Fatalf("apns gone = %d %v", code, out)
	}
	f.fcm.res = Result{Status: 404, Gone: true}
	if code, out := f.req("POST", "/v1/push", alert(hf), f.jwt(priv, hubauth.AudPush), nil); code != 200 || out["gone"] != true {
		t.Fatalf("fcm gone = %d %v", code, out)
	}
	f.s.FCM = nil
	if code, out := f.req("POST", "/v1/push", alert(hf), f.jwt(priv, hubauth.AudPush), nil); code != 503 || out["error"] != "not_configured" || out["platform"] != "fcm" {
		t.Fatalf("fcm missing = %d %v", code, out)
	}
	f.s.APNs = nil
	if code, out := f.req("POST", "/v1/push", alert(ha), f.jwt(priv, hubauth.AudPush), nil); code != 503 || out["platform"] != "apns" {
		t.Fatalf("apns missing = %d %v", code, out)
	}
	code, out := f.req("GET", "/health", nil, "", nil)
	if code != 200 || out["apns"] != false || out["fcm"] != false || out["relayToken"] != false || out["ok"] != true {
		t.Fatalf("health = %v", out)
	}
}

func TestProviderResultMapping(t *testing.T) {
	for _, tc := range []struct {
		status int
		reason string
		gone   bool
	}{{200, "", false}, {410, "Unregistered", true}, {400, "BadDeviceToken", true}, {400, "BadTopic", false}, {500, "", false}} {
		r, _ := apnsResult(tc.status, tc.reason)
		if r.Gone != tc.gone {
			t.Fatalf("apns %d %s gone=%v", tc.status, tc.reason, r.Gone)
		}
	}
	if r, _ := fcmResult(404, nil); !r.Gone {
		t.Fatal("fcm 404")
	}
	if r, _ := fcmResult(400, []byte(`{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}`)); !r.Gone {
		t.Fatal("fcm UNREGISTERED")
	}
	if r, err := fcmResult(500, nil); r.Gone || err == nil {
		t.Fatal("fcm 500")
	}
}

func TestBadPushBodies(t *testing.T) {
	f := newFx(t, "")
	priv, hub := key(1)
	h := f.handle(t, "apns", "a", hub)
	for name, mut := range map[string]func(map[string]any){
		"bad kind":         func(b map[string]any) { b["kind"] = "Intercom!" },
		"bad type":         func(b map[string]any) { b["type"] = "silent" },
		"bad priority":     func(b map[string]any) { b["priority"] = "urgent" },
		"data too big":     func(b map[string]any) { b["data"] = map[string]string{"e": strings.Repeat("x", 3600)} },
		"activity missing": func(b map[string]any) { b["type"] = "liveactivity" },
		"non-string data":  func(b map[string]any) { b["data"] = map[string]any{"n": 1} },
	} {
		b := alert(h)
		mut(b)
		if code, _ := f.req("POST", "/v1/push", b, f.jwt(priv, hubauth.AudPush), nil); code != 400 {
			t.Fatalf("%s = %d", name, code)
		}
	}
}

func mustJSON(t *testing.T, b []byte) string {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(v) // sorted keys
	return string(out)
}

var at = time.Unix(1_800_000_000, 0)

func TestAPNsAlertGolden(t *testing.T) {
	p := Push{Type: "alert", Priority: "high", Collapse: "door", TTL: 60, Kind: "intercom", Data: map[string]string{"id": "c1", "e": "x"}}
	r := buildAPNs(p, "ro.vatra.app", at)
	want := `{"aps":{"alert":{"loc-key":"VATRA_PUSH_BODY","title-loc-key":"VATRA_PUSH_TITLE_INTERCOM"},"category":"vatra.intercom","interruption-level":"time-sensitive","mutable-content":1,"sound":"default","thread-id":"door"},"vatra":{"e":"x","id":"c1"}}`
	if got := mustJSON(t, r.Body); got != want {
		t.Fatalf("body\n got %s\nwant %s", got, want)
	}
	wantH := map[string]string{"apns-topic": "ro.vatra.app", "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "door", "apns-expiration": "1800000060"}
	for k, v := range wantH {
		if r.Headers[k] != v {
			t.Fatalf("header %s = %q want %q", k, r.Headers[k], v)
		}
	}
	p.Priority = "normal"
	r = buildAPNs(p, "ro.vatra.app", at)
	if !strings.Contains(string(r.Body), `"interruption-level":"active"`) || strings.Contains(string(r.Body), "sound") || r.Headers["apns-priority"] != "5" {
		t.Fatalf("normal alert %s %v", r.Body, r.Headers)
	}
}

func TestAPNsBackgroundGolden(t *testing.T) {
	r := buildAPNs(Push{Type: "background", Priority: "high", Kind: "sync", Data: map[string]string{"id": "c2"}}, "ro.vatra.app", at)
	if got := mustJSON(t, r.Body); got != `{"aps":{"content-available":1},"vatra":{"id":"c2"}}` {
		t.Fatalf("body %s", got)
	}
	if r.Headers["apns-push-type"] != "background" || r.Headers["apns-priority"] != "5" || r.Headers["apns-expiration"] != "0" {
		t.Fatalf("headers %v", r.Headers)
	}
}

func TestAPNsLiveActivityGolden(t *testing.T) {
	p := Push{Type: "liveactivity", Priority: "high", Kind: "intercom", Activity: &Activity{
		Event: "start", AttributesType: "IntercomAttributes",
		Attributes: json.RawMessage(`{"cardId":"c1"}`), State: json.RawMessage(`{"ringing":true,"since":0,"e":"x"}`),
	}}
	r := buildAPNs(p, "ro.vatra.app", at)
	want := `{"aps":{"alert":{"loc-key":"VATRA_PUSH_BODY","title-loc-key":"VATRA_PUSH_TITLE_INTERCOM"},"attributes":{"cardId":"c1"},"attributes-type":"IntercomAttributes","content-state":{"e":"x","ringing":true,"since":0},"dismissal-date":1800000300,"event":"start","sound":"default","stale-date":1800000120,"timestamp":1800000000}}`
	if got := mustJSON(t, r.Body); got != want {
		t.Fatalf("body\n got %s\nwant %s", got, want)
	}
	if r.Headers["apns-topic"] != "ro.vatra.app.push-type.liveactivity" || r.Headers["apns-push-type"] != "liveactivity" {
		t.Fatalf("headers %v", r.Headers)
	}
}

func TestFCMPayloadGolden(t *testing.T) {
	b := buildFCM("tok", Push{Priority: "high", TTL: 3600, Collapse: "door", Kind: "intercom", Data: map[string]string{"id": "c1"}})
	want := `{"message":{"android":{"collapse_key":"door","priority":"HIGH","ttl":"3600s"},"data":{"id":"c1","kind":"intercom"},"token":"tok"}}`
	if got := mustJSON(t, b); got != want {
		t.Fatalf("got %s", got)
	}
	if !strings.Contains(string(buildFCM("t", Push{Priority: "normal", Kind: "k"})), `"priority":"NORMAL"`) {
		t.Fatal("normal priority")
	}
}

func TestAPNsSenderOverHTTP(t *testing.T) {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	var gotPath, gotAuth, gotTopic string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth, gotTopic = r.URL.Path, r.Header.Get("authorization"), r.Header.Get("apns-topic")
		if strings.HasSuffix(r.URL.Path, "/gone") {
			w.WriteHeader(410)
			_, _ = io.WriteString(w, `{"reason":"Unregistered"}`)
		}
	}))
	defer srv.Close()
	a := NewAPNs(k, "KEYID12345", "TEAM123456", "ro.vatra.app")
	a.SandboxURL, a.ProdURL, a.Client = srv.URL, srv.URL+"/prod", srv.Client()
	res, err := a.SendAPNs(context.Background(), true, "abc", Push{Type: "alert", Kind: "door"}, at)
	if err != nil || res.Status != 200 || gotPath != "/3/device/abc" || gotTopic != "ro.vatra.app" {
		t.Fatalf("send %v %v %s", res, err, gotPath)
	}
	// verify the ES256 provider token
	parts := strings.Split(strings.TrimPrefix(gotAuth, "bearer "), ".")
	if len(parts) != 3 {
		t.Fatalf("auth %q", gotAuth)
	}
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(&k.PublicKey, sum[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatal("bad ES256 signature")
	}
	first := gotAuth
	_, _ = a.SendAPNs(context.Background(), true, "abc", Push{Type: "alert", Kind: "door"}, at.Add(49*time.Minute))
	if gotAuth != first {
		t.Fatal("token not cached")
	}
	_, _ = a.SendAPNs(context.Background(), true, "abc", Push{Type: "alert", Kind: "door"}, at.Add(51*time.Minute))
	if gotAuth == first {
		t.Fatal("token not refreshed after 50 min")
	}
	res, _ = a.SendAPNs(context.Background(), false, "gone", Push{Type: "alert", Kind: "door"}, at)
	if !res.Gone || gotPath != "/prod/3/device/gone" {
		t.Fatalf("gone %v %s", res, gotPath)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(k)
	if _, err := ParseP8(string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))); err != nil {
		t.Fatal(err)
	}
}

func TestFCMSenderOverHTTP(t *testing.T) {
	rk, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(rk)
	oauthCalls := 0
	var sent map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			oauthCalls++
			_ = r.ParseForm()
			if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" || strings.Count(r.Form.Get("assertion"), ".") != 2 {
				w.WriteHeader(400)
				return
			}
			_, _ = io.WriteString(w, `{"access_token":"ya29.test","expires_in":3600}`)
		case "/send":
			if r.Header.Get("authorization") != "Bearer ya29.test" {
				w.WriteHeader(401)
				return
			}
			_ = json.NewDecoder(r.Body).Decode(&sent)
			if strings.Contains(fmt.Sprint(sent), "gone") {
				w.WriteHeader(404)
				_, _ = io.WriteString(w, `{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}`)
			}
		}
	}))
	defer srv.Close()
	sa, _ := json.Marshal(map[string]string{"project_id": "p", "client_email": "x@p.iam.gserviceaccount.com", "private_key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), "token_uri": srv.URL + "/token"})
	f, err := NewFCM(string(sa))
	if err != nil {
		t.Fatal(err)
	}
	if u, _ := url.Parse(f.SendURL); u.Path != "/v1/projects/p/messages:send" {
		t.Fatalf("send url %s", f.SendURL)
	}
	f.SendURL = srv.URL + "/send"
	res, err := f.SendFCM(context.Background(), "tok", Push{Kind: "door", Priority: "high"}, at)
	if err != nil || res.Status != 200 {
		t.Fatalf("send %v %v", res, err)
	}
	res, _ = f.SendFCM(context.Background(), "gone", Push{Kind: "door"}, at.Add(time.Minute))
	if !res.Gone || oauthCalls != 1 {
		t.Fatalf("gone=%v oauth calls=%d", res.Gone, oauthCalls)
	}
}

func TestRelayTokenIssuance(t *testing.T) {
	f := newFx(t, "")
	priv, hub := key(1)
	if code, out := f.req("POST", "/v1/relay/token", nil, f.jwt(priv, hubauth.AudRelayToken), nil); code != 503 || out["error"] != "not_configured" {
		t.Fatalf("unconfigured = %d %v", code, out)
	}
	pub, sk, _ := ed25519.GenerateKey(rand.Reader)
	f.s.SigningKey, f.s.RelayAddr, f.s.RelayPin = sk, "relay.vatra.test:8443", "PIN"
	code, out := f.req("POST", "/v1/relay/token", nil, f.jwt(priv, hubauth.AudRelayToken), nil)
	if code != 200 || out["relay"] != "relay.vatra.test:8443" || out["pin"] != "PIN" || out["host"] != hub+".vatra.test" {
		t.Fatalf("token = %d %v", code, out)
	}
	c, err := relaytoken.Verify(out["token"].(string), pub, f.now)
	if err != nil || c.Hub != hub || float64(c.Exp) != out["exp"] || c.Exp-c.Iat != 86400 {
		t.Fatalf("claims %+v %v", c, err)
	}
	if code, _ := f.req("POST", "/v1/relay/token", nil, f.jwt(priv, hubauth.AudPush), nil); code != 401 {
		t.Fatalf("wrong aud = %d", code)
	}

	g := newFx(t, "aaaaaaaaaaaaaaaa")
	g.s.SigningKey = sk
	if code, out := g.req("POST", "/v1/relay/token", nil, g.jwt(priv, hubauth.AudRelayToken), nil); code != 403 || out["error"] != "not_allowed" {
		t.Fatalf("allow list = %d %v", code, out)
	}
	// the allow list does not gate push
	h := g.handle(t, "fcm", "x", hub)
	if code, _ := g.req("POST", "/v1/push", alert(h), g.jwt(priv, hubauth.AudPush), nil); code != 200 {
		t.Fatalf("push with allow list = %d", code)
	}
}
