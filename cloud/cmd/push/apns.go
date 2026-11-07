package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Push is one validated send request.
type Push struct {
	Type     string // alert | background | liveactivity
	Priority string // high | normal
	Critical bool
	Collapse string
	TTL      int
	Kind     string
	Data     map[string]string
	Activity *Activity
}

type Activity struct {
	Event          string          `json:"event"`
	AttributesType string          `json:"attributesType"`
	Attributes     json.RawMessage `json:"attributes"`
	State          json.RawMessage `json:"state"`
}

// Result of a provider send.
type Result struct {
	Gone   bool
	Status int // provider HTTP status, for logs
}

// APNsSender delivers to Apple; sandbox selects api.sandbox.push.apple.com.
type APNsSender interface {
	SendAPNs(ctx context.Context, sandbox bool, token string, p Push, now time.Time) (Result, error)
}

// FCMSender delivers a data-only message through FCM HTTP v1.
type FCMSender interface {
	SendFCM(ctx context.Context, token string, p Push, now time.Time) (Result, error)
}

type apnsRequest struct {
	Headers map[string]string
	Body    []byte
}

func locAlert(kind string) map[string]any {
	return map[string]any{"title-loc-key": "VATRA_PUSH_TITLE_" + strings.ToUpper(kind), "loc-key": "VATRA_PUSH_BODY"}
}

// buildAPNs maps a Push to APNs headers and JSON body (CONTRACT.md § Send).
func buildAPNs(p Push, topic string, now time.Time) apnsRequest {
	h := map[string]string{"apns-topic": topic}
	if p.TTL > 0 {
		h["apns-expiration"] = strconv.FormatInt(now.Unix()+int64(p.TTL), 10)
	} else {
		h["apns-expiration"] = "0"
	}
	if p.Collapse != "" {
		h["apns-collapse-id"] = p.Collapse
	}
	high := p.Priority == "high"
	prio := "5"
	if high {
		prio = "10"
	}
	aps := map[string]any{}
	payload := map[string]any{"aps": aps}
	switch p.Type {
	case "background":
		h["apns-push-type"] = "background"
		h["apns-priority"] = "5"
		aps["content-available"] = 1
		payload["vatra"] = p.Data
	case "liveactivity":
		h["apns-push-type"] = "liveactivity"
		h["apns-topic"] = topic + ".push-type.liveactivity"
		h["apns-priority"] = prio
		a := p.Activity
		aps["timestamp"] = now.Unix()
		aps["event"] = a.Event
		if a.AttributesType != "" {
			aps["attributes-type"] = a.AttributesType
		}
		if len(a.Attributes) > 0 {
			aps["attributes"] = a.Attributes
		}
		aps["content-state"] = a.State
		aps["alert"] = locAlert(p.Kind)
		aps["stale-date"] = now.Unix() + 120
		aps["dismissal-date"] = now.Unix() + 300
		if high {
			aps["sound"] = "default"
		}
	default: // alert
		h["apns-push-type"] = "alert"
		h["apns-priority"] = prio
		aps["alert"] = locAlert(p.Kind)
		aps["mutable-content"] = 1
		aps["category"] = "vatra." + p.Kind
		if p.Collapse != "" {
			aps["thread-id"] = p.Collapse
		}
		if high {
			aps["interruption-level"] = "time-sensitive"
			aps["sound"] = "default"
		} else {
			aps["interruption-level"] = "active"
		}
		payload["vatra"] = p.Data
	}
	body, _ := json.Marshal(payload)
	return apnsRequest{Headers: h, Body: body}
}

// APNs talks HTTP/2 to Apple with an ES256 provider token.
type APNs struct {
	Key    *ecdsa.PrivateKey
	KeyID  string
	TeamID string
	Topic  string
	Client *http.Client
	// Hosts can be overridden in tests.
	ProdURL, SandboxURL string

	mu      sync.Mutex
	token   string
	tokenAt time.Time
}

func ParseP8(pemText string) (*ecdsa.PrivateKey, error) {
	blk, _ := pem.Decode([]byte(strings.TrimSpace(pemText)))
	if blk == nil {
		return nil, errors.New("APNs key: no PEM block")
	}
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		if ek, err2 := x509.ParseECPrivateKey(blk.Bytes); err2 == nil {
			return ek, nil
		}
		return nil, err
	}
	ek, ok := k.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("APNs key: not an EC key")
	}
	return ek, nil
}

func NewAPNs(key *ecdsa.PrivateKey, keyID, teamID, topic string) *APNs {
	return &APNs{
		Key: key, KeyID: keyID, TeamID: teamID, Topic: topic,
		Client:     &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{ForceAttemptHTTP2: true, MaxIdleConnsPerHost: 4, IdleConnTimeout: 10 * time.Minute}},
		ProdURL:    "https://api.push.apple.com",
		SandboxURL: "https://api.sandbox.push.apple.com",
	}
}

func es256(key *ecdsa.PrivateKey, signing string) (string, error) {
	sum := sha256.Sum256([]byte(signing))
	r, s, err := ecdsa.Sign(rand.Reader, key, sum[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return base64.RawURLEncoding.EncodeToString(sig), nil
}

// providerToken returns the cached ES256 JWT, re-signed every 50 minutes (Apple allows 20-60).
func (a *APNs) providerToken(now time.Time) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.token != "" && now.Sub(a.tokenAt) < 50*time.Minute {
		return a.token, nil
	}
	head, _ := json.Marshal(map[string]string{"alg": "ES256", "kid": a.KeyID})
	claims, _ := json.Marshal(map[string]any{"iss": a.TeamID, "iat": now.Unix()})
	signing := base64.RawURLEncoding.EncodeToString(head) + "." + base64.RawURLEncoding.EncodeToString(claims)
	sig, err := es256(a.Key, signing)
	if err != nil {
		return "", err
	}
	a.token, a.tokenAt = signing+"."+sig, now
	return a.token, nil
}

func (a *APNs) SendAPNs(ctx context.Context, sandbox bool, token string, p Push, now time.Time) (Result, error) {
	jwt, err := a.providerToken(now)
	if err != nil {
		return Result{}, err
	}
	req := buildAPNs(p, a.Topic, now)
	base := a.ProdURL
	if sandbox {
		base = a.SandboxURL
	}
	hr, err := http.NewRequestWithContext(ctx, "POST", base+"/3/device/"+token, bytes.NewReader(req.Body))
	if err != nil {
		return Result{}, err
	}
	for k, v := range req.Headers {
		hr.Header.Set(k, v)
	}
	hr.Header.Set("authorization", "bearer "+jwt)
	hr.Header.Set("content-type", "application/json")
	resp, err := a.Client.Do(hr)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()
	var reason struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&reason)
	return apnsResult(resp.StatusCode, reason.Reason)
}

func apnsResult(status int, reason string) (Result, error) {
	switch {
	case status == 200:
		return Result{Status: 200}, nil
	case status == 410 || reason == "BadDeviceToken" || reason == "Unregistered":
		return Result{Status: status, Gone: true}, nil
	case status == 403 && reason == "ExpiredProviderToken":
		return Result{Status: status}, fmt.Errorf("apns %d %s", status, reason)
	}
	return Result{Status: status}, fmt.Errorf("apns %d %s", status, reason)
}
