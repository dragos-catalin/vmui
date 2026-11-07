// Command relaylive is the live tunnel test against a deployed vatra-relay: it signs a short relay
// token with the cloud key (PEM in VATRA_CLOUD_SIGNING_KEY, never printed), connects a throwaway hub
// with the pin, serves HTTPS with a self-signed cert for <hub>.<domain> and browses it through :443.
package main

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"flag"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"vatra.cloud/internal/relaytest"
	"vatra.cloud/internal/relaytoken"
)

func main() {
	relay := flag.String("relay", "34.158.236.161", "relay host")
	pin := flag.String("pin", "", "relay SPKI pin")
	domain := flag.String("domain", "vatra.dragoscatalin.ro", "cloud domain")
	flag.Parse()

	blk, _ := pem.Decode([]byte(os.Getenv("VATRA_CLOUD_SIGNING_KEY")))
	if blk == nil {
		fail("VATRA_CLOUD_SIGNING_KEY is not a PEM key")
	}
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		fail(err.Error())
	}
	priv := k.(ed25519.PrivateKey)
	hub := "livetest" + strings.ToLower(fmt.Sprintf("%x", time.Now().Unix()%1e8))
	hub = (hub + "aaaaaaaaaaaaaaaa")[:16]
	hub = strings.Map(func(r rune) rune {
		if strings.ContainsRune("abcdefghijklmnopqrstuvwxyz234567", r) {
			return r
		}
		return 'a'
	}, hub)
	name := hub + "." + *domain
	tok, _ := relaytoken.Issue(hub, priv, time.Now(), 10*time.Minute)
	cert := selfSigned(name)
	clients := make(chan *net.TCPAddr, 1)
	serve := func(c net.Conn, client *net.TCPAddr) {
		clients <- client
		s := tls.Server(c, &tls.Config{Certificates: []tls.Certificate{cert}})
		defer s.Close()
		br := bufio.NewReader(s)
		req, err := http.ReadRequest(br)
		if err != nil {
			return
		}
		_ = req.Body.Close()
		_, _ = s.Write([]byte("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 11\r\nconnection: close\r\n\r\nvatra-relay"))
	}
	h, err := relaytest.Connect(*relay+":8443", *pin, tok, serve)
	if err != nil {
		fail("control: " + err.Error())
	}
	defer h.Close()
	fmt.Println("1. control channel up with pin, relay ok for this hub:", h.OK.Hub == hub)

	tr := &http.Transport{TLSClientConfig: &tls.Config{ServerName: name, InsecureSkipVerify: true}, DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext}
	cl := &http.Client{Transport: tr, Timeout: 20 * time.Second}
	req, _ := http.NewRequest("GET", "https://"+*relay+"/", nil)
	req.Host = name
	res, err := cl.Do(req)
	if err != nil {
		fail("browse: " + err.Error())
	}
	buf := make([]byte, 64)
	n, _ := res.Body.Read(buf)
	_ = res.Body.Close()
	cn := res.TLS.PeerCertificates[0].Subject.CommonName
	fmt.Printf("2. browser -> %s:443 SNI <hub>.%s -> %d %q, served by the hub's own cert: %v\n", *relay, *domain, res.StatusCode, string(buf[:n]), cn == name)
	select {
	case c := <-clients:
		ip := c.IP.String()
		fmt.Println("3. PROXY v2 client IP reached the hub:", ip != "" && ip != "<nil>")
	case <-time.After(2 * time.Second):
		fmt.Println("3. PROXY v2 client IP reached the hub: false")
	}
	d := &net.Dialer{Timeout: 8 * time.Second}
	_, err = tls.DialWithDialer(d, "tcp", *relay+":443", &tls.Config{ServerName: "zzzzzzzzzzzzzzzz." + *domain, InsecureSkipVerify: true})
	fmt.Println("4. unknown hub SNI refused:", err != nil)
}

func selfSigned(name string) tls.Certificate {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	t := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour)}
	der, _ := x509.CreateCertificate(rand.Reader, t, t, &k.PublicKey, k)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: k}
}

func fail(s string) {
	fmt.Fprintln(os.Stderr, "FAIL:", s)
	os.Exit(1)
}
