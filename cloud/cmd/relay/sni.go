package main

import (
	"encoding/binary"
	"errors"
	"io"
	"strings"

	"vatra.cloud/internal/hubauth"
)

// maxHello bounds the bytes buffered before the hub is known.
const maxHello = 16 * 1024

var errBadHello = errors.New("bad ClientHello")

// readClientHello reads TLS records until one full ClientHello handshake message is buffered and
// returns every byte read (to replay to the hub) plus the server_name, lowercased, trailing dot removed.
func readClientHello(r io.Reader) ([]byte, string, error) {
	var raw, hs []byte
	hdr := make([]byte, 5)
	for {
		if _, err := io.ReadFull(r, hdr); err != nil {
			return raw, "", err
		}
		if hdr[0] != 0x16 || hdr[1] != 3 {
			return raw, "", errBadHello
		}
		n := int(binary.BigEndian.Uint16(hdr[3:5]))
		if n == 0 || len(raw)+5+n > maxHello {
			return raw, "", errBadHello
		}
		body := make([]byte, n)
		if _, err := io.ReadFull(r, body); err != nil {
			return raw, "", err
		}
		raw = append(append(raw, hdr...), body...)
		hs = append(hs, body...)
		if len(hs) < 4 {
			continue
		}
		if hs[0] != 1 {
			return raw, "", errBadHello
		}
		l := int(hs[1])<<16 | int(hs[2])<<8 | int(hs[3])
		if 4+l > maxHello {
			return raw, "", errBadHello
		}
		if len(hs) >= 4+l {
			sni, err := parseSNI(hs[4 : 4+l])
			return raw, sni, err
		}
	}
}

type cursor struct {
	b   []byte
	bad bool
}

func (c *cursor) take(n int) []byte {
	if c.bad || n < 0 || len(c.b) < n {
		c.bad = true
		return nil
	}
	out := c.b[:n]
	c.b = c.b[n:]
	return out
}

func (c *cursor) u8() int {
	b := c.take(1)
	if b == nil {
		return 0
	}
	return int(b[0])
}

func (c *cursor) u16() int {
	b := c.take(2)
	if b == nil {
		return 0
	}
	return int(binary.BigEndian.Uint16(b))
}

// parseSNI extracts the host_name from a ClientHello body (after the 4-byte handshake header).
func parseSNI(body []byte) (string, error) {
	c := &cursor{b: body}
	c.take(2)  // legacy_version
	c.take(32) // random
	c.take(c.u8())
	c.take(c.u16())
	c.take(c.u8())
	if c.bad {
		return "", errBadHello
	}
	if len(c.b) == 0 {
		return "", errBadHello // no extensions, so no SNI
	}
	ext := &cursor{b: c.take(c.u16())}
	if c.bad {
		return "", errBadHello
	}
	for len(ext.b) > 0 {
		typ := ext.u16()
		data := ext.take(ext.u16())
		if ext.bad {
			return "", errBadHello
		}
		if typ != 0 {
			continue
		}
		list := &cursor{b: data}
		names := &cursor{b: list.take(list.u16())}
		for len(names.b) > 0 && !names.bad {
			nt := names.u8()
			name := names.take(names.u16())
			if names.bad {
				break
			}
			if nt == 0 && len(name) > 0 && len(name) <= 253 {
				return strings.TrimSuffix(strings.ToLower(string(name)), "."), nil
			}
		}
		return "", errBadHello
	}
	return "", errBadHello
}

// hubForSNI returns the hub id when sni is exactly <hubId>.<domain>.
func hubForSNI(sni, domain string) (string, bool) {
	label, ok := strings.CutSuffix(sni, "."+domain)
	if !ok || !hubauth.ValidHubID(label) {
		return "", false
	}
	return label, true
}
