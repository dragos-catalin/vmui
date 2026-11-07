// Command vatra-push is the push relay and relay-token issuer (docs/product/cloud/CONTRACT.md).
package main

import (
	"encoding/base64"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"vatra.cloud/internal/httpx"
	"vatra.cloud/internal/hubauth"
	"vatra.cloud/internal/relaytoken"
)

func envOr(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func main() {
	log.SetFlags(0)
	domain := strings.TrimSuffix(strings.ToLower(envOr("VATRA_CLOUD_DOMAIN", "vatra.dragoscatalin.ro")), ".")
	s := NewServer(domain, hubauth.FromEnv())

	if k := strings.TrimSpace(httpx.Env("VATRA_PUSH_HANDLE_KEY")); k != "" {
		raw, err := base64.StdEncoding.DecodeString(k)
		if err != nil {
			raw, err = base64.RawURLEncoding.DecodeString(strings.TrimRight(k, "="))
		}
		if err != nil {
			log.Fatal("VATRA_PUSH_HANDLE_KEY: not base64")
		}
		aead, err := newAEAD(raw)
		if err != nil {
			log.Fatalf("VATRA_PUSH_HANDLE_KEY: %v", err)
		}
		s.Handles = aead
	}

	if p8 := httpx.Env("APNS_KEY"); p8 != "" {
		key, err := ParseP8(p8)
		if err != nil {
			log.Fatalf("APNS_KEY: %v", err)
		}
		keyID, team := strings.TrimSpace(httpx.Env("APNS_KEY_ID")), strings.TrimSpace(httpx.Env("APNS_TEAM_ID"))
		if keyID == "" || team == "" {
			log.Fatal("APNS_KEY set but APNS_KEY_ID / APNS_TEAM_ID missing")
		}
		s.APNs = NewAPNs(key, keyID, team, envOr("APNS_TOPIC", "ro.vatra.app"))
	}

	if sa := httpx.Env("FCM_SERVICE_ACCOUNT_JSON"); sa != "" {
		f, err := NewFCM(sa)
		if err != nil {
			log.Fatal(err)
		}
		s.FCM = f
	}

	if pemText := httpx.Env("VATRA_CLOUD_SIGNING_KEY"); pemText != "" {
		k, err := relaytoken.ParsePrivatePEM([]byte(pemText))
		if err != nil {
			log.Fatalf("VATRA_CLOUD_SIGNING_KEY: %v", err)
		}
		s.SigningKey = k
	}
	s.RelayAddr = envOr("VATRA_CLOUD_RELAY", "relay."+domain+":8443")
	s.RelayPin = strings.TrimSpace(os.Getenv("VATRA_CLOUD_RELAY_PIN"))

	port := envOr("PORT", "8080")
	srv := &http.Server{Addr: ":" + port, Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	log.Printf("vatra-push on :%s domain=%s handles=%v apns=%v fcm=%v relayToken=%v", port, domain, s.Handles != nil, s.APNs != nil, s.FCM != nil, s.SigningKey != nil)
	log.Fatal(srv.ListenAndServe())
}
