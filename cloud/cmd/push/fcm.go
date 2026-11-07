package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

type serviceAccount struct {
	ProjectID   string `json:"project_id"`
	ClientEmail string `json:"client_email"`
	PrivateKey  string `json:"private_key"`
	TokenURI    string `json:"token_uri"`
}

// FCM sends HTTP v1 data-only messages with a service-account OAuth token.
type FCM struct {
	sa      serviceAccount
	key     *rsa.PrivateKey
	Client  *http.Client
	SendURL string // https://fcm.googleapis.com/v1/projects/<id>/messages:send

	mu     sync.Mutex
	access string
	expiry time.Time
}

func NewFCM(saJSON string) (*FCM, error) {
	var sa serviceAccount
	if err := json.Unmarshal([]byte(saJSON), &sa); err != nil {
		return nil, fmt.Errorf("FCM service account: %w", err)
	}
	if sa.ProjectID == "" || sa.ClientEmail == "" || sa.PrivateKey == "" {
		return nil, errors.New("FCM service account: project_id, client_email and private_key are required")
	}
	if sa.TokenURI == "" {
		sa.TokenURI = "https://oauth2.googleapis.com/token"
	}
	blk, _ := pem.Decode([]byte(sa.PrivateKey))
	if blk == nil {
		return nil, errors.New("FCM service account: bad private_key")
	}
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		return nil, err
	}
	rk, ok := k.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("FCM service account: not an RSA key")
	}
	return &FCM{
		sa: sa, key: rk,
		Client:  &http.Client{Timeout: 15 * time.Second},
		SendURL: "https://fcm.googleapis.com/v1/projects/" + url.PathEscape(sa.ProjectID) + "/messages:send",
	}, nil
}

func (f *FCM) assertion(now time.Time) (string, error) {
	head, _ := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{
		"iss": f.sa.ClientEmail, "scope": "https://www.googleapis.com/auth/firebase.messaging",
		"aud": f.sa.TokenURI, "iat": now.Unix(), "exp": now.Unix() + 3600,
	})
	signing := base64.RawURLEncoding.EncodeToString(head) + "." + base64.RawURLEncoding.EncodeToString(claims)
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	return signing + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

func (f *FCM) accessToken(ctx context.Context, now time.Time) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.access != "" && now.Before(f.expiry) {
		return f.access, nil
	}
	a, err := f.assertion(now)
	if err != nil {
		return "", err
	}
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}, "assertion": {a}}
	req, err := http.NewRequestWithContext(ctx, "POST", f.sa.TokenURI, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("content-type", "application/x-www-form-urlencoded")
	resp, err := f.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if resp.StatusCode != 200 || json.NewDecoder(io.LimitReader(resp.Body, 16384)).Decode(&tok) != nil || tok.AccessToken == "" {
		return "", fmt.Errorf("fcm oauth status %d", resp.StatusCode)
	}
	if tok.ExpiresIn <= 0 {
		tok.ExpiresIn = 3600
	}
	f.access, f.expiry = tok.AccessToken, now.Add(time.Duration(tok.ExpiresIn-300)*time.Second)
	return f.access, nil
}

// buildFCM maps a Push to the HTTP v1 request body.
func buildFCM(token string, p Push) []byte {
	data := make(map[string]string, len(p.Data)+1)
	for k, v := range p.Data {
		data[k] = v
	}
	data["kind"] = p.Kind
	android := map[string]any{"priority": "NORMAL"}
	if p.Priority == "high" {
		android["priority"] = "HIGH"
	}
	if p.TTL > 0 {
		android["ttl"] = strconv.Itoa(p.TTL) + "s"
	} else {
		android["ttl"] = "0s"
	}
	if p.Collapse != "" {
		android["collapse_key"] = p.Collapse
	}
	b, _ := json.Marshal(map[string]any{"message": map[string]any{"token": token, "data": data, "android": android}})
	return b
}

func (f *FCM) SendFCM(ctx context.Context, token string, p Push, now time.Time) (Result, error) {
	access, err := f.accessToken(ctx, now)
	if err != nil {
		return Result{}, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", f.SendURL, bytes.NewReader(buildFCM(token, p)))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("authorization", "Bearer "+access)
	req.Header.Set("content-type", "application/json")
	resp, err := f.Client.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 16384))
	return fcmResult(resp.StatusCode, body)
}

func fcmResult(status int, body []byte) (Result, error) {
	if status == 200 {
		return Result{Status: 200}, nil
	}
	if status == 404 || bytes.Contains(body, []byte(`"UNREGISTERED"`)) {
		return Result{Status: status, Gone: true}, nil
	}
	return Result{Status: status}, fmt.Errorf("fcm %d", status)
}
