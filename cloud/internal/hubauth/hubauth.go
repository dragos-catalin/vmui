// Package hubauth verifies the self-certifying hub JWTs described in docs/product/cloud/CONTRACT.md.
package hubauth

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	AudPush       = "vatra-push"
	AudACME       = "vatra-acme"
	AudRelayToken = "vatra-relay-token"

	MaxLifetime  = 300 // exp - iat, seconds
	Skew         = 60  // now may be up to Skew seconds before iat
	ReplayWindow = 10 * time.Minute
)

var (
	ErrUnauthorized = errors.New("unauthorized")
	ErrNotAllowed   = errors.New("not_allowed")
)

var (
	b32 = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)
	b64 = base64.RawURLEncoding
)

// HubID is lowercase base32 (no padding) of the first 10 bytes of sha256(raw public key): 16 chars [a-z2-7].
func HubID(pub []byte) string {
	sum := sha256.Sum256(pub)
	return b32.EncodeToString(sum[:10])
}

// ValidHubID reports whether s has the shape of a hub id.
func ValidHubID(s string) bool {
	if len(s) != 16 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z') && !(c >= '2' && c <= '7') {
			return false
		}
	}
	return true
}

// List is a comma separated hub list; "*" matches every hub.
type List struct {
	all bool
	set map[string]bool
}

func ParseList(s string) List {
	l := List{set: map[string]bool{}}
	for _, p := range strings.Split(s, ",") {
		p = strings.ToLower(strings.TrimSpace(p))
		switch p {
		case "":
		case "*":
			l.all = true
		default:
			l.set[p] = true
		}
	}
	return l
}

func (l List) Empty() bool         { return !l.all && len(l.set) == 0 }
func (l List) Has(hub string) bool { return l.all || l.set[hub] }

// Verifier checks hub JWTs and remembers jti values for ReplayWindow.
type Verifier struct {
	Allow, Deny List

	mu        sync.Mutex
	seen      map[string]int64
	lastPrune int64
}

func New(allow, deny List) *Verifier {
	return &Verifier{Allow: allow, Deny: deny, seen: map[string]int64{}}
}

// FromEnv reads VATRA_CLOUD_ALLOW_HUBS and VATRA_CLOUD_DENY_HUBS.
func FromEnv() *Verifier {
	return New(ParseList(os.Getenv("VATRA_CLOUD_ALLOW_HUBS")), ParseList(os.Getenv("VATRA_CLOUD_DENY_HUBS")))
}

type header struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
}

type claims struct {
	Iss string `json:"iss"`
	Aud string `json:"aud"`
	Iat int64  `json:"iat"`
	Exp int64  `json:"exp"`
	Jti string `json:"jti"`
	Pub string `json:"pub"`
}

func validJti(s string) bool {
	if len(s) < 16 || len(s) > 128 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z') && !(c >= '0' && c <= '9') && c != '-' && c != '_' {
			return false
		}
	}
	return true
}

// allowListed reports whether the allow list applies to this audience (ACME + relay tokens only).
func allowListed(aud string) bool { return aud == AudACME || aud == AudRelayToken }

// Verify checks token for aud at now and returns the caller's hub id.
func (v *Verifier) Verify(token, aud string, now time.Time) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", ErrUnauthorized
	}
	var h header
	if raw, err := b64.DecodeString(parts[0]); err != nil || json.Unmarshal(raw, &h) != nil || h.Alg != "EdDSA" {
		return "", ErrUnauthorized
	}
	var c claims
	if raw, err := b64.DecodeString(parts[1]); err != nil || json.Unmarshal(raw, &c) != nil {
		return "", ErrUnauthorized
	}
	pub, err := b64.DecodeString(c.Pub)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return "", ErrUnauthorized
	}
	sig, err := b64.DecodeString(parts[2])
	if err != nil || len(sig) != ed25519.SignatureSize {
		return "", ErrUnauthorized
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), []byte(parts[0]+"."+parts[1]), sig) {
		return "", ErrUnauthorized
	}
	hub := HubID(pub)
	if c.Iss != hub || c.Aud != aud {
		return "", ErrUnauthorized
	}
	if c.Exp < c.Iat || c.Exp-c.Iat > MaxLifetime {
		return "", ErrUnauthorized
	}
	n := now.Unix()
	if n < c.Iat-Skew || n > c.Exp {
		return "", ErrUnauthorized
	}
	if !validJti(c.Jti) || !v.remember(hub+"/"+c.Jti, n) {
		return "", ErrUnauthorized
	}
	if v.Deny.Has(hub) {
		return "", ErrNotAllowed
	}
	if allowListed(aud) && !v.Allow.Empty() && !v.Allow.Has(hub) {
		return "", ErrNotAllowed
	}
	return hub, nil
}

// remember records key and returns false when it was already seen inside the replay window.
func (v *Verifier) remember(key string, now int64) bool {
	win := int64(ReplayWindow / time.Second)
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.seen == nil {
		v.seen = map[string]int64{}
	}
	if now-v.lastPrune > 30 {
		for k, t := range v.seen {
			if now-t > win {
				delete(v.seen, k)
			}
		}
		v.lastPrune = now
	}
	if t, ok := v.seen[key]; ok && now-t <= win {
		return false
	}
	v.seen[key] = now
	return true
}

// Request verifies the Authorization: Bearer header of r.
func (v *Verifier) Request(r *http.Request, aud string, now time.Time) (string, error) {
	h := r.Header.Get("Authorization")
	const p = "bearer "
	if len(h) <= len(p) || !strings.EqualFold(h[:len(p)], p) {
		return "", ErrUnauthorized
	}
	return v.Verify(strings.TrimSpace(h[len(p):]), aud, now)
}

// HTTPStatus maps a Verify error to the contract's status and error code.
func HTTPStatus(err error) (int, string) {
	if errors.Is(err, ErrNotAllowed) {
		return http.StatusForbidden, "not_allowed"
	}
	return http.StatusUnauthorized, "unauthorized"
}

// Mint signs a hub JWT exactly like src/lib/cloud/identity.ts (used by tests and tools).
func Mint(priv ed25519.PrivateKey, aud string, now time.Time, ttl int64, jti string) string {
	pub := priv.Public().(ed25519.PublicKey)
	head, _ := json.Marshal(header{Alg: "EdDSA", Typ: "JWT"})
	body, _ := json.Marshal(claims{Iss: HubID(pub), Aud: aud, Iat: now.Unix(), Exp: now.Unix() + ttl, Jti: jti, Pub: b64.EncodeToString(pub)})
	signing := b64.EncodeToString(head) + "." + b64.EncodeToString(body)
	return signing + "." + b64.EncodeToString(ed25519.Sign(priv, []byte(signing)))
}
