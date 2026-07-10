// Command comb-mcp serves the Agix Comb — the hive's provenance-gated knowledge
// graph — over MCP (stdio for local runs, Streamable HTTP for the fleet).
//
// It is the Go-native port of the Node `gbrain` fabric: a single binary that
// wraps core/kmstore (a property graph + embeddings on modernc.org/sqlite with
// the actor≠verifier attestation gate) and exposes it as MCP tools —
// comb.put / comb.link / comb.retrieve / comb.traverse / comb.stats — so any
// MCP-speaking agent can grow and read governed knowledge. Logging, auth,
// health, and graceful shutdown come from services/go-common; the store logic
// lives in core/kmstore; only the MCP tool wiring is local here.
//
// Environment:
//
//	COMB_MCP_STORE        sqlite store path (default ~/.agix/km.db — shared with
//	                      the `agix-core km` CLI so a fact written by one is
//	                      retrievable by the other)
//	COMB_MCP_VERIFIERS    comma-separated attestation roster (principals allowed
//	                      to vouch); falls back to AGIX_KM_VERIFIERS for CLI parity
//	COMB_MCP_TRUST_FLOOR  attestation trust floor 0..1 (default 0.35)
//	COMB_MCP_DIM          embedding dimension (default 64; MUST be constant for a
//	                      given store, and match the CLI's dim for cross-tool reads)
//	COMB_MCP_KEY          shared fleet bearer key (required for HTTP mode)
//	COMB_MCP_AGENT        agent identity label for stdio logs
//	AGIX_LOG_QUIET        1 = silence per-request http_request lines
//	PORT                  HTTP listen port (default 8080)
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/agix-ai/agix/core/kmstore"
	"github.com/agix-ai/agix/services/comb-mcp/internal/tools"
	"github.com/agix-ai/agix/services/go-common/auth"
	"github.com/agix-ai/agix/services/go-common/httpserve"
	"github.com/agix-ai/agix/services/go-common/logging"
)

var version = "dev" // stamped via -ldflags "-X main.version=..."

const serviceName = "agix-comb-mcp"

func main() {
	stdio := flag.Bool("stdio", false, "serve a single session over stdio instead of HTTP")
	flag.Parse()

	log := logging.New("agix.comb-mcp", logging.Fields{"service": serviceName, "version": version})
	// In stdio mode, stdout is the MCP JSON-RPC channel — logs (including a
	// startup Fatal) must go to stderr or a strict client chokes on the leading
	// non-protocol line.
	if *stdio {
		log.SetOutput(os.Stderr)
	}
	ctx := context.Background()

	storePath := storeTarget()
	store, err := kmstore.Open(storePath)
	if err != nil {
		log.Fatal("store_open_failed", logging.Fields{"path": storePath, "error": err.Error()})
	}
	defer store.Close()

	// Seed the attestation roster OUT OF BAND from any write — this is what makes
	// attestation non-forgeable (a bare `--verifier x` for an unlisted x stores
	// un-attested). COMB_MCP_VERIFIERS is preferred; AGIX_KM_VERIFIERS is honored
	// for parity with the `agix-core km` CLI against the same store.
	roster := firstNonEmpty(os.Getenv("COMB_MCP_VERIFIERS"), os.Getenv("AGIX_KM_VERIFIERS"))
	if roster != "" {
		store.RegisterVerifier(strings.Split(roster, ",")...)
	}
	if f, ok := parseFloatEnv("COMB_MCP_TRUST_FLOOR"); ok {
		store.SetTrustFloor(f)
	}

	server := tools.NewServer(tools.Config{
		Store:   store,
		Dim:     dimFromEnv(),
		Version: version,
	})

	if *stdio {
		log.Info("stdio_session", logging.Fields{
			"store":       storePath,
			"dim":         dimFromEnv(),
			"trust_floor": store.TrustFloor(),
			"agent":       os.Getenv("COMB_MCP_AGENT"),
		})
		if err := server.Run(ctx, &mcp.StdioTransport{}); err != nil {
			log.Fatal("stdio_session_ended", logging.Fields{"error": err.Error()})
		}
		return
	}

	// HTTP mode — mirrors coord-mcp: a shared bearer key gates ACCESS to the
	// tools (write provenance still travels in the tool arguments, not headers).
	keys := auth.Keys{FleetKey: os.Getenv("COMB_MCP_KEY")}
	if keys.FleetKey == "" {
		log.Fatal("missing_fleet_key", logging.Fields{
			"hint": "COMB_MCP_KEY is required for HTTP mode (use -stdio for keyless local runs)",
		})
	}

	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)
	mux := http.NewServeMux()
	mux.Handle("/mcp", auth.Middleware(keys, tools.CombHeaders, handler))

	// /up + /readyz — the standard substrate health surface.
	httpserve.Health{
		Service: serviceName,
		Version: version,
		Checks: func() map[string]string {
			if _, err := store.Stats(); err != nil {
				return map[string]string{"store": "degraded: " + err.Error()}
			}
			return map[string]string{"store": "ok"}
		},
	}.Register(mux)

	// /healthz — a plain-text liveness probe for deploy smoke tests.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, "ok %s %s\n", serviceName, version)
	})

	srv := httpserve.NewServer(logging.RequestLog(log, logging.QuietFromEnv(), mux))
	log.Info("listening", logging.Fields{
		"port":        httpserve.Port(),
		"store":       storePath,
		"dim":         dimFromEnv(),
		"trust_floor": store.TrustFloor(),
	})

	sigCtx, stop := httpserve.SignalContext()
	defer stop()
	if err := httpserve.Serve(sigCtx, srv); err != nil {
		log.Fatal("server_failed", logging.Fields{"error": err.Error()})
	}
	log.Info("shutdown_complete", nil)
}

// storeTarget resolves the sqlite store path: COMB_MCP_STORE, else ~/.agix/km.db
// (the CLI's default, so the CLI and this server share one durable Comb).
func storeTarget() string {
	if p := strings.TrimSpace(os.Getenv("COMB_MCP_STORE")); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(".agix", "km.db")
	}
	return filepath.Join(home, ".agix", "km.db")
}

// dimFromEnv returns COMB_MCP_DIM or tools.DefaultDim.
func dimFromEnv() int {
	if v := strings.TrimSpace(os.Getenv("COMB_MCP_DIM")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return tools.DefaultDim
}

func parseFloatEnv(key string) (float64, bool) {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f, true
		}
	}
	return 0, false
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}
