// kontract-theme-ship-it — the Ship It! retro arcade theme.
// Serves the static frontend; all kontract logic lives in the browser.
//
// Assets are embedded in the binary (go:embed) because cloud-native
// buildpacks strip source files from the final image — a bare
// http.Dir("static") would 404 in production.
//
// The one piece of server logic: hosted share cards. LinkedIn (and every
// other share target) only renders an image it can crawl from OpenGraph
// tags, so the game POSTs its rendered universe card here and shares the
// resulting public page. Cards are ephemeral by design — in-memory, capped,
// and pruned; a share card's job is done within hours of posting.
package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"io/fs"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

//go:embed all:static
var assets embed.FS

type shareCard struct {
	png []byte
	at  time.Time
}

var (
	cardsMu sync.Mutex
	cards   = map[string]shareCard{}
)

const (
	maxCardBytes = 3 << 20 // a 1200x630 PNG card is ~200-600 KB
	maxCards     = 300
	cardTTL      = 48 * time.Hour
)

var shareIDRe = regexp.MustCompile(`^[a-f0-9]{32}$`)

func pruneCardsLocked() {
	cutoff := time.Now().Add(-cardTTL)
	for id, c := range cards {
		if c.at.Before(cutoff) {
			delete(cards, id)
		}
	}
	// Hard cap: drop oldest first if a burst outruns the TTL.
	for len(cards) >= maxCards {
		oldestID, oldest := "", time.Now()
		for id, c := range cards {
			if c.at.Before(oldest) {
				oldestID, oldest = id, c.at
			}
		}
		delete(cards, oldestID)
	}
}

func externalBase(r *http.Request) string {
	scheme := "https"
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		scheme = p
	} else if strings.HasPrefix(r.Host, "localhost") || strings.HasPrefix(r.Host, "127.") {
		scheme = "http"
	}
	return scheme + "://" + r.Host
}

func postShareCard(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxCardBytes))
	if err != nil {
		http.Error(w, "card too large", http.StatusRequestEntityTooLarge)
		return
	}
	// PNG magic — this endpoint hosts share cards, not arbitrary files.
	if len(body) < 8 || string(body[1:4]) != "PNG" {
		http.Error(w, "not a png", http.StatusUnsupportedMediaType)
		return
	}
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		http.Error(w, "id generation failed", http.StatusInternalServerError)
		return
	}
	id := hex.EncodeToString(raw)
	cardsMu.Lock()
	pruneCardsLocked()
	cards[id] = shareCard{png: body, at: time.Now()}
	cardsMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{ //nolint:errcheck
		"url":       externalBase(r) + "/share/" + id,
		"image_url": externalBase(r) + "/share/" + id + ".png",
	})
}

func getShare(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/share/")
	id, isPNG := strings.TrimSuffix(rest, ".png"), strings.HasSuffix(rest, ".png")
	if !shareIDRe.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	cardsMu.Lock()
	c, ok := cards[id]
	cardsMu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	if isPNG {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Write(c.png) //nolint:errcheck
		return
	}
	img := html.EscapeString(externalBase(r) + "/share/" + id + ".png")
	page := html.EscapeString(externalBase(r) + "/share/" + id)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>My Konstruct universe — SHIP IT!</title>
<meta property="og:type" content="website">
<meta property="og:title" content="My Konstruct universe — SHIP IT!">
<meta property="og:description" content="Shipped with SHIP IT! — the retro arcade for platform delivery on Konstruct.">
<meta property="og:image" content="%s">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="%s">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="%s">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;background:#0b0e10;color:#9fafbc;font-family:ui-monospace,Menlo,monospace;display:flex;flex-direction:column;align-items:center;gap:18px;padding:32px 16px}img{max-width:min(96vw,1000px);height:auto;border:2px solid #263237;border-radius:8px}a{color:#00ff6f}</style>
</head><body><img src="%s" alt="A Konstruct universe share card from Ship It!"><p>shipped with SHIP IT! on <a href="/">Konstruct</a></p></body></html>`,
		img, page, img, img)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	static, err := fs.Sub(assets, "static")
	if err != nil {
		panic(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(static)))
	mux.HandleFunc("/api/share-card", postShareCard)
	mux.HandleFunc("/share/", getShare)
	http.ListenAndServe(":"+port, mux) //nolint:errcheck
}
