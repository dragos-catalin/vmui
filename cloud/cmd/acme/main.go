// Command vatra-acme is the ACME DNS-01 proxy (docs/product/cloud/CONTRACT.md § ACME DNS-01 proxy).
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"vatra.cloud/internal/httpx"
	"vatra.cloud/internal/hubauth"
)

type Server struct {
	Domain   string
	Upstream string // Brivio ACME endpoint
	Token    string // Brivio brv_dns_ bearer; never logged
	Verifier *hubauth.Verifier
	Client   *http.Client
	Limit    *httpx.Window
	Now      func() time.Time
	Logf     func(string, ...any)
}

func NewServer(domain, upstream, token string, v *hubauth.Verifier) *Server {
	return &Server{
		Domain:   strings.TrimSuffix(strings.ToLower(domain), "."),
		Upstream: upstream,
		Token:    strings.TrimSpace(token),
		Verifier: v,
		Client:   &http.Client{Timeout: 30 * time.Second},
		Limit:    &httpx.Window{Limit: 10, Period: time.Hour},
		Now:      time.Now,
		Logf:     log.Printf,
	}
}

// allowedFQDN reports whether fqdn is exactly _acme-challenge.<hub>.<domain> (trailing dot optional,
// case-insensitive) and returns it normalised without the trailing dot.
func (s *Server) allowedFQDN(fqdn, hub string) (string, bool) {
	n := strings.ToLower(strings.TrimSuffix(fqdn, "."))
	want := "_acme-challenge." + hub + "." + s.Domain
	return want, n == want
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		httpx.JSON(w, 200, map[string]any{"ok": true, "configured": s.Token != ""})
	})
	mux.HandleFunc("POST /present", func(w http.ResponseWriter, r *http.Request) { s.handle(w, r, "present") })
	mux.HandleFunc("POST /cleanup", func(w http.ResponseWriter, r *http.Request) { s.handle(w, r, "cleanup") })
	return mux
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request, action string) {
	now := s.Now()
	hub, err := s.Verifier.Request(r, hubauth.AudACME, now)
	if err != nil {
		st, code := hubauth.HTTPStatus(err)
		httpx.Error(w, st, code)
		return
	}
	var body struct {
		FQDN  string `json:"fqdn"`
		Value string `json:"value"`
	}
	if err := httpx.Decode(r, 8192, &body); err != nil || body.Value == "" || len(body.Value) > 512 {
		httpx.Error(w, 400, "bad_request")
		return
	}
	fqdn, ok := s.allowedFQDN(body.FQDN, hub)
	if !ok {
		s.Logf("acme %s hub=%s status=403 forbidden_name", action, hub)
		httpx.Error(w, 403, "forbidden_name")
		return
	}
	if ok, retry := s.Limit.Allow(hub, now); !ok {
		httpx.JSON(w, 429, map[string]any{"error": "rate_limited", "retryAfter": retry})
		return
	}
	if s.Token == "" {
		httpx.Error(w, 503, "not_configured")
		return
	}
	if err := s.forward(r.Context(), fqdn, body.Value, action); err != nil {
		s.Logf("acme %s hub=%s status=502 upstream: %v", action, hub, err)
		httpx.Error(w, 502, "dns_failed")
		return
	}
	s.Logf("acme %s hub=%s status=200", action, hub)
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

type upstreamError struct{ status int }

func (e upstreamError) Error() string { return "status " + http.StatusText(e.status) }

func (s *Server) forward(ctx context.Context, fqdn, value, action string) error {
	b, _ := json.Marshal(map[string]string{"fqdn": fqdn, "value": value, "action": action})
	req, err := http.NewRequestWithContext(ctx, "POST", s.Upstream, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+s.Token)
	resp, err := s.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return upstreamError{resp.StatusCode}
	}
	return nil
}

func main() {
	log.SetFlags(0)
	domain := os.Getenv("VATRA_CLOUD_DOMAIN")
	if domain == "" {
		domain = "vatra.dragoscatalin.ro"
	}
	upstream := os.Getenv("BRIVIO_ACME_URL")
	if upstream == "" {
		upstream = "https://brivio.ro/api/dns/acme"
	}
	s := NewServer(domain, upstream, httpx.Env("BRIVIO_ACME_TOKEN"), hubauth.FromEnv())
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	srv := &http.Server{Addr: ":" + port, Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	log.Printf("vatra-acme on :%s domain=%s configured=%v", port, s.Domain, s.Token != "")
	log.Fatal(srv.ListenAndServe())
}
