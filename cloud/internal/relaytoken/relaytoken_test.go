package relaytoken

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestRoundTrip(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Unix(1_800_000_000, 0)
	tok, c := Issue("72asyextvngonlc5", priv, now, TTL)
	if !strings.HasPrefix(tok, "rt1.") || c.Exp != now.Unix()+86400 {
		t.Fatalf("token %q claims %+v", tok, c)
	}
	got, err := Verify(tok, pub, now.Add(time.Hour))
	if err != nil || got.Hub != "72asyextvngonlc5" || got.Iat != now.Unix() {
		t.Fatalf("Verify = %+v, %v", got, err)
	}
	if _, err := Verify(tok, pub, now.Add(TTL)); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired: %v", err)
	}
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	if _, err := Verify(tok, other, now); !errors.Is(err, ErrInvalid) {
		t.Fatalf("wrong key: %v", err)
	}
	p := strings.Split(tok, ".")
	if _, err := Verify("rt2."+p[1]+"."+p[2], pub, now); !errors.Is(err, ErrInvalid) {
		t.Fatalf("prefix: %v", err)
	}
	forged, _ := Issue("aaaaaaaaaaaaaaaa", priv, now, TTL)
	fp := strings.Split(forged, ".")
	if _, err := Verify(p[0]+"."+fp[1]+"."+p[2], pub, now); !errors.Is(err, ErrInvalid) {
		t.Fatalf("swapped payload: %v", err)
	}
}

func TestKeyParsing(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(priv)
	k, err := ParsePrivatePEM(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	if err != nil || !k.Equal(priv) {
		t.Fatalf("ParsePrivatePEM: %v", err)
	}
	p, err := ParsePublic(EncodePublic(pub))
	if err != nil || !p.Equal(pub) {
		t.Fatalf("ParsePublic raw: %v", err)
	}
	spki, _ := x509.MarshalPKIXPublicKey(pub)
	p, err = ParsePublic(string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: spki})))
	if err != nil || !p.Equal(pub) {
		t.Fatalf("ParsePublic PEM: %v", err)
	}
	if _, err := ParsePublic("abc"); err == nil {
		t.Fatal("short key accepted")
	}
}
