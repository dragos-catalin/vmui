package main

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"vatra.cloud/internal/hubauth"
	"vatra.cloud/internal/relaytoken"
)

// Config holds the relay's policy; zero durations/limits get the contract defaults in New.
type Config struct {
	Domain     string
	TokenPub   ed25519.PublicKey
	Deny       hubauth.List
	AdminToken string
	Pin        string

	MaxConns     int           // concurrent client connections per hub
	RatePerSec   float64       // new client connections per hub per second
	HelloTimeout time.Duration // ClientHello read deadline
	DialTimeout  time.Duration // wait for the hub's data connection
	PingEvery    time.Duration
	DeadAfter    time.Duration
	Logf         func(format string, args ...any)
}

type msg struct {
	T     string `json:"t"`
	Token string `json:"token,omitempty"`
	ID    string `json:"id,omitempty"`
	Hub   string `json:"hub,omitempty"`
	Exp   int64  `json:"exp,omitempty"`
	Error string `json:"error,omitempty"`
}

type hubConn struct {
	hub  string
	exp  int64
	conn net.Conn
	wmu  sync.Mutex

	// guarded by Relay.mu
	active int
	tokens float64
	last   time.Time

	once sync.Once
	done chan struct{}
}

func (h *hubConn) send(m msg) error {
	b, _ := json.Marshal(m)
	h.wmu.Lock()
	defer h.wmu.Unlock()
	_ = h.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, err := h.conn.Write(append(b, '\n'))
	return err
}

func (h *hubConn) close() {
	h.once.Do(func() {
		close(h.done)
		_ = h.conn.Close()
	})
}

// Relay is the SNI relay: public TLS passthrough on one side, hub control/data channels on the other.
type Relay struct {
	cfg Config

	mu      sync.Mutex
	hubs    map[string]*hubConn
	pending map[string]chan net.Conn
	killed  map[string]bool
	conns   atomic.Int64
}

func New(cfg Config) *Relay {
	if cfg.MaxConns == 0 {
		cfg.MaxConns = 64
	}
	if cfg.RatePerSec == 0 {
		cfg.RatePerSec = 20
	}
	if cfg.HelloTimeout == 0 {
		cfg.HelloTimeout = 5 * time.Second
	}
	if cfg.DialTimeout == 0 {
		cfg.DialTimeout = 10 * time.Second
	}
	if cfg.PingEvery == 0 {
		cfg.PingEvery = 25 * time.Second
	}
	if cfg.DeadAfter == 0 {
		cfg.DeadAfter = 75 * time.Second
	}
	if cfg.Logf == nil {
		cfg.Logf = log.Printf
	}
	return &Relay{cfg: cfg, hubs: map[string]*hubConn{}, pending: map[string]chan net.Conn{}, killed: map[string]bool{}}
}

func (r *Relay) denied(hub string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.killed[hub] || r.cfg.Deny.Has(hub)
}

// ServePublic accepts browser connections (the :443 side) until ln is closed.
func (r *Relay) ServePublic(ln net.Listener) error {
	for {
		c, err := ln.Accept()
		if err != nil {
			return err
		}
		go r.handleClient(c)
	}
}

// ServeHubs accepts hub control and data connections on a TLS listener until ln is closed.
func (r *Relay) ServeHubs(ln net.Listener) error {
	for {
		c, err := ln.Accept()
		if err != nil {
			return err
		}
		go r.handleHub(c)
	}
}

func newID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// admit reserves a client slot on the hub, applying the concurrency limit and the token bucket.
func (r *Relay) admit(hub string) (*hubConn, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	h := r.hubs[hub]
	if h == nil || r.killed[hub] || r.cfg.Deny.Has(hub) {
		return nil, false
	}
	now := time.Now()
	burst := r.cfg.RatePerSec
	h.tokens += now.Sub(h.last).Seconds() * r.cfg.RatePerSec
	if h.tokens > burst {
		h.tokens = burst
	}
	h.last = now
	if h.active >= r.cfg.MaxConns || h.tokens < 1 {
		return nil, false
	}
	h.tokens--
	h.active++
	return h, true
}

func (r *Relay) release(h *hubConn) {
	r.mu.Lock()
	h.active--
	r.mu.Unlock()
}

func (r *Relay) handleClient(c net.Conn) {
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(r.cfg.HelloTimeout))
	hello, sni, err := readClientHello(c)
	if err != nil {
		return
	}
	hub, ok := hubForSNI(sni, r.cfg.Domain)
	if !ok {
		return
	}
	h, ok := r.admit(hub)
	if !ok {
		return
	}
	defer r.release(h)
	r.conns.Add(1)
	defer r.conns.Add(-1)

	id := newID()
	ch := make(chan net.Conn, 1)
	r.mu.Lock()
	r.pending[id] = ch
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		delete(r.pending, id)
		r.mu.Unlock()
		select {
		case late := <-ch:
			_ = late.Close()
		default:
		}
	}()
	if err := h.send(msg{T: "dial", ID: id}); err != nil {
		h.close()
		return
	}
	var data net.Conn
	select {
	case data = <-ch:
	case <-time.After(r.cfg.DialTimeout):
		return
	case <-h.done:
		return
	}
	defer data.Close()

	src, _ := c.RemoteAddr().(*net.TCPAddr)
	dst, _ := c.LocalAddr().(*net.TCPAddr)
	if src == nil || dst == nil {
		return
	}
	_ = data.SetWriteDeadline(time.Now().Add(r.cfg.DialTimeout))
	if _, err := data.Write(append(proxyV2Header(src, dst), hello...)); err != nil {
		return
	}
	_ = c.SetDeadline(time.Time{})
	_ = data.SetDeadline(time.Time{})
	splice(c, data, h.done)
}

type closeWriter interface{ CloseWrite() error }

// splice copies both ways until both sides finish or the hub's control channel dies.
func splice(a, b net.Conn, hubDone <-chan struct{}) {
	var wg sync.WaitGroup
	cp := func(dst, src net.Conn) {
		defer wg.Done()
		_, _ = io.Copy(dst, src)
		if cw, ok := dst.(closeWriter); ok {
			_ = cw.CloseWrite()
		} else {
			_ = dst.Close()
		}
	}
	wg.Add(2)
	go cp(a, b)
	go cp(b, a)
	finished := make(chan struct{})
	go func() { wg.Wait(); close(finished) }()
	select {
	case <-finished:
	case <-hubDone:
		_ = a.Close()
		_ = b.Close()
		<-finished
	}
}

// bufConn keeps bytes the line reader already buffered.
type bufConn struct {
	net.Conn
	r *bufio.Reader
}

func (b *bufConn) Read(p []byte) (int, error) { return b.r.Read(p) }

func (b *bufConn) CloseWrite() error {
	if cw, ok := b.Conn.(closeWriter); ok {
		return cw.CloseWrite()
	}
	return b.Conn.Close()
}

func writeLine(c net.Conn, m msg) {
	b, _ := json.Marshal(m)
	_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, _ = c.Write(append(b, '\n'))
}

func readLine(br *bufio.Reader) (msg, error) {
	var m msg
	line, err := br.ReadSlice('\n')
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(line, &m); err != nil {
		return m, err
	}
	return m, nil
}

func (r *Relay) handleHub(c net.Conn) {
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	if tc, ok := c.(interface{ Handshake() error }); ok {
		if err := tc.Handshake(); err != nil {
			_ = c.Close()
			return
		}
	}
	br := bufio.NewReaderSize(c, 4096)
	first, err := readLine(br)
	if err != nil {
		_ = c.Close()
		return
	}
	switch first.T {
	case "data":
		_ = c.SetDeadline(time.Time{})
		r.mu.Lock()
		ch, ok := r.pending[first.ID]
		delete(r.pending, first.ID)
		if ok {
			ch <- &bufConn{Conn: c, r: br} // buffered 1, sole sender
		}
		r.mu.Unlock()
		if !ok {
			_ = c.Close()
		}
	case "hello":
		r.control(c, br, first.Token)
	default:
		writeLine(c, msg{T: "err", Error: "bad_request"})
		_ = c.Close()
	}
}

func (r *Relay) control(c net.Conn, br *bufio.Reader, token string) {
	claims, err := relaytoken.Verify(token, r.cfg.TokenPub, time.Now())
	if err != nil || !hubauth.ValidHubID(claims.Hub) {
		writeLine(c, msg{T: "err", Error: "unauthorized"})
		_ = c.Close()
		return
	}
	if r.denied(claims.Hub) {
		writeLine(c, msg{T: "err", Error: "not_allowed"})
		_ = c.Close()
		return
	}
	h := &hubConn{hub: claims.Hub, exp: claims.Exp, conn: c, done: make(chan struct{}), tokens: r.cfg.RatePerSec, last: time.Now()}
	r.mu.Lock()
	old := r.hubs[claims.Hub]
	r.hubs[claims.Hub] = h
	r.mu.Unlock()
	if old != nil {
		old.close()
	}
	r.cfg.Logf("hub %s connected", claims.Hub)
	if err := h.send(msg{T: "ok", Hub: claims.Hub, Exp: claims.Exp}); err != nil {
		r.drop(h)
		return
	}

	expiry := time.AfterFunc(time.Until(time.Unix(claims.Exp, 0)), h.close)
	defer expiry.Stop()
	go func() {
		t := time.NewTicker(r.cfg.PingEvery)
		defer t.Stop()
		for {
			select {
			case <-h.done:
				return
			case <-t.C:
				if h.send(msg{T: "ping"}) != nil {
					h.close()
					return
				}
			}
		}
	}()
	for {
		_ = c.SetReadDeadline(time.Now().Add(r.cfg.DeadAfter))
		if _, err := readLine(br); err != nil {
			break
		}
	}
	r.drop(h)
}

func (r *Relay) drop(h *hubConn) {
	h.close()
	r.mu.Lock()
	if r.hubs[h.hub] == h {
		delete(r.hubs, h.hub)
	}
	r.mu.Unlock()
	r.cfg.Logf("hub %s disconnected", h.hub)
}

// Kill refuses the hub until restart and drops its control channel (and so its client connections).
func (r *Relay) Kill(hub string) bool {
	r.mu.Lock()
	r.killed[hub] = true
	h := r.hubs[hub]
	r.mu.Unlock()
	if h != nil {
		h.close()
	}
	return h != nil
}

// Admin is the 127.0.0.1-only HTTP surface: /health, /pin, POST /admin/kill.
func (r *Relay) Admin() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		r.mu.Lock()
		n := len(r.hubs)
		r.mu.Unlock()
		writeJSON(w, 200, map[string]any{"ok": true, "hubs": n, "conns": r.conns.Load()})
	})
	mux.HandleFunc("GET /pin", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/plain")
		_, _ = io.WriteString(w, r.cfg.Pin+"\n")
	})
	mux.HandleFunc("POST /admin/kill", func(w http.ResponseWriter, req *http.Request) {
		got := req.Header.Get("x-admin-token")
		if r.cfg.AdminToken == "" || subtle.ConstantTimeCompare([]byte(got), []byte(r.cfg.AdminToken)) != 1 {
			writeJSON(w, 401, map[string]any{"error": "unauthorized"})
			return
		}
		var body struct {
			Hub string `json:"hub"`
		}
		if err := json.NewDecoder(io.LimitReader(req.Body, 4096)).Decode(&body); err != nil || !hubauth.ValidHubID(body.Hub) {
			writeJSON(w, 400, map[string]any{"error": "bad_request"})
			return
		}
		was := r.Kill(body.Hub)
		r.cfg.Logf("hub %s killed (connected=%v)", body.Hub, was)
		writeJSON(w, 200, map[string]any{"ok": true, "connected": was})
	})
	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

var errNoKey = errors.New("relay token public key missing: set VATRA_CLOUD_SIGNING_PUB or VATRA_CLOUD_SIGNING_PUB_FILE")
