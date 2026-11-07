package main

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vatra.cloud/internal/hubauth"
	"vatra.cloud/internal/relaytest"
	"vatra.cloud/internal/relaytoken"
)

const testDomain = "vatra.test"

type rig struct {
	r        *Relay
	pub, ctl string
	pin      string
	key      ed25519.PrivateKey
}

func startRelay(t *testing.T, cfg Config) *rig {
	t.Helper()
	pubKey, priv, _ := ed25519.GenerateKey(rand.Reader)
	cert, err := loadOrCreateCert(t.TempDir(), "relay."+testDomain)
	if err != nil {
		t.Fatal(err)
	}
	pin, err := spkiPin(cert)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Domain, cfg.TokenPub, cfg.Pin = testDomain, pubKey, pin
	cfg.Logf = t.Logf
	r := New(cfg)
	pl, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	cl, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pl.Close(); cl.Close() })
	go r.ServePublic(pl)
	go r.ServeHubs(cl)
	return &rig{r: r, pub: pl.Addr().String(), ctl: cl.Addr().String(), pin: pin, key: priv}
}

func hubKey(seed byte) (ed25519.PrivateKey, string) {
	s := bytes.Repeat([]byte{seed}, ed25519.SeedSize)
	k := ed25519.NewKeyFromSeed(s)
	return k, hubauth.HubID(k.Public().(ed25519.PublicKey))
}

func (e *rig) token(hub string, ttl time.Duration) string {
	tok, _ := relaytoken.Issue(hub, e.key, time.Now(), ttl)
	return tok
}

// fakeSite terminates TLS for name with a fresh self-signed cert and answers one HTTP request "hello".
type fakeSite struct {
	cert    tls.Certificate
	pool    *x509.CertPool
	clients chan *net.TCPAddr
	hold    chan struct{} // when non-nil, the handler blocks until closed
}

func newSite(t *testing.T, name string) *fakeSite {
	t.Helper()
	cp, kp, err := selfSigned(name, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := tls.X509KeyPair(cp, kp)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(cp)
	return &fakeSite{cert: cert, pool: pool, clients: make(chan *net.TCPAddr, 16)}
}

func (s *fakeSite) serve(c net.Conn, client *net.TCPAddr) {
	s.clients <- client
	tc := tls.Server(c, &tls.Config{Certificates: []tls.Certificate{s.cert}})
	defer tc.Close()
	req, err := http.ReadRequest(bufio.NewReader(tc))
	if err != nil {
		return
	}
	_ = req.Body.Close()
	if s.hold != nil {
		<-s.hold
	}
	_, _ = io.WriteString(tc, "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello")
}

// browse makes one HTTPS request through the relay; it returns the body and the browser's local address.
func browse(addr, name string, pool *x509.CertPool) (string, *net.TCPAddr, error) {
	d := &net.Dialer{Timeout: 3 * time.Second}
	c, err := tls.DialWithDialer(d, "tcp", addr, &tls.Config{ServerName: name, RootCAs: pool})
	if err != nil {
		return "", nil, err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.WriteString(c, "GET / HTTP/1.1\r\nHost: "+name+"\r\n\r\n"); err != nil {
		return "", nil, err
	}
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", nil, err
	}
	if resp.StatusCode != 200 {
		return string(b), nil, io.ErrUnexpectedEOF
	}
	return string(b), c.LocalAddr().(*net.TCPAddr), nil
}

func TestTunnel(t *testing.T) {
	e := startRelay(t, Config{})
	_, hub := hubKey(1)
	name := hub + "." + testDomain
	site := newSite(t, name)
	h, err := relaytest.Connect(e.ctl, e.pin, e.token(hub, time.Hour), site.serve)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if h.OK.Hub != hub || h.OK.Exp == 0 {
		t.Fatalf("ok = %+v", h.OK)
	}

	// SNI is case-insensitive and may carry a trailing dot in the wild; use upper case here.
	body, local, err := browse(e.pub, strings.ToUpper(name), site.pool)
	if err != nil || body != "hello" {
		t.Fatalf("browse = %q, %v", body, err)
	}
	client := <-site.clients
	if !client.IP.Equal(local.IP) || client.Port != local.Port {
		t.Fatalf("PROXY client %v, browser %v", client, local)
	}
}

func TestPinMismatchRefused(t *testing.T) {
	e := startRelay(t, Config{})
	_, hub := hubKey(1)
	if _, err := relaytest.Connect(e.ctl, "AAAA", e.token(hub, time.Hour), nil); err == nil {
		t.Fatal("connected with a wrong pin")
	}
}

func TestUnknownSNIClosed(t *testing.T) {
	e := startRelay(t, Config{})
	_, hub := hubKey(1)
	_, other := hubKey(2)
	site := newSite(t, hub+"."+testDomain)
	h, err := relaytest.Connect(e.ctl, e.pin, e.token(hub, time.Hour), site.serve)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	for _, name := range []string{
		other + "." + testDomain,             // valid shape, no hub connected
		"x." + hub + "." + testDomain,        // extra label
		hub + ".evil.test",                   // other domain
		hub + "." + testDomain + ".evil.com", // suffix trick
		"localhost",
	} {
		if _, _, err := browse(e.pub, name, site.pool); err == nil {
			t.Fatalf("%s: got through", name)
		}
	}
	// garbage instead of a ClientHello
	c, err := net.Dial("tcp", e.pub)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(c, "GET / HTTP/1.1\r\n\r\n")
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if n, err := c.Read(make([]byte, 1)); err == nil || n > 0 {
		t.Fatal("plain HTTP not closed")
	}
	c.Close()
	select {
	case <-site.clients:
		t.Fatal("hub was dialled")
	default:
	}
}

func TestBadTokensRejected(t *testing.T) {
	e := startRelay(t, Config{})
	_, hub := hubKey(1)
	_, foreign, _ := ed25519.GenerateKey(rand.Reader)
	wrongKey, _ := relaytoken.Issue(hub, foreign, time.Now(), time.Hour)
	expired, _ := relaytoken.Issue(hub, e.key, time.Now().Add(-48*time.Hour), relaytoken.TTL)
	for name, tok := range map[string]string{"wrong signer": wrongKey, "expired": expired, "garbage": "rt1.x.y", "empty": ""} {
		if _, err := relaytest.Connect(e.ctl, e.pin, tok, nil); err == nil || !strings.Contains(err.Error(), "unauthorized") {
			t.Fatalf("%s: err = %v", name, err)
		}
	}
}

func TestWrongHubTokenDoesNotServeOtherHub(t *testing.T) {
	e := startRelay(t, Config{})
	_, a := hubKey(1)
	_, b := hubKey(2)
	site := newSite(t, b+"."+testDomain)
	h, err := relaytest.Connect(e.ctl, e.pin, e.token(a, time.Hour), site.serve)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if _, _, err := browse(e.pub, b+"."+testDomain, site.pool); err == nil {
		t.Fatal("hub A's control channel served hub B's name")
	}
}

func TestDenyListRefusesHello(t *testing.T) {
	_, hub := hubKey(1)
	e := startRelay(t, Config{Deny: hubauth.ParseList(hub)})
	if _, err := relaytest.Connect(e.ctl, e.pin, e.token(hub, time.Hour), nil); err == nil || !strings.Contains(err.Error(), "not_allowed") {
		t.Fatalf("err = %v", err)
	}
}

func TestKillSwitch(t *testing.T) {
	e := startRelay(t, Config{AdminToken: "s3cret"})
	_, hub := hubKey(1)
	name := hub + "." + testDomain
	site := newSite(t, name)
	h, err := relaytest.Connect(e.ctl, e.pin, e.token(hub, time.Hour), site.serve)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	admin := httptest.NewServer(e.r.Admin())
	defer admin.Close()

	kill := func(tok string) int {
		req, _ := http.NewRequest("POST", admin.URL+"/admin/kill", strings.NewReader(`{"hub":"`+hub+`"}`))
		req.Header.Set("x-admin-token", tok)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if got := kill("wrong"); got != 401 {
		t.Fatalf("wrong admin token = %d", got)
	}
	if got := kill("s3cret"); got != 200 {
		t.Fatalf("kill = %d", got)
	}
	select {
	case <-h.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("control channel not dropped")
	}
	if _, err := relaytest.Connect(e.ctl, e.pin, e.token(hub, time.Hour), site.serve); err == nil {
		t.Fatal("killed hub reconnected")
	}
	if _, _, err := browse(e.pub, name, site.pool); err == nil {
		t.Fatal("killed hub still served")
	}
	resp, err := http.Get(admin.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(b), `"ok":true`) || !strings.Contains(string(b), `"hubs":0`) {
		t.Fatalf("health = %s", b)
	}
}

func TestNewerControlReplacesOlder(t *testing.T) {
	e := startRelay(t, Config{})
	_, hub := hubKey(1)
	site := newSite(t, hub+"."+testDomain)
	first, err := relaytest.Connect(e.ctl, e.pin, e.token(hub, time.Hour), nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := relaytest.Connect(e.ctl, e.pin, e.token(hub, time.Hour), site.serve)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	select {
	case <-first.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("older control connection kept")
	}
	if body, _, err := browse(e.pub, hub+"."+testDomain, site.pool); err != nil || body != "hello" {
		t.Fatalf("newer channel does not serve: %q %v", body, err)
	}
}

func TestTokenExpiryClosesControl(t *testing.T) {
	e := startRelay(t, Config{})
	_, hub := hubKey(1)
	h, err := relaytest.Connect(e.ctl, e.pin, e.token(hub, 2*time.Second), nil)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-h.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("control channel outlived its token")
	}
}

func TestConcurrencyLimit(t *testing.T) {
	e := startRelay(t, Config{MaxConns: 1})
	_, hub := hubKey(1)
	name := hub + "." + testDomain
	site := newSite(t, name)
	site.hold = make(chan struct{})
	h, err := relaytest.Connect(e.ctl, e.pin, e.token(hub, time.Hour), site.serve)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	firstDone := make(chan error, 1)
	go func() { _, _, err := browse(e.pub, name, site.pool); firstDone <- err }()
	<-site.clients // first connection is inside the hub
	if _, _, err := browse(e.pub, name, site.pool); err == nil {
		t.Fatal("second concurrent connection admitted with MaxConns=1")
	}
	close(site.hold)
	if err := <-firstDone; err != nil {
		t.Fatalf("first connection: %v", err)
	}
	if body, _, err := browse(e.pub, name, site.pool); err != nil || body != "hello" {
		t.Fatalf("slot not released: %v", err)
	}
}

func TestRateLimit(t *testing.T) {
	e := startRelay(t, Config{RatePerSec: 2})
	_, hub := hubKey(1)
	name := hub + "." + testDomain
	site := newSite(t, name)
	h, err := relaytest.Connect(e.ctl, e.pin, e.token(hub, time.Hour), site.serve)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	ok := 0
	for i := 0; i < 4; i++ {
		if _, _, err := browse(e.pub, name, site.pool); err == nil {
			ok++
		}
	}
	if ok < 2 || ok > 3 {
		t.Fatalf("%d of 4 rapid connections admitted with 2/s", ok)
	}
}

func TestSNIParser(t *testing.T) {
	// capture a real crypto/tls ClientHello
	a, b := net.Pipe()
	go func() {
		c := tls.Client(a, &tls.Config{ServerName: "abc.Example.org", InsecureSkipVerify: true})
		_ = c.Handshake()
	}()
	_ = b.SetDeadline(time.Now().Add(3 * time.Second))
	raw, sni, err := readClientHello(b)
	b.Close()
	a.Close()
	if err != nil || sni != "abc.example.org" || len(raw) < 50 {
		t.Fatalf("sni = %q, %v (%d bytes)", sni, err, len(raw))
	}
	// handshake length beyond the 16 KB bound
	bad := append([]byte{}, raw...)
	bad[6] = 0xff
	if _, _, err := readClientHello(bytes.NewReader(bad)); err == nil {
		t.Fatal("corrupt hello accepted")
	}
	if _, ok := hubForSNI("72asyextvngonlc5."+testDomain, testDomain); !ok {
		t.Fatal("valid host refused")
	}
	if _, ok := hubForSNI("72asyextvngonlc1."+testDomain, testDomain); ok {
		t.Fatal("invalid base32 accepted")
	}
}

func TestProxyV2(t *testing.T) {
	for _, tc := range []struct{ src, dst string }{{"203.0.113.7:51000", "10.0.0.1:443"}, {"[2001:db8::1]:51000", "[2001:db8::2]:443"}} {
		s, _ := net.ResolveTCPAddr("tcp", tc.src)
		d, _ := net.ResolveTCPAddr("tcp", tc.dst)
		got, err := relaytest.ReadProxyV2(bytes.NewReader(proxyV2Header(s, d)))
		if err != nil || !got.IP.Equal(s.IP) || got.Port != s.Port {
			t.Fatalf("%s: %v %v", tc.src, got, err)
		}
	}
}
