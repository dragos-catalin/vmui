package main

import (
	"encoding/binary"
	"net"
)

var proxyV2Sig = []byte("\r\n\r\n\x00\r\nQUIT\n")

// proxyV2Header builds a PROXY protocol v2 PROXY/STREAM header for src → dst.
func proxyV2Header(src, dst *net.TCPAddr) []byte {
	h := append([]byte{}, proxyV2Sig...)
	s4, d4 := src.IP.To4(), dst.IP.To4()
	if s4 != nil && d4 != nil {
		h = append(h, 0x21, 0x11, 0, 12)
		h = append(h, s4...)
		h = append(h, d4...)
	} else {
		h = append(h, 0x21, 0x21, 0, 36)
		h = append(h, src.IP.To16()...)
		h = append(h, dst.IP.To16()...)
	}
	h = binary.BigEndian.AppendUint16(h, uint16(src.Port))
	return binary.BigEndian.AppendUint16(h, uint16(dst.Port))
}
