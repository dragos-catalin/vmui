// Command vatra-relay is the Vatra Cloud SNI relay (docs/product/cloud/CONTRACT.md § SNI relay).
package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"vatra.cloud/internal/hubauth"
	"vatra.cloud/internal/relaytoken"
)

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func main() {
	var (
		listen  = flag.String("listen", env("VATRA_RELAY_LISTEN", ":443"), "public TLS passthrough address")
		control = flag.String("control", env("VATRA_RELAY_CONTROL", ":8443"), "hub control/data TLS address")
		admin   = flag.String("admin", env("VATRA_RELAY_ADMIN", "127.0.0.1:9090"), "admin HTTP address (keep on loopback)")
		domain  = flag.String("domain", env("VATRA_CLOUD_DOMAIN", "vatra.dragoscatalin.ro"), "hub names are <hubId>.<domain>")
		state   = flag.String("state", env("VATRA_RELAY_STATE_DIR", "/var/lib/vatra-relay"), "state dir (control TLS key)")
	)
	flag.Parse()
	log.SetFlags(log.LstdFlags | log.LUTC)
	dom := strings.TrimSuffix(strings.ToLower(*domain), ".")

	pubText := os.Getenv("VATRA_CLOUD_SIGNING_PUB")
	if pubText == "" {
		if f := os.Getenv("VATRA_CLOUD_SIGNING_PUB_FILE"); f != "" {
			b, err := os.ReadFile(f)
			if err != nil {
				log.Fatalf("read signing pub: %v", err)
			}
			pubText = string(b)
		}
	}
	if pubText == "" {
		log.Fatal(errNoKey)
	}
	pub, err := relaytoken.ParsePublic(pubText)
	if err != nil {
		log.Fatalf("signing pub: %v", err)
	}

	cert, err := loadOrCreateCert(*state, "relay."+dom)
	if err != nil {
		log.Fatalf("control certificate: %v", err)
	}
	pin, err := spkiPin(cert)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("VATRA_CLOUD_RELAY_PIN=%s\n", pin)

	r := New(Config{
		Domain:     dom,
		TokenPub:   pub,
		Deny:       hubauth.ParseList(os.Getenv("VATRA_CLOUD_DENY_HUBS")),
		AdminToken: os.Getenv("VATRA_RELAY_ADMIN_TOKEN"),
		Pin:        pin,
	})

	pubLn, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	ctlLn, err := tls.Listen("tcp", *control, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13})
	if err != nil {
		log.Fatal(err)
	}
	go func() {
		srv := &http.Server{Addr: *admin, Handler: r.Admin(), ReadHeaderTimeout: 5 * time.Second}
		log.Fatal(srv.ListenAndServe())
	}()
	go func() { log.Fatal(r.ServeHubs(ctlLn)) }()
	log.Printf("relay up: public %s control %s admin %s domain %s", *listen, *control, *admin, dom)
	log.Fatal(r.ServePublic(pubLn))
}
