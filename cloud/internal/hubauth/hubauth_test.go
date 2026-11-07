package hubauth

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

type vector struct {
	SeedHex string `json:"seedHex"`
	Pub     string `json:"pub"`
	HubID   string `json:"hubId"`
	Aud     string `json:"aud"`
	Iat     int64  `json:"iat"`
	JWT     string `json:"jwt"`
}

func loadVector(t *testing.T) vector {
	t.Helper()
	raw, err := os.ReadFile("testdata/vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func testKey(seed byte) ed25519.PrivateKey {
	s := make([]byte, ed25519.SeedSize)
	for i := range s {
		s[i] = seed
	}
	return ed25519.NewKeyFromSeed(s)
}

func TestVectorFromNodeHub(t *testing.T) {
	v := loadVector(t)
	pub, err := b64.DecodeString(v.Pub)
	if err != nil {
		t.Fatal(err)
	}
	if got := HubID(pub); got != v.HubID {
		t.Fatalf("HubID = %q, want %q", got, v.HubID)
	}
	seed, _ := hex.DecodeString(v.SeedHex)
	if got := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey); string(got) != string(pub) {
		t.Fatal("seed does not derive pub")
	}
	hub, err := New(List{}, List{}).Verify(v.JWT, v.Aud, time.Unix(v.Iat+10, 0))
	if err != nil || hub != v.HubID {
		t.Fatalf("Verify = %q, %v", hub, err)
	}
}

func TestRejections(t *testing.T) {
	v := loadVector(t)
	now := time.Unix(v.Iat+10, 0)
	parts := strings.Split(v.JWT, ".")
	sig, _ := b64.DecodeString(parts[2])
	sig[0] ^= 1
	tampered := parts[0] + "." + parts[1] + "." + b64.EncodeToString(sig)

	// same claims body but iss altered, re-signed by the right key: iss must equal hubId(pub)
	seed, _ := hex.DecodeString(v.SeedHex)
	priv := ed25519.NewKeyFromSeed(seed)
	var c claims
	raw, _ := b64.DecodeString(parts[1])
	_ = json.Unmarshal(raw, &c)
	c.Iss = "aaaaaaaaaaaaaaaa"
	body, _ := json.Marshal(c)
	signing := parts[0] + "." + b64.EncodeToString(body)
	badIss := signing + "." + b64.EncodeToString(ed25519.Sign(priv, []byte(signing)))

	cases := []struct {
		name, tok, aud string
		at             time.Time
	}{
		{"tampered signature", tampered, v.Aud, now},
		{"wrong audience", v.JWT, AudACME, now},
		{"expired", v.JWT, v.Aud, time.Unix(v.Iat+301, 0)},
		{"too early", v.JWT, v.Aud, time.Unix(v.Iat-61, 0)},
		{"iss != hubId(pub)", badIss, v.Aud, now},
		{"lifetime > 300", Mint(priv, AudPush, now, 301, "long-lived-jti-000001"), AudPush, now},
		{"short jti", Mint(priv, AudPush, now, 300, "short"), AudPush, now},
		{"garbage", "a.b.c", v.Aud, now},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := New(List{}, List{}).Verify(tc.tok, tc.aud, tc.at); !errors.Is(err, ErrUnauthorized) {
				t.Fatalf("err = %v, want unauthorized", err)
			}
		})
	}
}

func TestSkewAccepted(t *testing.T) {
	v := loadVector(t)
	if _, err := New(List{}, List{}).Verify(v.JWT, v.Aud, time.Unix(v.Iat-60, 0)); err != nil {
		t.Fatalf("60 s skew rejected: %v", err)
	}
}

func TestReplay(t *testing.T) {
	v := loadVector(t)
	ver := New(List{}, List{})
	now := time.Unix(v.Iat+10, 0)
	if _, err := ver.Verify(v.JWT, v.Aud, now); err != nil {
		t.Fatal(err)
	}
	if _, err := ver.Verify(v.JWT, v.Aud, now.Add(time.Second)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("replay err = %v", err)
	}
}

func TestAllowDeny(t *testing.T) {
	priv := testKey(9)
	hub := HubID(priv.Public().(ed25519.PublicKey))
	now := time.Unix(1_800_000_000, 0)
	n := 0
	tok := func(aud string) string {
		n++
		return Mint(priv, aud, now, 300, "allow-deny-jti-"+strings.Repeat("x", n))
	}
	other := ParseList("aaaaaaaaaaaaaaaa")

	// allow list does not apply to push
	if _, err := New(other, List{}).Verify(tok(AudPush), AudPush, now); err != nil {
		t.Fatalf("push with foreign allow list: %v", err)
	}
	for _, aud := range []string{AudACME, AudRelayToken} {
		if _, err := New(other, List{}).Verify(tok(aud), aud, now); !errors.Is(err, ErrNotAllowed) {
			t.Fatalf("%s not on allow list: %v", aud, err)
		}
		if _, err := New(ParseList(" "+hub+" ,x"), List{}).Verify(tok(aud), aud, now); err != nil {
			t.Fatalf("%s on allow list: %v", aud, err)
		}
		if _, err := New(ParseList("*"), List{}).Verify(tok(aud), aud, now); err != nil {
			t.Fatalf("%s with *: %v", aud, err)
		}
		if _, err := New(List{}, List{}).Verify(tok(aud), aud, now); err != nil {
			t.Fatalf("%s empty allow list: %v", aud, err)
		}
	}
	if _, err := New(List{}, ParseList(hub)).Verify(tok(AudPush), AudPush, now); !errors.Is(err, ErrNotAllowed) {
		t.Fatalf("deny: %v", err)
	}
	if _, err := New(ParseList("*"), ParseList("*")).Verify(tok(AudACME), AudACME, now); !errors.Is(err, ErrNotAllowed) {
		t.Fatalf("deny *: %v", err)
	}
}

func TestValidHubID(t *testing.T) {
	if !ValidHubID("72asyextvngonlc5") || ValidHubID("72asyextvngonlc1") || ValidHubID("short") || ValidHubID("72ASYEXTVNGONLC5") {
		t.Fatal("ValidHubID")
	}
}
