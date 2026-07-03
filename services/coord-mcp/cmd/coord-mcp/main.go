// Command coord-mcp serves the Agix agent-coordination lease ledger over MCP
// (Streamable HTTP for the fleet, stdio for local runs).
//
// It is the coordination control plane: agents claim path globs before editing
// so parallel work never collides. Logging, auth, health, and graceful
// shutdown come from services/go-common; the ledger/tools/MCP logic is local.
//
// Environment:
//
//	COORD_MCP_KEY              shared fleet bearer key (required for HTTP)
//	COORD_MCP_COORDINATOR_KEY  optional coordinator bearer key (may release
//	                           leases it does not own)
//	COORD_MCP_STORE            persistence target: gs://bucket/object, a local
//	                           file path, or empty for ephemeral memory
//	COORD_MCP_AGENT            agent identity for stdio runs (no HTTP headers)
//	AGIX_LOG_QUIET             1 = silence the per-request http_request lines
//	PORT                       HTTP listen port (default 8080)
package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/agix-ai/agix/services/coord-mcp/internal/ledger"
	"github.com/agix-ai/agix/services/coord-mcp/internal/tools"
	"github.com/agix-ai/agix/services/go-common/auth"
	"github.com/agix-ai/agix/services/go-common/httpserve"
	"github.com/agix-ai/agix/services/go-common/logging"
)

var version = "dev" // stamped via -ldflags "-X main.version=..."

const serviceName = "agix-coord-mcp"

func main() {
	stdio := flag.Bool("stdio", false, "serve a single session over stdio instead of HTTP")
	coordinator := flag.Bool("coordinator", false, "stdio only: act with the coordinator role (can release others' leases)")
	flag.Parse()

	log := logging.New("agix.coord-mcp", logging.Fields{"service": serviceName, "version": version})
	// In stdio mode, stdout is the MCP JSON-RPC channel — logs (including a
	// startup Fatal on a bad store target) must go to stderr or a strict client
	// chokes on the leading non-protocol line.
	if *stdio {
		log.SetOutput(os.Stderr)
	}
	ctx := context.Background()

	snap, desc, err := ledger.NewSnapshotterFromTarget(os.Getenv("COORD_MCP_STORE"))
	if err != nil {
		log.Fatal("bad_store_target", logging.Fields{"error": err.Error()})
	}
	store, err := ledger.NewStore(ctx, snap)
	if err != nil {
		log.Fatal("ledger_load_failed", logging.Fields{"error": err.Error()})
	}

	keys := auth.Keys{
		FleetKey:       os.Getenv("COORD_MCP_KEY"),
		CoordinatorKey: os.Getenv("COORD_MCP_COORDINATOR_KEY"),
	}

	// The read-only audit-ledger tools (ledger_read / ledger_stats) over the
	// Agix governance JSONL. The path is resolved from the environment; a
	// not-yet-existent ledger simply reads as empty.
	ledgerReader, ledgerDesc := tools.NewAuditLedgerReaderFromEnv()

	server := tools.NewServer(tools.Config{
		Store: store,
		Keys:  keys,
		StdioIdentity: auth.Identity{
			Agent:       os.Getenv("COORD_MCP_AGENT"),
			Coordinator: *coordinator,
		},
		Version: version,
		Ledger:  ledgerReader,
	})

	if *stdio {
		log.Info("stdio_session", logging.Fields{
			"store":  desc,
			"agent":  os.Getenv("COORD_MCP_AGENT"),
			"ledger": ledgerDesc,
		})
		if err := server.Run(ctx, &mcp.StdioTransport{}); err != nil {
			log.Fatal("stdio_session_ended", logging.Fields{"error": err.Error()})
		}
		return
	}

	if keys.FleetKey == "" {
		log.Fatal("missing_fleet_key", logging.Fields{
			"hint": "COORD_MCP_KEY is required for HTTP mode (use -stdio for keyless local runs)",
		})
	}

	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)
	mux := http.NewServeMux()
	mux.Handle("/mcp", auth.Middleware(keys, tools.CoordHeaders, handler))

	// /up + /readyz — the standard substrate health surface; persistence
	// degradation (reads-from-memory / writes-fail-closed) shows in checks.
	httpserve.Health{
		Service: serviceName,
		Version: version,
		Checks: func() map[string]string {
			if deg, reason := store.Degraded(); deg {
				return map[string]string{"persistence": "degraded: " + reason}
			}
			return map[string]string{"persistence": "ok"}
		},
	}.Register(mux)

	// /healthz — a plain-text liveness probe for deploy smoke tests.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		if deg, reason := store.Degraded(); deg {
			// reads serve from memory, writes fail closed — flag it loudly
			fmt.Fprintf(w, "ok %s %s DEGRADED: persistence unconfirmed — %s\n", serviceName, version, reason)
			return
		}
		fmt.Fprintf(w, "ok %s %s\n", serviceName, version)
	})

	srv := httpserve.NewServer(logging.RequestLog(log, logging.QuietFromEnv(), mux))
	log.Info("listening", logging.Fields{
		"port":   httpserve.Port(),
		"store":  desc,
		"ledger": ledgerDesc,
	})

	// Graceful SIGTERM drain. Write-through persistence means a hard kill loses
	// nothing acknowledged; draining is strictly kinder to in-flight calls.
	sigCtx, stop := httpserve.SignalContext()
	defer stop()
	if err := httpserve.Serve(sigCtx, srv); err != nil {
		log.Fatal("server_failed", logging.Fields{"error": err.Error()})
	}
	log.Info("shutdown_complete", nil)
}
