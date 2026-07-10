// Command hive-gateway is the apiary report-home ingest endpoint for a hive.
//
// A federated apiary is many hives; a remote/cloud swarm forages and then
// "reports home" by POSTing a canonical cross-hive envelope to the destination
// hive's gateway. This service is that door: it authenticates the caller with
// the per-hive bearer key, validates the envelope at the perimeter (right hive,
// well-formed actor, drone sender only), and appends an accepted event to the
// hive's append-only audit ledger. Logging, auth, health, and graceful
// shutdown come from services/go-common; the envelope + ledger logic is local.
//
// Environment:
//
//	HIVE_GATEWAY_KEY   per-hive bearer key (required) — gates POST /apiary/report
//	HIVE_NAME          the hive this gateway serves, e.g. "agix" (required)
//	HIVE_LEDGER_PATH   JSONL append path (default ./tenants/<HIVE_NAME>/ledger.jsonl)
//	AGIX_LOG_QUIET     1 = silence the per-request http_request lines
//	PORT               HTTP listen port (default 8080)
package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/agix-ai/agix/services/go-common/auth"
	"github.com/agix-ai/agix/services/go-common/httpserve"
	"github.com/agix-ai/agix/services/go-common/logging"

	"github.com/agix-ai/agix/core/apiary"
	"github.com/agix-ai/agix/services/hive-gateway/internal/ledger"
)

var version = "dev" // stamped via -ldflags "-X main.version=..."

const serviceName = "agix-hive-gateway"

// maxBodyBytes caps an envelope POST. Envelopes are small governance records;
// a body larger than this is malformed or hostile.
const maxBodyBytes = 1 << 20 // 1 MiB

func main() {
	log := logging.New("agix.hive-gateway", logging.Fields{"service": serviceName, "version": version})

	hive := strings.TrimSpace(os.Getenv("HIVE_NAME"))
	if hive == "" {
		log.Fatal("missing_hive_name", logging.Fields{
			"hint": "HIVE_NAME names the hive this gateway serves (e.g. agix)",
		})
	}

	key := os.Getenv("HIVE_GATEWAY_KEY")
	if key == "" {
		log.Fatal("missing_gateway_key", logging.Fields{
			"hint": "HIVE_GATEWAY_KEY is the per-hive bearer key required to POST /apiary/report",
		})
	}
	keys := auth.Keys{FleetKey: key}

	ledgerPath := os.Getenv("HIVE_LEDGER_PATH")
	if ledgerPath == "" {
		ledgerPath = filepath.Join(".", "tenants", hive, "ledger.jsonl")
	}

	// Distributed tracing is the opt-in module services/go-common/otelinit; it
	// is intentionally NOT wired here. Enable it explicitly if the gateway needs
	// spans across the apiary.

	gw := &gateway{hive: hive, ledgerPath: ledgerPath, log: log}

	mux := http.NewServeMux()

	// /up + /readyz — UNAUTHENTICATED liveness/readiness (standard substrate).
	httpserve.Health{
		Service: serviceName,
		Version: version,
		Checks:  func() map[string]string { return map[string]string{"ledger": "ok"} },
	}.Register(mux)

	// The report-home ingest — BEHIND the per-hive bearer key.
	mux.Handle("POST /apiary/report",
		auth.Middleware(keys, auth.DefaultHeaders, http.HandlerFunc(gw.handleReport)))

	srv := httpserve.NewServer(logging.RequestLog(log, logging.QuietFromEnv(), mux))
	log.Info("listening", logging.Fields{
		"port":   httpserve.Port(),
		"hive":   hive,
		"ledger": ledgerPath,
	})

	// Graceful SIGTERM drain — kinder to an in-flight append; the ledger write
	// itself is a single atomic O_APPEND, so a hard kill loses nothing acked.
	sigCtx, stop := httpserve.SignalContext()
	defer stop()
	if err := httpserve.Serve(sigCtx, srv); err != nil {
		log.Fatal("server_failed", logging.Fields{"error": err.Error()})
	}
	log.Info("shutdown_complete", nil)
}

type gateway struct {
	hive       string
	ledgerPath string
	log        *logging.Logger
}

// handleReport ingests one cross-hive envelope: decode → validate at the
// perimeter → append to the ledger → 200 {"accepted":true,...}.
func (g *gateway) handleReport(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	// Lenient decode (no DisallowUnknownFields): a newer sender hive may add
	// fields; the perimeter validates the ones that matter.
	var env apiary.Envelope
	if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "request body is not a valid envelope JSON")
		return
	}

	if err := env.Validate(g.hive); err != nil {
		var re *apiary.RejectError
		if errors.As(err, &re) {
			writeError(w, re.Status, "rejected", re.Reason)
			return
		}
		writeError(w, http.StatusUnprocessableEntity, "rejected", err.Error())
		return
	}

	id := ledger.NewEntryID()
	entry := ledger.Entry{
		EntryID:       id,
		TS:            time.Now().UTC().Format(time.RFC3339Nano),
		Scope:         map[string]string{"enterpriseId": g.hive},
		Actor:         env.Actor,
		Kind:          "cross_hive",
		AuthorityUsed: env.AuthorityUsed,
		// The full envelope rides along under meta so the closed governance
		// schema stays stable while the whole cross-hive record is preserved.
		Meta: map[string]any{"envelope": env},
	}
	if err := ledger.Append(g.ledgerPath, entry); err != nil {
		g.log.Error("ledger_append_failed", logging.Fields{"error": err.Error()})
		writeError(w, http.StatusInternalServerError, "ledger_unavailable", "failed to append to the hive ledger")
		return
	}

	g.log.Info("cross_hive_accepted", logging.Fields{
		"from_hive":   env.FromHive,
		"to_hive":     env.ToHive,
		"kind":        string(env.Kind),
		"entry_id":    id,
		"envelope_id": env.EnvelopeID,
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"accepted":    true,
		"entry_id":    id,
		"envelope_id": env.EnvelopeID,
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, reason string) {
	writeJSON(w, status, map[string]any{"accepted": false, "error": code, "reason": reason})
}
