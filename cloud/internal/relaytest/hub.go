// Package relaytest is a Go version of the hub side of the SNI relay, for integration tests.
package relaytest

import (
	"bufio"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

type Msg struct {
	T     string `json:"t"`
	Token string `json:"token,omitempty"`
	ID    string `json:"id,omitempty"`
	Hub   string `json:"hub,omitempty"`
	Exp   int64  `json:"exp,omitempty"`
	Error string `json:"error,omitempty"`
}

// TLSConfig pins the relay's SPKI (base64url sha256) instead of trusting a CA.
func TLSConfig(pin string) *tls.Config {
	return &tls.Config{
		InsecureSkipVerify: true, // replaced by the pin check below
		MinVersion:         tls.VersionTLS13,
		VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 {
				return errors.New("no certificate")
			}
			leaf, err := x509.ParseCertificate(raw[0])
			if err != nil {
				return err
			}
			sum := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
			if base64.RawURLEncoding.EncodeToString(sum[:]) != pin {
				return errors.New("relay pin mismatch")
			}
			return nil
		},
	}
}

// Handler receives the client's stream after the PROXY v2 header and the original client address.
type Handler func(c net.Conn, client *net.TCPAddr)

// Hub is a connected control channel.
type Hub struct {
	Addr, Pin string
	OK        Msg
	conn      *tls.Conn
	wmu       sync.Mutex
	done      chan struct{}
}

func writeMsg(w io.Writer, m Msg) error {
	b, _ := json.Marshal(m)
	_, err := w.Write(append(b, '\n'))
	return err
}

// Connect opens the control channel, says hello and waits for ok/err. With serve != nil it
// answers dial requests in the background.
func Connect(addr, pin, token string, serve Handler) (*Hub, error) {
	d := &net.Dialer{Timeout: 5 * time.Second}
	c, err := tls.DialWithDialer(d, "tcp", addr, TLSConfig(pin))
	if err != nil {
		return nil, err
	}
	if err := writeMsg(c, Msg{T: "hello", Token: token}); err != nil {
		c.Close()
		return nil, err
	}
	br := bufio.NewReader(c)
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	line, err := br.ReadBytes('\n')
	if err != nil {
		c.Close()
		return nil, err
	}
	var m Msg
	if err := json.Unmarshal(line, &m); err != nil {
		c.Close()
		return nil, err
	}
	if m.T != "ok" {
		c.Close()
		return nil, fmt.Errorf("relay refused: %s", m.Error)
	}
	_ = c.SetReadDeadline(time.Time{})
	h := &Hub{Addr: addr, Pin: pin, OK: m, conn: c, done: make(chan struct{})}
	go h.loop(br, serve)
	return h, nil
}

// Done is closed when the relay drops the control channel.
func (h *Hub) Done() <-chan struct{} { return h.done }

func (h *Hub) Close() error { return h.conn.Close() }

func (h *Hub) loop(br *bufio.Reader, serve Handler) {
	defer close(h.done)
	defer h.conn.Close()
	for {
		line, err := br.ReadBytes('\n')
		if err != nil {
			return
		}
		var m Msg
		if json.Unmarshal(line, &m) != nil {
			return
		}
		switch m.T {
		case "ping":
			h.wmu.Lock()
			_ = writeMsg(h.conn, Msg{T: "pong"})
			h.wmu.Unlock()
		case "dial":
			if serve != nil {
				go h.dial(m.ID, serve)
			}
		}
	}
}

func (h *Hub) dial(id string, serve Handler) {
	c, err := tls.Dial("tcp", h.Addr, TLSConfig(h.Pin))
	if err != nil {
		return
	}
	defer c.Close()
	if writeMsg(c, Msg{T: "data", ID: id}) != nil {
		return
	}
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	client, err := ReadProxyV2(c)
	if err != nil {
		return
	}
	_ = c.SetReadDeadline(time.Time{})
	serve(c, client)
}

var sig = []byte("\r\n\r\n\x00\r\nQUIT\n")

// ReadProxyV2 consumes a PROXY protocol v2 header and returns the source address.
func ReadProxyV2(r io.Reader) (*net.TCPAddr, error) {
	hdr := make([]byte, 16)
	if _, err := io.ReadFull(r, hdr); err != nil {
		return nil, err
	}
	if string(hdr[:12]) != string(sig) || hdr[12] != 0x21 {
		return nil, errors.New("not a PROXY v2 header")
	}
	body := make([]byte, binary.BigEndian.Uint16(hdr[14:16]))
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	switch hdr[13] {
	case 0x11:
		if len(body) < 12 {
			return nil, errors.New("short TCP4 header")
		}
		return &net.TCPAddr{IP: net.IP(body[0:4]), Port: int(binary.BigEndian.Uint16(body[8:10]))}, nil
	case 0x21:
		if len(body) < 36 {
			return nil, errors.New("short TCP6 header")
		}
		return &net.TCPAddr{IP: net.IP(body[0:16]), Port: int(binary.BigEndian.Uint16(body[32:34]))}, nil
	}
	return nil, errors.New("unsupported PROXY family")
}
