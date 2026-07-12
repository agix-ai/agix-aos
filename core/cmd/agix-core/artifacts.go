// The `agix artifacts` command — renders the append-only audit ledger as a
// reviewable GOVERNANCE RECEIPT: the actor→verifier→verdict trail, cost totals,
// and evidence links for a run. This is the OSS answer to a proprietary
// "Artifacts" surface, except every receipt is reconstructed from a
// machine-enforced actor≠verifier ledger — not a rendered narrative the tool
// asks you to trust.
//
// Stage 1 (this file) is the terminal + JSON renderer. The Receipt struct is the
// deliberate seam Stage 2's HTML emitter consumes (`--json` → json.MarshalIndent).
//
// Stage 1.5 added a real RUN BRACKET to the ledger: every CLI run entry point
// writes a run_start (run_id, task, capability, kind) at the start and a run_done
// at the end. When those brackets are present they are the AUTHORITATIVE run
// boundary and the exact source of run_id/task/capability/kind — no decompose- or
// gate-scraping heuristic. The heuristic below is kept as a strict FALLBACK for
// pre-bracket ledgers (and for any orphan entries a partially-upgraded ledger
// carries outside a bracket), so old ledgers still render.
//
// The pre-bracket heuristic is best-effort over a ledger that was designed as a
// WRITE sink, not a run-indexed store: with no run_start entry, runs are segmented
// by the queen's decompose boundary (swarm) and the agent_start boundary
// (single-agent paths), with scope- and proximity-based attribution of the
// unscoped queen/verifier/gate frames. See segmentRuns for that heuristic.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/agix-ai/agix/core/ledger"
)

// ── public receipt shape (the Stage-2 HTML seam) ───────────────────────────────

// Receipt is the machine-readable governance receipt for one reconstructed run.
// `agix artifacts --json` emits exactly this (json.MarshalIndent), so Stage 2's
// HTML emitter builds on these fields rather than re-parsing the ledger.
type Receipt struct {
	RunID      string    `json:"run_id"` // stable handle (swarm runID · lease id · scope slug)
	Kind       string    `json:"kind"`   // swarm | single | unknown
	Task       string    `json:"task"`   // "" when the ledger never recorded it
	Capability string    `json:"capability,omitempty"`
	Start      time.Time `json:"start"`
	End        time.Time `json:"end"`
	DurationMS int64     `json:"duration_ms"`

	Governance Governance  `json:"governance"` // the actor≠verifier centerpiece
	Verdict    Verdict     `json:"verdict"`
	Cost       CostSummary `json:"cost"`
	Timeline   []Event     `json:"timeline"`
	Evidence   []Evidence  `json:"evidence,omitempty"`

	Leases   []string `json:"leases,omitempty"`
	Scopes   []string `json:"scopes,omitempty"`
	Warnings []string `json:"warnings,omitempty"` // governance violations, missing verifier, corrupt data
}

// Governance is the structural actor≠verifier guarantee, computed from the trail.
// Status is the headline: "distinct" (a verifier ratified work it did not
// produce — the guarantee holds), "violation" (a ratifier also produced the work
// — flag loudly), "pending" (a gate paused with no ratify yet), or "none" (no
// governance gate in this run).
type Governance struct {
	Actors           []string `json:"actors"`             // agents that produced the work
	Verifiers        []string `json:"verifiers"`          // agents that ratified
	ActorNeqVerifier bool     `json:"actor_neq_verifier"` // true = the guarantee holds
	Status           string   `json:"status"`             // distinct | violation | pending | none
	PendingGates     int      `json:"pending_gates"`
	Violations       []string `json:"violations,omitempty"` // agents that ratified their own work
}

// Verdict is the ratification outcome. State: approved | rejected | pending | none.
type Verdict struct {
	State     string `json:"state"`
	By        string `json:"by,omitempty"`
	Notes     string `json:"notes,omitempty"`
	Grounding string `json:"grounding,omitempty"`
}

// CostSummary totals the run. Cost/tokens are summed over model_call entries (the
// only kind that carries tokens); agent_done's cost_usd is a per-agent rollup of
// those same calls, so summing it too would double-count — it is deliberately not
// added here.
type CostSummary struct {
	USD          float64 `json:"usd"`
	InputTokens  int     `json:"input_tokens"`
	OutputTokens int     `json:"output_tokens"`
	CachedTokens int     `json:"cached_tokens"`
	ModelCalls   int     `json:"model_calls"`
	ToolCalls    int     `json:"tool_calls"`
	Bees         int     `json:"bees"` // distinct agents that made a model call
}

// Event is one compact timeline entry (offset from run start + the key fact).
type Event struct {
	Offset string    `json:"offset"`
	TS     time.Time `json:"ts"`
	Kind   string    `json:"kind"`
	Agent  string    `json:"agent"`
	Detail string    `json:"detail,omitempty"`
}

// Evidence is a best-effort link to where an agent's output landed. The core run
// paths do not currently record output paths in the ledger, so this is populated
// only when an entry carries a "path"/"output" field — never fabricated.
type Evidence struct {
	Agent string `json:"agent"`
	Kind  string `json:"kind"`
	Path  string `json:"path"`
}

// ── command entry ──────────────────────────────────────────────────────────────

// cmdArtifacts renders the governance receipt(s). --help is intercepted centrally
// in main() before this runs.
func cmdArtifacts(args []string) int {
	var (
		wantList bool
		wantJSON bool
		wantHTML bool
		outPath  string
		outSet   bool
		path     = ledgerPath
		id       string
	)
	i := 0
	for i < len(args) {
		a := args[i]
		switch {
		case a == "--list", a == "-l":
			wantList = true
			i++
		case a == "--json":
			wantJSON = true
			i++
		case a == "--html":
			wantHTML = true
			i++
		case a == "--out":
			if i+1 >= len(args) {
				fmt.Fprintln(os.Stderr, "artifacts: --out needs a path (or - for stdout)")
				return 2
			}
			outPath, outSet, i = args[i+1], true, i+2
		case strings.HasPrefix(a, "--out="):
			outPath, outSet, i = strings.TrimPrefix(a, "--out="), true, i+1
		case a == "--ledger":
			if i+1 >= len(args) {
				fmt.Fprintln(os.Stderr, "artifacts: --ledger needs a path")
				return 2
			}
			path, i = args[i+1], i+2
		case strings.HasPrefix(a, "--ledger="):
			path, i = strings.TrimPrefix(a, "--ledger="), i+1
		case strings.HasPrefix(a, "-"):
			fmt.Fprintf(os.Stderr, "artifacts: unknown flag %q\n", a)
			return 2
		default:
			if id == "" {
				id = a
			}
			i++
		}
	}

	// Friendly "no ledger yet" vs. a real error: a missing file is the common
	// first-run case, not a failure.
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			fmt.Printf("%s no ledger yet at %s\n", paint(cDim, "artifacts:"), path)
			fmt.Printf("  run a governed path first, e.g. %s\n", paint(cHoney, `agix hive "review the auth module"`))
			return 0
		}
		fmt.Fprintf(os.Stderr, "artifacts: %v\n", err)
		return 1
	}

	led, err := ledger.Open(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "artifacts: open ledger: %v\n", err)
		return 1
	}
	entries, err := led.Read("", time.Time{})
	if err != nil {
		fmt.Fprintf(os.Stderr, "artifacts: read ledger: %v\n", err)
		return 1
	}

	receipts := reconstruct(entries)
	// Newest run first, so `--list` and the default (most-recent) read the way a
	// human scans an audit log.
	sort.SliceStable(receipts, func(a, b int) bool {
		return receipts[a].Start.After(receipts[b].Start)
	})

	if len(receipts) == 0 {
		if wantJSON {
			fmt.Println("[]")
			return 0
		}
		fmt.Printf("%s the ledger at %s has no runs yet.\n", paint(cDim, "artifacts:"), path)
		return 0
	}

	// --out implies --html (writing an HTML receipt is the only thing --out does).
	if outSet {
		wantHTML = true
	}

	if wantList {
		if wantHTML {
			fmt.Fprintln(os.Stderr, "artifacts: --html renders a single run; drop --list and name a run (or omit for the most recent)")
			return 2
		}
		if wantJSON {
			return emitJSON(receipts)
		}
		renderList(os.Stdout, receipts, path)
		return 0
	}

	// A specific run/lease, or the most recent when none named.
	var r *Receipt
	if id != "" {
		r = findReceipt(receipts, id)
		if r == nil {
			fmt.Fprintf(os.Stderr, "artifacts: no run matching %q in %s (try `agix artifacts --list`)\n", id, path)
			return 1
		}
	} else {
		r = receipts[0] // newest
	}

	if wantHTML {
		return emitReceiptHTML(r, path, outPath)
	}
	if wantJSON {
		return emitJSON(r)
	}
	renderReceipt(os.Stdout, r, path)
	return 0
}

// emitReceiptHTML renders a self-contained HTML receipt and writes it: to stdout
// for `--out -`, else to the given path, else to the default
// <ledger-dir>/receipts/<run-id>.html (created on demand). It prints the written
// path so the caller can attach it to a PR / open it offline.
func emitReceiptHTML(r *Receipt, ledgerFile, outPath string) int {
	html := renderReceiptHTML(*r)

	if outPath == "-" {
		fmt.Print(html)
		return 0
	}

	dest := outPath
	if dest == "" {
		dir := filepath.Join(filepath.Dir(ledgerFile), "receipts")
		dest = filepath.Join(dir, safeFilename(r.RunID)+".html")
	}
	if dir := filepath.Dir(dest); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "artifacts: create %s: %v\n", dir, err)
			return 1
		}
	}
	if err := os.WriteFile(dest, []byte(html), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "artifacts: write %s: %v\n", dest, err)
		return 1
	}
	fmt.Printf("%s %s\n", paint(cHoney, "receipt →"), dest)
	return 0
}

// safeFilename turns a run id (which may carry '/', ':' from a scope slug) into a
// filesystem-safe base name so the default receipts path never escapes its dir.
func safeFilename(s string) string {
	if s == "" {
		return "receipt"
	}
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-.")
	if out == "" {
		return "receipt"
	}
	return out
}

func emitJSON(v any) int {
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "artifacts: marshal: %v\n", err)
		return 1
	}
	fmt.Println(string(out))
	return 0
}

// findReceipt matches id against a run's stable handle, its swarm run id, any of
// its lease ids, or its scopes — case-insensitively, exact or as a prefix — so a
// short id is enough.
func findReceipt(receipts []*Receipt, id string) *Receipt {
	id = strings.ToLower(strings.TrimSpace(id))
	for _, r := range receipts {
		for _, k := range r.matchKeys() {
			k = strings.ToLower(k)
			if k == id || strings.HasPrefix(k, id) {
				return r
			}
		}
	}
	return nil
}

func (r *Receipt) matchKeys() []string {
	keys := []string{r.RunID}
	keys = append(keys, r.Leases...)
	keys = append(keys, r.Scopes...)
	return keys
}

// ── reconstruction ─────────────────────────────────────────────────────────────

// runAccum accumulates the raw entries of one segmented run before it is folded
// into a Receipt.
type runAccum struct {
	kind             string // swarm | single | flow | unknown
	entries          []ledger.Entry
	acceptingWorkers bool         // swarm: still in the fan-out phase (worker agent_starts belong here)
	bracket          *bracketInfo // Stage-1.5 run bracket — authoritative when non-nil
}

// bracketInfo is the exact run identity carried by a run_start/run_done pair. When
// present it overrides every heuristic guess (id, task, capability, kind, bounds).
type bracketInfo struct {
	runID      string
	task       string
	capability string
	kind       string
	start      time.Time
	end        time.Time
	haveEnd    bool
}

func (ra *runAccum) add(e ledger.Entry) { ra.entries = append(ra.entries, e) }

// reconstruct segments the ledger into runs and folds each into a Receipt. When
// the ledger carries run_start brackets they are the authoritative boundary
// (reconstructBracketed); otherwise the pre-bracket heuristic segments it.
func reconstruct(entries []ledger.Entry) []*Receipt {
	for _, e := range entries {
		if e.Kind == ledger.KindRunStart {
			return reconstructBracketed(entries)
		}
	}
	return reconstructHeuristic(entries)
}

// reconstructHeuristic is the pre-bracket path: segment by decompose/agent_start
// boundaries and fold each run. Used for legacy ledgers and for orphan entries a
// partially-upgraded ledger carries outside any bracket.
func reconstructHeuristic(entries []ledger.Entry) []*Receipt {
	runs := segmentRuns(entries)
	out := make([]*Receipt, 0, len(runs))
	for _, ra := range runs {
		if len(ra.entries) == 0 {
			continue
		}
		out = append(out, buildReceipt(ra))
	}
	return out
}

// reconstructBracketed uses run_start/run_done as the authoritative run boundary.
// A run_start opens a run keyed by its run_id; every following entry attaches to
// it — by scope run_id when the entry carries a swarm scope (so genuinely
// interleaved swarm runs separate cleanly), else to the most-recently-opened run
// still awaiting its run_done. run_done closes the run. Entries that fall outside
// every bracket (a legacy run that preceded the upgrade) are handed to the
// heuristic so a mixed ledger still renders in full.
func reconstructBracketed(entries []ledger.Entry) []*Receipt {
	byID := map[string]*runAccum{}
	var order []*runAccum      // run_start order, for stable output
	var open []*runAccum       // runs still awaiting run_done (LIFO)
	var orphans []ledger.Entry // entries outside any bracket

	popOpen := func(ra *runAccum) {
		for i := len(open) - 1; i >= 0; i-- {
			if open[i] == ra {
				open = append(open[:i], open[i+1:]...)
				return
			}
		}
	}
	// byScope routes an entry to the open run whose id its swarm scope names.
	byScope := func(e ledger.Entry) *runAccum {
		for _, s := range scopesOf(e.Data) {
			if id := swarmRunIDFromScope(s); id != "" {
				if ra, ok := byID[id]; ok {
					return ra
				}
			}
		}
		return nil
	}

	for _, e := range entries {
		switch e.Kind {
		case ledger.KindRunStart:
			b := &bracketInfo{
				runID:      str(e.Data, "run_id"),
				task:       str(e.Data, "task"),
				capability: str(e.Data, "capability"),
				kind:       str(e.Data, "kind"),
				start:      e.TS,
			}
			ra := &runAccum{kind: b.kind, bracket: b}
			if b.runID != "" {
				byID[b.runID] = ra
			}
			order = append(order, ra)
			open = append(open, ra)
		case ledger.KindRunDone:
			ra := byID[str(e.Data, "run_id")]
			if ra == nil && len(open) > 0 {
				ra = open[len(open)-1] // done without a matching id: close the newest open run
			}
			if ra != nil && ra.bracket != nil {
				ra.bracket.end, ra.bracket.haveEnd = e.TS, true
				popOpen(ra)
			}
		default:
			switch {
			case byScope(e) != nil:
				byScope(e).add(e)
			case len(open) > 0:
				open[len(open)-1].add(e)
			default:
				orphans = append(orphans, e)
			}
		}
	}

	out := make([]*Receipt, 0, len(order))
	for _, ra := range order {
		out = append(out, buildReceipt(ra))
	}
	// Legacy runs that preceded the first bracket still render via the heuristic.
	out = append(out, reconstructHeuristic(orphans)...)
	return out
}

// segmentRuns walks the ledger in append (chronological) order and cuts it into
// runs. The ledger records no run id, so boundaries are inferred:
//
//   - a queen's decompose model_call opens a new SWARM run; the worker agent_starts
//     that follow during fan-out are absorbed into it (not treated as new runs),
//     and the unscoped queen/verifier/gate/ratify frames attach to it by proximity.
//   - any other agent_start opens a new SINGLE-agent run (run/flow/agent path).
//   - a swarm stops absorbing worker agent_starts once its synthesize call or its
//     gate_pause is seen, so a single run that follows a swarm is cut cleanly.
func segmentRuns(entries []ledger.Entry) []*runAccum {
	var runs []*runAccum
	var cur *runAccum
	start := func(kind string) *runAccum {
		cur = &runAccum{kind: kind}
		runs = append(runs, cur)
		return cur
	}
	for _, e := range entries {
		switch {
		case isDecompose(e):
			start("swarm").acceptingWorkers = true
			cur.add(e)
		case e.Kind == ledger.KindAgentStart:
			if cur != nil && cur.kind == "swarm" && cur.acceptingWorkers {
				cur.add(e) // a worker bee inside the current swarm's fan-out
			} else {
				start("single").add(e)
			}
		default:
			if cur == nil {
				start("unknown")
			}
			// The fan-out is over once the Queen synthesizes or the gate pauses;
			// any later agent_start is a new run, not a worker.
			if e.Kind == ledger.KindGatePause || (e.Kind == ledger.KindModelCall && phaseOf(e) == "synthesize") {
				cur.acceptingWorkers = false
			}
			cur.add(e)
		}
	}
	return runs
}

func isDecompose(e ledger.Entry) bool {
	return e.Kind == ledger.KindModelCall && roleOf(e) == "queen" && phaseOf(e) == "decompose"
}

// buildReceipt folds one run's raw entries into a Receipt.
func buildReceipt(ra *runAccum) *Receipt {
	r := &Receipt{Kind: ra.kind}

	// Stage-1.5 bracket: when a run_start/run_done pair bounds this run, its
	// task/capability are the EXACT run identity — seed them so every heuristic
	// assignment below (guarded on `== ""`) is suppressed, including the
	// gate-payload task scrape.
	if ra.bracket != nil {
		r.Task = ra.bracket.task
		r.Capability = ra.bracket.capability
	}

	// time bounds
	var minTS, maxTS time.Time
	for _, e := range ra.entries {
		if minTS.IsZero() || e.TS.Before(minTS) {
			minTS = e.TS
		}
		if e.TS.After(maxTS) {
			maxTS = e.TS
		}
	}
	if ra.bracket != nil {
		// The bracket's run_start/run_done are the true run boundary.
		r.Start = ra.bracket.start
		switch {
		case ra.bracket.haveEnd:
			r.End = ra.bracket.end
		case !maxTS.IsZero():
			r.End = maxTS
		default:
			r.End = ra.bracket.start
		}
	} else {
		r.Start, r.End = minTS, maxTS
	}
	r.DurationMS = r.End.Sub(r.Start).Milliseconds()

	// distinct sets, preserving first-seen order for stable output
	actorSet := newOrderedSet()    // agents that produced work (non-verify)
	verifierSet := newOrderedSet() // agents that ratified / verified
	beeSet := newOrderedSet()      // agents that made any model_call
	leaseSet := newOrderedSet()
	scopeSet := newOrderedSet()

	var swarmRunID string
	var gatePauses, ratifies int
	var rejected, approvedAny bool

	for _, e := range ra.entries {
		switch e.Kind {
		case ledger.KindModelCall:
			r.Cost.ModelCalls++
			r.Cost.USD += fnum(e.Data, "cost_usd")
			r.Cost.InputTokens += inum(e.Data, "input_tokens")
			r.Cost.OutputTokens += inum(e.Data, "output_tokens")
			r.Cost.CachedTokens += inum(e.Data, "cached_tokens")
			beeSet.add(e.Agent)
			if isVerify(e) {
				verifierSet.add(e.Agent)
			} else {
				actorSet.add(e.Agent)
			}
			if r.Capability == "" {
				// swarm has no run-level capability; a worker's is the best proxy.
				if role := roleOf(e); role == "forager" {
					r.Capability = str(e.Data, "capability")
				}
			}
		case ledger.KindToolCall:
			r.Cost.ToolCalls++
			actorSet.add(e.Agent)
			if p := str(e.Data, "path"); p != "" {
				r.Evidence = append(r.Evidence, Evidence{Agent: e.Agent, Kind: "tool", Path: p})
			}
		case ledger.KindAgentStart:
			actorSet.add(e.Agent)
			if r.Task == "" {
				if t := str(e.Data, "task"); t != "" && !isSubtaskID(t) {
					r.Task = t
				}
			}
			if r.Capability == "" {
				r.Capability = str(e.Data, "capability")
			}
		case ledger.KindAgentDone:
			actorSet.add(e.Agent)
			if p := str(e.Data, "path"); p != "" {
				r.Evidence = append(r.Evidence, Evidence{Agent: e.Agent, Kind: "output", Path: p})
			}
		case ledger.KindLeaseClaim:
			if l := str(e.Data, "lease"); l != "" {
				leaseSet.add(l)
			}
			for _, s := range scopesOf(e.Data) {
				scopeSet.add(s)
				if id := swarmRunIDFromScope(s); id != "" {
					swarmRunID = id
				}
			}
		case ledger.KindGatePause:
			gatePauses++
			if r.Task == "" {
				if t := originalTaskFromGate(e.Data); t != "" {
					r.Task = t
				}
			}
		case ledger.KindRatify:
			ratifies++
			by := str(e.Data, "by")
			if by == "" {
				by = e.Agent
			}
			verifierSet.add(by)
			ok, _ := e.Data["approved"].(bool)
			if ok {
				approvedAny = true
			} else {
				rejected = true
			}
			// last ratify wins for the headline verdict detail
			r.Verdict.By = by
			r.Verdict.Notes = str(e.Data, "notes")
			r.Verdict.Grounding = str(e.Data, "grounding")
		}
	}

	r.Cost.Bees = beeSet.len()
	r.Leases = leaseSet.slice()
	r.Scopes = scopeSet.slice()

	// governance: the actor≠verifier computation (the centerpiece)
	r.Governance.Actors = actorSet.slice()
	r.Governance.Verifiers = verifierSet.slice()
	pending := gatePauses - ratifies
	if pending < 0 {
		pending = 0
	}
	r.Governance.PendingGates = pending
	// A violation is an agent that BOTH produced work and ratified — the same
	// actor certifying its own output. Flag every such agent loudly.
	for _, v := range verifierSet.slice() {
		if actorSet.has(v) {
			r.Governance.Violations = append(r.Governance.Violations, v)
		}
	}
	switch {
	case len(r.Governance.Violations) > 0:
		r.Governance.Status = "violation"
		r.Governance.ActorNeqVerifier = false
		for _, v := range r.Governance.Violations {
			r.Warnings = append(r.Warnings, "governance violation: "+v+" ratified work it also produced (actor == verifier)")
		}
	case ratifies == 0 && gatePauses > 0:
		r.Governance.Status = "pending"
		r.Governance.ActorNeqVerifier = false
		r.Warnings = append(r.Warnings, "gate paused with no ratification yet (pending verifier)")
	case ratifies == 0:
		r.Governance.Status = "none"
		r.Governance.ActorNeqVerifier = false
	default:
		r.Governance.Status = "distinct"
		r.Governance.ActorNeqVerifier = true
	}

	// verdict state
	switch {
	case rejected:
		r.Verdict.State = "rejected"
	case approvedAny:
		r.Verdict.State = "approved"
	case gatePauses > 0:
		r.Verdict.State = "pending"
	default:
		r.Verdict.State = "none"
	}

	// stable run handle: the bracket's exact run_id when present · else the swarm
	// run id · else a lease id · else a scope slug · else time.
	switch {
	case ra.bracket != nil && ra.bracket.runID != "":
		r.RunID = ra.bracket.runID
	case swarmRunID != "":
		r.RunID = swarmRunID
	case len(r.Leases) > 0:
		r.RunID = r.Leases[0]
	case len(r.Scopes) > 0:
		r.RunID = r.Scopes[0]
	default:
		r.RunID = "run@" + r.Start.UTC().Format("20060102T150405Z")
	}

	r.Timeline = buildTimeline(ra.entries, r.Start)
	return r
}

// buildTimeline emits a compact, offset-tagged trail of the KEY events, dropping
// lease/node bracket noise so the actor→verifier→verdict story reads at a glance.
func buildTimeline(entries []ledger.Entry, start time.Time) []Event {
	var tl []Event
	for _, e := range entries {
		var detail string
		switch e.Kind {
		case ledger.KindAgentStart:
			detail = str(e.Data, "task")
		case ledger.KindModelCall:
			detail = strings.TrimSpace(strings.Join(nonEmpty(phaseOf(e), roleOf(e), str(e.Data, "model")), " · "))
		case ledger.KindToolCall:
			detail = str(e.Data, "tool")
			if ok, _ := e.Data["ok"].(bool); !ok {
				detail += " (error)"
			}
		case ledger.KindGatePause:
			detail = "→ awaiting ratification"
		case ledger.KindRatify:
			ok, _ := e.Data["approved"].(bool)
			detail = verdictWord(ok) + " by " + firstNonEmpty(str(e.Data, "by"), e.Agent)
		case ledger.KindAgentDone:
			if ok, _ := e.Data["ok"].(bool); ok {
				detail = "ok"
			} else {
				detail = "failed: " + str(e.Data, "error")
			}
		default:
			continue // lease_claim/lease_release/node_start/node_done — bracket noise
		}
		tl = append(tl, Event{
			Offset: fmt.Sprintf("+%.3fs", e.TS.Sub(start).Seconds()),
			TS:     e.TS,
			Kind:   e.Kind,
			Agent:  e.Agent,
			Detail: detail,
		})
	}
	return tl
}

// ── rendering (terminal) ────────────────────────────────────────────────────────

const receiptWidth = 66

func renderReceipt(w *os.File, r *Receipt, path string) {
	var b strings.Builder
	rule := paint(cHoney, strings.Repeat("━", receiptWidth))
	b.WriteString(rule + "\n")
	b.WriteString("  " + hy("GOVERNANCE RECEIPT") + "   " + paint(cComb, r.Kind+" run") + "\n")
	b.WriteString(rule + "\n")

	const lw = 12 // label gutter, wider than the longest label ("capability")
	lbl := func(k, v string) { b.WriteString("  " + paint(cComb, pad(k, lw)) + v + "\n") }
	lbl("run", paint(cBold, r.RunID))
	if r.Task != "" {
		lbl("task", r.Task)
	} else {
		lbl("task", paint(cDim, "(not recorded in ledger)"))
	}
	if r.Capability != "" {
		lbl("capability", r.Capability)
	}
	when := r.Start.UTC().Format("2006-01-02 15:04:05") + " → " + r.End.UTC().Format("15:04:05") + " UTC"
	lbl("when", when+paint(cDim, fmt.Sprintf("  (%s)", humanDur(r.DurationMS))))

	// ── the actor≠verifier centerpiece ──
	b.WriteString("\n")
	b.WriteString("  " + governanceBanner(r.Governance) + "\n")
	if len(r.Governance.Actors) > 0 {
		b.WriteString("  " + paint(cComb, pad("actors", lw)) + strings.Join(r.Governance.Actors, ", ") + "\n")
	}
	if len(r.Governance.Verifiers) > 0 {
		b.WriteString("  " + paint(cComb, pad("verifier", lw)) + strings.Join(r.Governance.Verifiers, ", ") + "\n")
	} else {
		b.WriteString("  " + paint(cComb, pad("verifier", lw)) + paint(cDim, "— none (unratified)") + "\n")
	}
	b.WriteString("  " + paint(cComb, pad("verdict", lw)) + verdictBanner(r.Verdict) + "\n")
	if r.Verdict.Notes != "" {
		note := r.Verdict.Notes
		if r.Verdict.Grounding != "" {
			note = r.Verdict.Grounding + " · " + note
		}
		b.WriteString("  " + pad("", lw) + paint(cDim, truncCell(note, receiptWidth-12)) + "\n")
	}

	// ── cost ──
	b.WriteString("\n")
	b.WriteString("  " + paint(cComb, pad("cost", lw)) +
		fmt.Sprintf("$%.6f   in=%d out=%d cached=%d   model_calls=%d  bees=%d",
			r.Cost.USD, r.Cost.InputTokens, r.Cost.OutputTokens, r.Cost.CachedTokens,
			r.Cost.ModelCalls, r.Cost.Bees) + "\n")
	if r.Cost.ToolCalls > 0 {
		b.WriteString("  " + pad("", lw) + fmt.Sprintf("tool_calls=%d\n", r.Cost.ToolCalls))
	}

	// ── evidence (best-effort) ──
	if len(r.Evidence) > 0 {
		b.WriteString("\n  " + paint(cComb, "evidence") + "\n")
		for _, ev := range r.Evidence {
			b.WriteString("    " + paint(cHoney, ev.Path) + paint(cDim, "  ("+ev.Agent+")") + "\n")
		}
	}

	// ── timeline ──
	b.WriteString("\n  " + paint(cComb, "timeline") + "\n")
	for _, ev := range r.Timeline {
		line := fmt.Sprintf("    %s  %s  %s",
			paint(cDim, pad(ev.Offset, 8)), pad(kindGlyph(ev.Kind)+ev.Kind, 13), ev.Agent)
		if ev.Detail != "" {
			line += paint(cDim, "  "+truncCell(ev.Detail, 40))
		}
		b.WriteString(line + "\n")
	}

	// ── warnings ──
	for _, warn := range r.Warnings {
		b.WriteString("\n  " + paint(cHoney+cBold, "⚠ "+warn) + "\n")
	}

	b.WriteString(rule + "\n")
	b.WriteString("  " + paint(cDim, "ledger: "+path) + "\n")
	fmt.Fprint(w, b.String())
}

// governanceBanner renders the actor≠verifier headline — the receipt's centerpiece.
func governanceBanner(g Governance) string {
	switch g.Status {
	case "distinct":
		return paint(cHoney+cBold, "actor ≠ verifier") + "   " + okMark() + paint(cBold, " DISTINCT")
	case "violation":
		return paint(cHoney+cBold, "actor ≠ verifier") + "   " + badMark() + paint(cBold, " VIOLATION — actor certified its own work")
	case "pending":
		return paint(cHoney+cBold, "actor ≠ verifier") + "   " + paint(cDim, "⏳ PENDING RATIFICATION")
	default:
		return paint(cHoney+cBold, "actor ≠ verifier") + "   " + paint(cDim, "— no governance gate in this run")
	}
}

func verdictBanner(v Verdict) string {
	switch v.State {
	case "approved":
		return okMark() + " " + paint(cBold, "APPROVED") + verdictBy(v.By)
	case "rejected":
		return badMark() + " " + paint(cBold, "REJECTED") + verdictBy(v.By)
	case "pending":
		return paint(cDim, "⏳ PENDING")
	default:
		return paint(cDim, "— no verdict")
	}
}

func verdictBy(by string) string {
	if by == "" {
		return ""
	}
	return paint(cDim, "  by "+by)
}

// renderList shows recent runs, newest first — the audit-log overview.
func renderList(w *os.File, receipts []*Receipt, path string) {
	var b strings.Builder
	b.WriteString("  " + hy("GOVERNANCE RECEIPTS") + "   " + paint(cComb, fmt.Sprintf("(%d runs)", len(receipts))) + "\n\n")
	for _, r := range receipts {
		task := r.Task
		if task == "" {
			task = "(task not recorded)"
		}
		line := fmt.Sprintf("  %s  %s  %s  %s  %s  %s  %s",
			paint(cHoney, pad(truncCell(r.RunID, 22), 22)),
			pad(r.Kind, 7),
			pad(truncCell(task, 28), 28),
			r.Start.UTC().Format("01-02 15:04"),
			pad(beeWord(r.Cost.Bees), 7),
			pad(fmt.Sprintf("$%.6f", r.Cost.USD), 10),
			listVerdict(r),
		)
		b.WriteString(line + "\n")
	}
	b.WriteString("\n  " + paint(cDim, "detail: "+appName+" artifacts <run-id>   ·   ledger: "+path) + "\n")
	fmt.Fprint(w, b.String())
}

func listVerdict(r *Receipt) string {
	if r.Governance.Status == "violation" {
		return badMark() + " VIOLATION"
	}
	switch r.Verdict.State {
	case "approved":
		return okMark() + " APPROVED"
	case "rejected":
		return badMark() + " REJECTED"
	case "pending":
		return paint(cDim, "⏳ pending")
	default:
		return paint(cDim, "— no gate")
	}
}

// ── rendering (self-contained HTML receipt · the Stage-2 emitter) ────────────────
//
// renderReceiptHTML is a second renderer over the SAME reconstructed Receipt the
// terminal and --json paths use. The output is a single, fully self-contained HTML
// document: inline <style> only, no external URLs / CDNs / fonts / scripts, so it
// passes a strict CSP, attaches cleanly to a PR, and opens offline. Every
// ledger-derived string is escaped, so a hostile ledger value cannot inject markup.
func renderReceiptHTML(r Receipt) string {
	var b strings.Builder

	task := r.Task
	titleTask := task
	if titleTask == "" {
		titleTask = r.RunID
	}

	b.WriteString("<!doctype html>\n<html lang=\"en\">\n<head>\n")
	b.WriteString("<meta charset=\"utf-8\">\n")
	b.WriteString("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n")
	b.WriteString("<title>" + htmlEscape("Governance Receipt · "+titleTask) + "</title>\n")
	b.WriteString("<style>\n")
	b.WriteString(receiptCSS)
	b.WriteString("</style>\n</head>\n<body>\n")
	b.WriteString(`<main class="receipt">` + "\n")

	// ── header: brand + task + run identity ──
	b.WriteString(`<header class="rc-head">` + "\n")
	b.WriteString(honeycombSVG)
	b.WriteString(`<div class="rc-head-inner">` + "\n")
	b.WriteString(`  <div class="rc-brand"><span class="rc-hex">⬡</span> Agix · Governance Receipt</div>` + "\n")
	if task != "" {
		b.WriteString(`  <h1 class="rc-task">` + htmlEscape(task) + "</h1>\n")
	} else {
		b.WriteString(`  <h1 class="rc-task rc-task-empty">task not recorded in ledger</h1>` + "\n")
	}
	when := r.Start.UTC().Format("2006-01-02 15:04:05") + " → " + r.End.UTC().Format("15:04:05") + " UTC"
	b.WriteString(`  <div class="rc-meta">` + "\n")
	b.WriteString(`    <span class="rc-pill rc-pill-kind">` + htmlEscape(orValue(r.Kind, "run")) + "</span>\n")
	b.WriteString(`    <span class="rc-run" title="run id">` + htmlEscape(r.RunID) + "</span>\n")
	b.WriteString(`    <span class="rc-when">` + htmlEscape(when) + " · " + htmlEscape(humanDur(r.DurationMS)) + "</span>\n")
	if r.Capability != "" {
		b.WriteString(`    <span class="rc-cap">cap: ` + htmlEscape(r.Capability) + "</span>\n")
	}
	b.WriteString("  </div>\n")
	b.WriteString("</div>\n</header>\n")

	// ── the actor≠verifier centerpiece (the hero) ──
	cls, badge, sub := htmlGovernanceMeta(r.Governance)
	b.WriteString(`<section class="rc-hero ` + cls + `">` + "\n")
	b.WriteString(`  <div class="rc-hero-badge">` + badge + "</div>\n")
	b.WriteString(`  <div class="rc-flow">` + "\n")
	b.WriteString(`    <div class="rc-flow-col">` + "\n")
	b.WriteString(`      <div class="rc-flow-label">actors <span class="rc-count">` + fmt.Sprintf("%d", len(r.Governance.Actors)) + `</span></div>` + "\n")
	b.WriteString(`      <div class="rc-chips">` + htmlChips(r.Governance.Actors, "rc-chip-actor", "— none") + "</div>\n")
	b.WriteString("    </div>\n")
	b.WriteString(`    <div class="rc-flow-op" aria-hidden="true">≠</div>` + "\n")
	b.WriteString(`    <div class="rc-flow-col">` + "\n")
	b.WriteString(`      <div class="rc-flow-label">verifier <span class="rc-count">` + fmt.Sprintf("%d", len(r.Governance.Verifiers)) + `</span></div>` + "\n")
	b.WriteString(`      <div class="rc-chips">` + htmlChips(r.Governance.Verifiers, "rc-chip-verifier", "— none (unratified)") + "</div>\n")
	b.WriteString("    </div>\n")
	b.WriteString("  </div>\n")
	if len(r.Governance.Violations) > 0 {
		b.WriteString(`  <div class="rc-violations">` + "\n")
		b.WriteString(`    <div class="rc-violations-title">✗ actor certified its own work</div>` + "\n")
		for _, v := range r.Governance.Violations {
			b.WriteString(`    <div class="rc-violation-row"><code>` + htmlEscape(v) + `</code> ratified work it also produced — the actor≠verifier guarantee is BROKEN for this run.</div>` + "\n")
		}
		b.WriteString("  </div>\n")
	} else {
		b.WriteString(`  <p class="rc-hero-note">` + htmlEscape(sub) + "</p>\n")
	}
	b.WriteString("</section>\n")

	// ── verdict ──
	b.WriteString(`<section class="rc-section">` + "\n")
	b.WriteString(`  <h2 class="rc-h2">Verdict</h2>` + "\n")
	b.WriteString(`  <div class="rc-verdict">` + "\n")
	vcls, vlabel := htmlVerdictMeta(r.Verdict.State)
	b.WriteString(`    <span class="rc-verdict-badge ` + vcls + `">` + vlabel + "</span>\n")
	if r.Verdict.By != "" {
		b.WriteString(`    <span class="rc-verdict-by">by <code>` + htmlEscape(r.Verdict.By) + "</code></span>\n")
	}
	b.WriteString("  </div>\n")
	if r.Verdict.Notes != "" || r.Verdict.Grounding != "" {
		note := r.Verdict.Notes
		if r.Verdict.Grounding != "" {
			note = strings.TrimSpace(r.Verdict.Grounding + " · " + note)
		}
		b.WriteString(`  <p class="rc-verdict-note">` + htmlEscape(note) + "</p>\n")
	}
	b.WriteString("</section>\n")

	// ── cost / tokens / bees ──
	b.WriteString(`<section class="rc-section">` + "\n")
	b.WriteString(`  <h2 class="rc-h2">Cost &amp; tokens</h2>` + "\n")
	b.WriteString(`  <div class="rc-stats">` + "\n")
	b.WriteString(htmlStat("cost", fmt.Sprintf("$%.6f", r.Cost.USD)))
	b.WriteString(htmlStat("input tokens", commafy(r.Cost.InputTokens)))
	b.WriteString(htmlStat("output tokens", commafy(r.Cost.OutputTokens)))
	b.WriteString(htmlStat("cached", commafy(r.Cost.CachedTokens)))
	b.WriteString(htmlStat("model calls", commafy(r.Cost.ModelCalls)))
	b.WriteString(htmlStat("tool calls", commafy(r.Cost.ToolCalls)))
	b.WriteString(htmlStat("bees", commafy(r.Cost.Bees)))
	b.WriteString("  </div>\n")
	b.WriteString("</section>\n")

	// ── timeline ──
	if len(r.Timeline) > 0 {
		b.WriteString(`<section class="rc-section">` + "\n")
		b.WriteString(`  <h2 class="rc-h2">Timeline</h2>` + "\n")
		b.WriteString(`  <div class="rc-table-wrap">` + "\n")
		b.WriteString(`  <table class="rc-table">` + "\n")
		b.WriteString(`    <thead><tr><th>offset</th><th>kind</th><th>agent</th><th>detail</th></tr></thead>` + "\n")
		b.WriteString("    <tbody>\n")
		for _, ev := range r.Timeline {
			b.WriteString(`      <tr><td class="rc-mono rc-dim">` + htmlEscape(ev.Offset) + `</td>` +
				`<td class="rc-mono">` + htmlEscape(ev.Kind) + `</td>` +
				`<td>` + htmlEscape(ev.Agent) + `</td>` +
				`<td class="rc-dim">` + htmlEscape(ev.Detail) + `</td></tr>` + "\n")
		}
		b.WriteString("    </tbody>\n  </table>\n  </div>\n")
		b.WriteString("</section>\n")
	}

	// ── evidence (best-effort; embed small local images, else list the path) ──
	if len(r.Evidence) > 0 {
		b.WriteString(`<section class="rc-section">` + "\n")
		b.WriteString(`  <h2 class="rc-h2">Evidence</h2>` + "\n")
		b.WriteString(`  <ul class="rc-evidence">` + "\n")
		for _, ev := range r.Evidence {
			b.WriteString("    <li>\n")
			if uri, ok := embedImageDataURI(ev.Path); ok {
				b.WriteString(`      <figure class="rc-fig"><img alt="` + htmlEscape(filepath.Base(ev.Path)) + `" src="` + uri + `">` +
					`<figcaption><code>` + htmlEscape(ev.Path) + `</code> <span class="rc-dim">(` + htmlEscape(ev.Agent) + `)</span></figcaption></figure>` + "\n")
			} else {
				b.WriteString(`      <code>` + htmlEscape(ev.Path) + `</code> <span class="rc-dim">(` + htmlEscape(ev.Kind) + " · " + htmlEscape(ev.Agent) + ")</span>\n")
			}
			b.WriteString("    </li>\n")
		}
		b.WriteString("  </ul>\n</section>\n")
	}

	// ── warnings (loud) ──
	if len(r.Warnings) > 0 {
		b.WriteString(`<section class="rc-section">` + "\n")
		for _, w := range r.Warnings {
			b.WriteString(`  <div class="rc-warn">⚠ ` + htmlEscape(w) + "</div>\n")
		}
		b.WriteString("</section>\n")
	}

	// ── footer ──
	b.WriteString(`<footer class="rc-foot">` + "\n")
	b.WriteString(`  <span>reconstructed from the append-only ledger — actor≠verifier is machine-enforced, not asserted.</span>` + "\n")
	b.WriteString(`  <span class="rc-dim">generated ` + htmlEscape(time.Now().UTC().Format("2006-01-02 15:04:05")+" UTC") + " · agix artifacts</span>\n")
	b.WriteString("</footer>\n")

	b.WriteString("</main>\n</body>\n</html>\n")
	return b.String()
}

// htmlGovernanceMeta maps the governance status to the hero's css class, its big
// badge (HTML, glyph included), and a one-line explanatory sub-note.
func htmlGovernanceMeta(g Governance) (cls, badge, sub string) {
	switch g.Status {
	case "distinct":
		return "rc-distinct",
			`<span class="rc-glyph">✓</span> actor &ne; verifier — DISTINCT`,
			"A verifier ratified work it did not produce. The structural guarantee holds for this run."
	case "violation":
		return "rc-violation",
			`<span class="rc-glyph">✗</span> VIOLATION — actor also verified`,
			"An agent both produced and ratified the work."
	case "pending":
		return "rc-pending",
			`<span class="rc-glyph">⏳</span> pending ratification`,
			"Work paused at the actor≠verifier gate with no ratification yet."
	default:
		return "rc-none",
			`<span class="rc-glyph">◦</span> no governance gate in this run`,
			"This run path carried no ratification gate."
	}
}

func htmlVerdictMeta(state string) (cls, label string) {
	switch state {
	case "approved":
		return "rc-vb-ok", "✓ APPROVED"
	case "rejected":
		return "rc-vb-bad", "✗ REJECTED"
	case "pending":
		return "rc-vb-pending", "⏳ PENDING"
	default:
		return "rc-vb-none", "— no verdict"
	}
}

// htmlChips renders a set of agent names as escaped chips, or an empty-state note.
func htmlChips(items []string, chipCls, empty string) string {
	if len(items) == 0 {
		return `<span class="rc-empty">` + htmlEscape(empty) + `</span>`
	}
	var b strings.Builder
	for _, it := range items {
		b.WriteString(`<span class="rc-chip ` + chipCls + `">` + htmlEscape(it) + `</span>`)
	}
	return b.String()
}

func htmlStat(label, value string) string {
	return `    <div class="rc-stat"><div class="rc-stat-v">` + htmlEscape(value) +
		`</div><div class="rc-stat-l">` + htmlEscape(label) + `</div></div>` + "\n"
}

// embedImageDataURI best-effort embeds a small local raster image as a base64
// data URI so the receipt stays self-contained. Returns ok=false for anything
// that is not a small, existing, readable raster file — never fabricates.
func embedImageDataURI(path string) (string, bool) {
	const maxBytes = 512 * 1024
	mime, ok := imageMIME[strings.ToLower(filepath.Ext(path))]
	if !ok {
		return "", false
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || info.Size() > maxBytes || info.Size() == 0 {
		return "", false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data), true
}

var imageMIME = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
}

// htmlEscape escapes the five markup-significant runes so any ledger-derived
// string (task, agent name, notes, path) is inert as HTML. Stdlib-free by intent.
func htmlEscape(s string) string {
	return htmlEscaper.Replace(s)
}

var htmlEscaper = strings.NewReplacer(
	"&", "&amp;",
	"<", "&lt;",
	">", "&gt;",
	`"`, "&quot;",
	"'", "&#39;",
)

func orValue(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

// commafy renders an int with thousands separators (12345 → "12,345").
func commafy(n int) string {
	s := fmt.Sprintf("%d", n)
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	var out strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			out.WriteByte(',')
		}
		out.WriteRune(c)
	}
	if neg {
		return "-" + out.String()
	}
	return out.String()
}

// honeycombSVG is the header's decorative honeycomb accent — an inline SVG pattern
// (no external ref) tinted via currentColor and dimmed by CSS.
const honeycombSVG = `<svg class="rc-comb" aria-hidden="true" preserveAspectRatio="xMidYMid slice">` +
	`<defs><pattern id="rc-hc" width="28" height="48" patternUnits="userSpaceOnUse">` +
	`<path d="M14 0 L27 7 L27 21 L14 28 L1 21 L1 7 Z M28 24 L41 31" fill="none" stroke="currentColor" stroke-width="1"/>` +
	`<path d="M14 24 L27 31 L27 45 L14 52 L1 45 L1 31 Z" fill="none" stroke="currentColor" stroke-width="1"/>` +
	`</pattern></defs><rect width="100%" height="100%" fill="url(#rc-hc)"/></svg>`

// receiptCSS is the full inline stylesheet — honey-gold brand, dark-friendly,
// responsive, printable. No @import, no external font/URL (strict-CSP safe).
const receiptCSS = `
:root{
  --bg:#fbf7ee; --panel:#ffffff; --ink:#201d16; --muted:#6f6857;
  --line:#e8ddc4; --honey:#f0a500; --honey-deep:#b97f00; --comb:#caa259;
  --ok:#1c8a48; --ok-bg:#e7f4ea; --ok-line:#9bd3ac;
  --bad:#cf2e2e; --bad-bg:#fdecec; --bad-line:#f0a3a3;
  --warn:#a76c05; --warn-bg:#fbf1dc; --warn-line:#e6c680;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#131109; --panel:#1e1a12; --ink:#f3ecda; --muted:#a89f89;
    --line:#39311f; --honey:#ffb524; --honey-deep:#f0a500; --comb:#d7af5f;
    --ok:#57d98a; --ok-bg:#0f2e1c; --ok-line:#255c3b;
    --bad:#ff6d6d; --bad-bg:#37160f; --bad-line:#7a2a24;
    --warn:#f0b429; --warn-bg:#33280d; --warn-line:#6b551f;
  }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg); color:var(--ink);
  font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  padding:24px 16px;
}
.rc-mono,code,.rc-run,.rc-table td.rc-mono{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.receipt{
  max-width:860px; margin:0 auto; background:var(--panel);
  border:1px solid var(--line); border-radius:14px; overflow:hidden;
  box-shadow:0 1px 3px rgba(0,0,0,.06);
}
/* header */
.rc-head{position:relative; overflow:hidden;
  background:linear-gradient(135deg,var(--honey),var(--honey-deep));
  color:#241a00; padding:22px 24px;}
.rc-comb{position:absolute; inset:0; width:100%; height:100%; color:#ffffff; opacity:.18; pointer-events:none;}
.rc-head-inner{position:relative}
.rc-brand{font-weight:700; font-size:12.5px; letter-spacing:.06em; text-transform:uppercase; opacity:.85;}
.rc-hex{font-size:14px}
.rc-task{margin:.35em 0 .5em; font-size:24px; line-height:1.25; font-weight:750; overflow-wrap:anywhere;}
.rc-task-empty{opacity:.7; font-style:italic; font-weight:600; font-size:18px;}
.rc-meta{display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; font-size:12.5px;}
.rc-pill{background:rgba(0,0,0,.16); color:#241a00; padding:2px 9px; border-radius:999px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; font-size:11px;}
.rc-run{font-weight:600; background:rgba(0,0,0,.10); padding:2px 8px; border-radius:6px; overflow-wrap:anywhere;}
.rc-when,.rc-cap{opacity:.85}
/* hero */
.rc-hero{margin:20px; border-radius:12px; padding:20px; border:2px solid var(--line); background:var(--bg);}
.rc-hero-badge{font-size:19px; font-weight:800; letter-spacing:.01em; display:flex; align-items:center; gap:10px; flex-wrap:wrap;}
.rc-glyph{font-size:22px; line-height:1;}
.rc-distinct{border-color:var(--ok-line); background:var(--ok-bg);}
.rc-distinct .rc-hero-badge{color:var(--ok);}
.rc-violation{border-color:var(--bad-line); background:var(--bad-bg);}
.rc-violation .rc-hero-badge{color:var(--bad);}
.rc-pending{border-color:var(--warn-line); background:var(--warn-bg);}
.rc-pending .rc-hero-badge{color:var(--warn);}
.rc-none .rc-hero-badge{color:var(--muted);}
.rc-flow{display:flex; align-items:stretch; gap:14px; margin-top:16px; flex-wrap:wrap;}
.rc-flow-col{flex:1 1 220px; min-width:0;}
.rc-flow-label{font-size:11px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); font-weight:700; margin-bottom:7px;}
.rc-count{display:inline-block; min-width:18px; text-align:center; background:var(--line); color:var(--ink); border-radius:999px; padding:0 6px; margin-left:4px; font-size:11px;}
.rc-flow-op{display:flex; align-items:center; font-size:26px; font-weight:800; color:var(--honey-deep); padding:0 4px;}
.rc-chips{display:flex; flex-wrap:wrap; gap:6px;}
.rc-chip{font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; padding:3px 9px; border-radius:7px; border:1px solid var(--line); background:var(--panel); overflow-wrap:anywhere;}
.rc-chip-verifier{border-color:var(--ok-line);}
.rc-empty{color:var(--muted); font-style:italic; font-size:13px;}
.rc-hero-note{margin:14px 0 0; font-size:13px; color:var(--muted);}
.rc-violations{margin-top:14px; border-top:1px dashed var(--bad-line); padding-top:12px;}
.rc-violations-title{font-weight:800; color:var(--bad); margin-bottom:6px;}
.rc-violation-row{font-size:13.5px; margin:4px 0;}
/* sections */
.rc-section{padding:6px 24px 4px;}
.rc-h2{font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); font-weight:700; margin:18px 0 10px; border-bottom:1px solid var(--line); padding-bottom:6px;}
.rc-verdict{display:flex; align-items:center; gap:12px; flex-wrap:wrap;}
.rc-verdict-badge{font-weight:800; padding:4px 12px; border-radius:8px; font-size:14px;}
.rc-vb-ok{color:var(--ok); background:var(--ok-bg); border:1px solid var(--ok-line);}
.rc-vb-bad{color:var(--bad); background:var(--bad-bg); border:1px solid var(--bad-line);}
.rc-vb-pending{color:var(--warn); background:var(--warn-bg); border:1px solid var(--warn-line);}
.rc-vb-none{color:var(--muted); border:1px solid var(--line);}
.rc-verdict-by{color:var(--muted); font-size:13px;}
.rc-verdict-note{margin:10px 0 4px; color:var(--muted); font-size:13.5px; overflow-wrap:anywhere;}
/* stats */
.rc-stats{display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px;}
.rc-stat{border:1px solid var(--line); border-radius:10px; padding:10px 12px; background:var(--bg);}
.rc-stat-v{font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-weight:700; font-size:16px; overflow-wrap:anywhere;}
.rc-stat-l{font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin-top:2px;}
/* table */
.rc-table-wrap{overflow-x:auto;}
.rc-table{width:100%; border-collapse:collapse; font-size:13px;}
.rc-table th{text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); border-bottom:1px solid var(--line); padding:7px 10px;}
.rc-table td{padding:6px 10px; border-bottom:1px solid var(--line); vertical-align:top;}
.rc-table tr:last-child td{border-bottom:none;}
.rc-dim{color:var(--muted);}
/* evidence */
.rc-evidence{list-style:none; margin:0; padding:0; font-size:13.5px;}
.rc-evidence li{padding:6px 0; border-bottom:1px solid var(--line);}
.rc-evidence li:last-child{border-bottom:none;}
.rc-fig{margin:0;}
.rc-fig img{max-width:100%; height:auto; border:1px solid var(--line); border-radius:8px; display:block; margin-bottom:6px;}
.rc-fig figcaption{font-size:12.5px;}
code{background:var(--bg); border:1px solid var(--line); border-radius:5px; padding:1px 5px; font-size:12.5px;}
/* warnings */
.rc-warn{background:var(--warn-bg); border:1px solid var(--warn-line); color:var(--warn); border-radius:9px; padding:10px 14px; margin:8px 0; font-weight:600; font-size:13.5px; overflow-wrap:anywhere;}
/* footer */
.rc-foot{display:flex; flex-direction:column; gap:3px; padding:16px 24px 22px; margin-top:10px; border-top:1px solid var(--line); font-size:12px; color:var(--muted);}
@media (max-width:520px){
  .rc-flow-op{display:none;}
  .rc-task{font-size:20px;}
}
@media print{
  body{background:#fff; padding:0;}
  .receipt{border:none; box-shadow:none; max-width:none;}
  .rc-comb{opacity:.10;}
}
`

// ── small helpers ───────────────────────────────────────────────────────────────

func okMark() string {
	if colorOn() {
		return paint(cHoney+cBold, "✓")
	}
	return "OK"
}

func badMark() string {
	if colorOn() {
		return "\033[38;5;203m\033[1m✗" + cReset
	}
	return "!!"
}

func kindGlyph(kind string) string {
	if !colorOn() {
		return ""
	}
	switch kind {
	case ledger.KindRatify, ledger.KindGatePause:
		return paint(cHoney, "◆ ")
	case ledger.KindAgentDone:
		return paint(cComb, "● ")
	default:
		return paint(cDim, "· ")
	}
}

func beeWord(n int) string {
	if n == 1 {
		return "1 bee"
	}
	return fmt.Sprintf("%d bees", n)
}

func humanDur(ms int64) string {
	if ms < 1000 {
		return fmt.Sprintf("%dms", ms)
	}
	return fmt.Sprintf("%.1fs", float64(ms)/1000)
}

func pad(s string, n int) string {
	if len(s) >= n {
		return s
	}
	return s + spaces(n-len(s))
}

func truncCell(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= n {
		return s
	}
	if n <= 1 {
		return s[:n]
	}
	return s[:n-1] + "…"
}

func nonEmpty(vals ...string) []string {
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			out = append(out, v)
		}
	}
	return out
}

// ── ledger-data accessors (defensive over map[string]any) ───────────────────────

func str(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func fnum(m map[string]any, key string) float64 {
	if m == nil {
		return 0
	}
	switch v := m[key].(type) {
	case float64:
		return v
	case int:
		return float64(v)
	}
	return 0
}

func inum(m map[string]any, key string) int {
	if m == nil {
		return 0
	}
	switch v := m[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	}
	return 0
}

func roleOf(e ledger.Entry) string  { return str(e.Data, "role") }
func phaseOf(e ledger.Entry) string { return str(e.Data, "phase") }

// isVerify reports whether a model_call was the verifier's grade (so its agent is
// counted as a verifier, not an actor).
func isVerify(e ledger.Entry) bool {
	return roleOf(e) == "verifier" || phaseOf(e) == "verify"
}

// scopesOf reads a lease_claim's scope, which is emitted as a []string (swarm/
// agent path) or a plain string (the flow path).
func scopesOf(m map[string]any) []string {
	if m == nil {
		return nil
	}
	switch v := m["scope"].(type) {
	case string:
		return []string{v}
	case []any:
		out := make([]string, 0, len(v))
		for _, s := range v {
			if str, ok := s.(string); ok {
				out = append(out, str)
			}
		}
		return out
	case []string:
		return v
	}
	return nil
}

// swarmRunIDFromScope extracts <runID> from a scope like
// "<hive>/swarm/<runID>/subtask/<id>" — the one globally-unique run handle the
// ledger carries. Returns "" for a non-swarm scope.
func swarmRunIDFromScope(scope string) string {
	parts := strings.Split(scope, "/")
	for i := 0; i+1 < len(parts); i++ {
		if parts[i] == "swarm" {
			return parts[i+1]
		}
	}
	return ""
}

// isSubtaskID reports whether a recorded task is a swarm subtask id (st-1, st-2…)
// rather than a real run task — those are worker frames, not the run's task.
func isSubtaskID(t string) bool {
	return strings.HasPrefix(t, "st-")
}

// originalTaskFromGate best-effort extracts the run task from a swarm gate_pause
// payload's subject, which (under the deterministic path) embeds
// "Original task: <task>". Real-provider syntheses won't carry this marker, so
// this is a best-effort recovery, not a guarantee — see the report's honest gaps.
func originalTaskFromGate(m map[string]any) string {
	payload, ok := m["payload"].(map[string]any)
	if !ok {
		return ""
	}
	subject := str(payload, "subject")
	const marker = "Original task:"
	idx := strings.Index(subject, marker)
	if idx < 0 {
		return ""
	}
	rest := subject[idx+len(marker):]
	if nl := strings.IndexByte(rest, '\n'); nl >= 0 {
		rest = rest[:nl]
	}
	return strings.TrimSpace(rest)
}

// ── ordered set (deterministic, insertion-ordered) ──────────────────────────────

type orderedSet struct {
	seen  map[string]bool
	order []string
}

func newOrderedSet() *orderedSet { return &orderedSet{seen: map[string]bool{}} }

func (s *orderedSet) add(v string) {
	if v == "" || s.seen[v] {
		return
	}
	s.seen[v] = true
	s.order = append(s.order, v)
}

func (s *orderedSet) has(v string) bool { return s.seen[v] }
func (s *orderedSet) len() int          { return len(s.order) }
func (s *orderedSet) slice() []string   { return s.order }
