// Package relaytoken issues and verifies "rt1.<payload>.<sig>" relay tokens (CONTRACT.md § Relay token).
package relaytoken

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"strings"
	"time"
)

const (
	Prefix = "rt1"
	TTL    = 24 * time.Hour
)

var (
	ErrInvalid = errors.New("invalid relay token")
	ErrExpired = errors.New("relay token expired")
	b64        = base64.RawURLEncoding
)

type Claims struct {
	Hub string `json:"hub"`
	Exp int64  `json:"exp"`
	Iat int64  `json:"iat"`
}

// Issue signs a token for hub valid for ttl from now.
func Issue(hub string, key ed25519.PrivateKey, now time.Time, ttl time.Duration) (string, Claims) {
	c := Claims{Hub: hub, Iat: now.Unix(), Exp: now.Add(ttl).Unix()}
	body, _ := json.Marshal(c)
	signing := Prefix + "." + b64.EncodeToString(body)
	return signing + "." + b64.EncodeToString(ed25519.Sign(key, []byte(signing))), c
}

// Verify checks the signature under pub and that the token has not expired at now.
func Verify(token string, pub ed25519.PublicKey, now time.Time) (Claims, error) {
	var c Claims
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != Prefix || len(pub) != ed25519.PublicKeySize {
		return c, ErrInvalid
	}
	sig, err := b64.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(pub, []byte(parts[0]+"."+parts[1]), sig) {
		return c, ErrInvalid
	}
	raw, err := b64.DecodeString(parts[1])
	if err != nil || json.Unmarshal(raw, &c) != nil || c.Hub == "" || c.Exp == 0 {
		return Claims{}, ErrInvalid
	}
	if now.Unix() >= c.Exp {
		return c, ErrExpired
	}
	return c, nil
}

// ParsePrivatePEM reads a PKCS8 PEM Ed25519 private key.
func ParsePrivatePEM(data []byte) (ed25519.PrivateKey, error) {
	blk, _ := pem.Decode(data)
	if blk == nil {
		return nil, errors.New("no PEM block")
	}
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		return nil, err
	}
	ek, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("not an Ed25519 key")
	}
	return ek, nil
}

// ParsePublic reads a raw 32-byte base64url (padding optional) public key, or a PEM SPKI key.
func ParsePublic(s string) (ed25519.PublicKey, error) {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "-----BEGIN") {
		blk, _ := pem.Decode([]byte(s))
		if blk == nil {
			return nil, errors.New("bad PEM")
		}
		k, err := x509.ParsePKIXPublicKey(blk.Bytes)
		if err != nil {
			return nil, err
		}
		if ek, ok := k.(ed25519.PublicKey); ok {
			return ek, nil
		}
		return nil, errors.New("not an Ed25519 key")
	}
	raw, err := b64.DecodeString(strings.TrimRight(s, "="))
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, errors.New("public key must be 32 raw bytes, base64url")
	}
	return ed25519.PublicKey(raw), nil
}

// EncodePublic returns the base64url raw form accepted by ParsePublic.
func EncodePublic(pub ed25519.PublicKey) string { return b64.EncodeToString(pub) }
