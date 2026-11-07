// Package httpx holds the small HTTP helpers shared by the Cloud Run services.
package httpx

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func Error(w http.ResponseWriter, status int, code string) {
	JSON(w, status, map[string]any{"error": code})
}

// Decode reads a JSON body of at most limit bytes into v.
func Decode(r *http.Request, limit int64, v any) error {
	return json.NewDecoder(io.LimitReader(r.Body, limit)).Decode(v)
}

// Env returns the variable, or the content of the file named by <k>_FILE, or "".
func Env(k string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	if f := os.Getenv(k + "_FILE"); f != "" {
		if b, err := os.ReadFile(f); err == nil {
			return string(b)
		}
	}
	return ""
}

// ClientIP is the first X-Forwarded-For hop (Cloud Run sets it), else the peer address.
func ClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		first, _, _ := strings.Cut(xff, ",")
		if s := strings.TrimSpace(first); s != "" {
			return s
		}
	}
	host := r.RemoteAddr
	if i := strings.LastIndexByte(host, ':'); i > 0 {
		host = host[:i]
	}
	return strings.Trim(host, "[]")
}

// Window is a fixed-window counter per key ("n per period"), in memory.
type Window struct {
	Limit  int
	Period time.Duration
	// Start, when set, maps a time to the start of its window (e.g. UTC midnight). Default: aligned to Period.
	Start func(time.Time) time.Time

	mu sync.Mutex
	m  map[string]*slot
}

type slot struct {
	start time.Time
	n     int
}

func (w *Window) start(now time.Time) time.Time {
	if w.Start != nil {
		return w.Start(now)
	}
	return now.Truncate(w.Period)
}

// Allow consumes one unit for key. On refusal it returns the seconds until the window resets.
func (w *Window) Allow(key string, now time.Time) (bool, int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.m == nil {
		w.m = map[string]*slot{}
	}
	st := w.start(now)
	s := w.m[key]
	if s == nil || !s.start.Equal(st) {
		if len(w.m) > 100_000 {
			for k, v := range w.m {
				if !v.start.Equal(st) {
					delete(w.m, k)
				}
			}
		}
		s = &slot{start: st}
		w.m[key] = s
	}
	if s.n >= w.Limit {
		retry := int(st.Add(w.Period).Sub(now).Seconds()) + 1
		return false, retry
	}
	s.n++
	return true, 0
}

// Refund gives back one unit (used when a later limit refuses the same request).
func (w *Window) Refund(key string, now time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if s := w.m[key]; s != nil && s.start.Equal(w.start(now)) && s.n > 0 {
		s.n--
	}
}

// UTCDay starts windows at UTC midnight.
func UTCDay(t time.Time) time.Time {
	y, m, d := t.UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}
