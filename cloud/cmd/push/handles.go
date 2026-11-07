package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
)

const handleAAD = "vatra-handle-v1"

var errBadHandle = errors.New("bad handle")

type handle struct {
	P string `json:"p"`
	T string `json:"t"`
	H string `json:"h"`
}

func validPlatform(p string) bool { return p == "apns" || p == "apns-sandbox" || p == "fcm" }

func newAEAD(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, errors.New("handle key must be 32 bytes")
	}
	b, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(b)
}

// seal returns "h1." + b64url(nonce ‖ AES-256-GCM(key, json, aad)).
func seal(aead cipher.AEAD, h handle) (string, error) {
	pt, _ := json.Marshal(h)
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return "h1." + base64.RawURLEncoding.EncodeToString(aead.Seal(nonce, nonce, pt, []byte(handleAAD))), nil
}

func open(aead cipher.AEAD, s string) (handle, error) {
	var h handle
	rest, ok := strings.CutPrefix(s, "h1.")
	if !ok {
		return h, errBadHandle
	}
	raw, err := base64.RawURLEncoding.DecodeString(rest)
	if err != nil || len(raw) < aead.NonceSize()+aead.Overhead() {
		return h, errBadHandle
	}
	pt, err := aead.Open(nil, raw[:aead.NonceSize()], raw[aead.NonceSize():], []byte(handleAAD))
	if err != nil || json.Unmarshal(pt, &h) != nil || !validPlatform(h.P) || h.T == "" {
		return handle{}, errBadHandle
	}
	return h, nil
}
