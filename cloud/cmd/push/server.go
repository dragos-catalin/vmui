package main

import (
	"crypto/cipher"
	"crypto/ed25519"
	"log"
	"net/http"
	"regexp"
	"time"

	"vatra.cloud/internal/httpx"
	"vatra.cloud/internal/hubauth"
	"vatra.cloud/internal/relaytoken"
)

// Server is the push relay + relay-token issuer.
type Server struct {
	Domain   string
	Handles  cipher.AEAD // nil = handle key missing
	Verifier *hubauth.Verifier
	APNs     APNsSender // nil = not configured
	FCM      FCMSender  // nil = not configured

	SigningKey ed25519.PrivateKey // nil = relay tokens not configured
	RelayAddr  string
	RelayPin   string

	Now  func() time.Time
	Logf func(string, ...any)

	perIP, perHandle, perHub, perHubCritical *httpx.Window
}

func NewServer(domain string, v *hubauth.Verifier) *Server {
	day := func(n int) *httpx.Window { return &httpx.Window{Limit: n, Period: 24 * time.Hour, Start: httpx.UTCDay} }
	return &Server{
		Domain:         domain,
		Verifier:       v,
		Now:            time.Now,
		Logf:           log.Printf,
		perIP:          &httpx.Window{Limit: 30, Period: time.Hour},
		perHandle:      day(500),
		perHub:         day(3000),
		perHubCritical: day(200),
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		httpx.JSON(w, 200, map[string]any{"ok": true, "apns": s.APNs != nil, "fcm": s.FCM != nil, "relayToken": s.SigningKey != nil})
	})
	mux.HandleFunc("POST /v1/handles", s.handles)
	mux.HandleFunc("POST /v1/push", s.push)
	mux.HandleFunc("POST /v1/relay/token", s.relayToken)
	return mux
}

func (s *Server) handles(w http.ResponseWriter, r *http.Request) {
	if s.Handles == nil {
		httpx.Error(w, 503, "not_configured")
		return
	}
	if ok, retry := s.perIP.Allow(httpx.ClientIP(r), s.Now()); !ok {
		httpx.JSON(w, 429, map[string]any{"error": "rate_limited", "retryAfter": retry})
		return
	}
	var body struct {
		Platform string `json:"platform"`
		Token    string `json:"token"`
		Hub      string `json:"hub"`
	}
	if err := httpx.Decode(r, 8192, &body); err != nil || !validPlatform(body.Platform) || body.Token == "" || len(body.Token) > 4096 || !hubauth.ValidHubID(body.Hub) {
		httpx.Error(w, 400, "bad_request")
		return
	}
	h, err := seal(s.Handles, handle{P: body.Platform, T: body.Token, H: body.Hub})
	if err != nil {
		httpx.Error(w, 500, "internal")
		return
	}
	s.Logf("handle hub=%s platform=%s status=200", body.Hub, body.Platform)
	httpx.JSON(w, 200, map[string]any{"handle": h})
}

var kindRe = regexp.MustCompile(`^[a-z_]{1,24}$`)

type pushBody struct {
	Handle   string            `json:"handle"`
	Type     string            `json:"type"`
	Priority string            `json:"priority"`
	Critical bool              `json:"critical"`
	Collapse string            `json:"collapse"`
	TTL      int               `json:"ttl"`
	Kind     string            `json:"kind"`
	Data     map[string]string `json:"data"`
	Activity *Activity         `json:"activity"`
}

func (b *pushBody) valid() bool {
	if b.Type == "" {
		b.Type = "alert"
	}
	if b.Priority == "" {
		b.Priority = "normal"
	}
	if b.Type != "alert" && b.Type != "background" && b.Type != "liveactivity" {
		return false
	}
	if b.Priority != "high" && b.Priority != "normal" {
		return false
	}
	if !kindRe.MatchString(b.Kind) || b.TTL < 0 || b.TTL > 28*24*3600 || len(b.Collapse) > 64 {
		return false
	}
	size := 0
	for k, v := range b.Data {
		size += len(k) + len(v)
	}
	if size > 3584 {
		return false
	}
	if b.Type == "liveactivity" && (b.Activity == nil || b.Activity.Event == "" || len(b.Activity.State) == 0) {
		return false
	}
	return true
}

func (s *Server) push(w http.ResponseWriter, r *http.Request) {
	now := s.Now()
	hub, err := s.Verifier.Request(r, hubauth.AudPush, now)
	if err != nil {
		st, code := hubauth.HTTPStatus(err)
		httpx.Error(w, st, code)
		return
	}
	var b pushBody
	if err := httpx.Decode(r, 16384, &b); err != nil || !b.valid() {
		httpx.Error(w, 400, "bad_request")
		return
	}
	if s.Handles == nil {
		httpx.JSON(w, 503, map[string]any{"error": "not_configured", "platform": "handles"})
		return
	}
	h, err := open(s.Handles, b.Handle)
	if err != nil {
		httpx.Error(w, 400, "bad_handle")
		return
	}
	if h.H != hub {
		s.Logf("push hub=%s kind=%s status=403 wrong_hub", hub, b.Kind)
		httpx.Error(w, 403, "wrong_hub")
		return
	}
	isAPNs := h.P == "apns" || h.P == "apns-sandbox"
	if (isAPNs && s.APNs == nil) || (!isAPNs && s.FCM == nil) {
		platform := "fcm"
		if isAPNs {
			platform = "apns"
		}
		httpx.JSON(w, 503, map[string]any{"error": "not_configured", "platform": platform})
		return
	}
	if !s.consume(w, b.Handle, hub, b.Critical, now) {
		return
	}
	p := Push{Type: b.Type, Priority: b.Priority, Critical: b.Critical, Collapse: b.Collapse, TTL: b.TTL, Kind: b.Kind, Data: b.Data, Activity: b.Activity}
	var res Result
	if isAPNs {
		res, err = s.APNs.SendAPNs(r.Context(), h.P == "apns-sandbox", h.T, p, now)
	} else {
		res, err = s.FCM.SendFCM(r.Context(), h.T, p, now)
	}
	if res.Gone {
		s.Logf("push hub=%s kind=%s platform=%s status=410 gone", hub, b.Kind, h.P)
		httpx.JSON(w, 200, map[string]any{"status": 410, "gone": true})
		return
	}
	if err != nil {
		s.Logf("push hub=%s kind=%s platform=%s status=502 provider=%d", hub, b.Kind, h.P, res.Status)
		httpx.JSON(w, 502, map[string]any{"error": "provider_failed", "status": res.Status})
		return
	}
	s.Logf("push hub=%s kind=%s platform=%s status=200", hub, b.Kind, h.P)
	httpx.JSON(w, 200, map[string]any{"status": 200})
}

// consume applies the per-handle, per-hub and critical day buckets; all or nothing.
func (s *Server) consume(w http.ResponseWriter, handleKey, hub string, critical bool, now time.Time) bool {
	refuse := func(retry int) bool {
		httpx.JSON(w, 429, map[string]any{"error": "rate_limited", "retryAfter": retry})
		return false
	}
	if ok, retry := s.perHandle.Allow(handleKey, now); !ok {
		return refuse(retry)
	}
	if critical {
		if ok, retry := s.perHubCritical.Allow(hub, now); !ok {
			s.perHandle.Refund(handleKey, now)
			return refuse(retry)
		}
		return true
	}
	if ok, retry := s.perHub.Allow(hub, now); !ok {
		s.perHandle.Refund(handleKey, now)
		return refuse(retry)
	}
	return true
}

func (s *Server) relayToken(w http.ResponseWriter, r *http.Request) {
	now := s.Now()
	hub, err := s.Verifier.Request(r, hubauth.AudRelayToken, now)
	if err != nil {
		st, code := hubauth.HTTPStatus(err)
		httpx.Error(w, st, code)
		return
	}
	if s.SigningKey == nil {
		httpx.JSON(w, 503, map[string]any{"error": "not_configured", "platform": "relay"})
		return
	}
	tok, c := relaytoken.Issue(hub, s.SigningKey, now, relaytoken.TTL)
	s.Logf("relay-token hub=%s status=200", hub)
	httpx.JSON(w, 200, map[string]any{"token": tok, "exp": c.Exp, "relay": s.RelayAddr, "pin": s.RelayPin, "host": hub + "." + s.Domain})
}
