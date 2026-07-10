// Package distill turns the hive's own VERIFIER-CERTIFIED record into a local-model
// distillation corpus — the seam that closes the compounding flywheel
// (packs/refactor/SPEC.md §4). Every certified refactoring becomes a labeled
// training example, so the cheap local nucleus learns from the hive's real,
// governed work instead of a synthetic oracle. "Certified" means attested on the
// Comb by a DISTINCT verifier (actor≠verifier) at or above a trust floor — that
// governance is exactly what keeps the corpus clean: plausible-but-wrong edits are
// never attested, so they never leak into the weights (the anti-collapse filter
// the distillation literature says is mandatory).
//
// Output is the mlx-lm "chat" schema ({"messages":[{system},{user},{assistant}]})
// that research/llm-training/lora consumes, split BY CODEBASE — whole source repos
// held out, never per-row — so the eval measures generalization to an UNSEEN
// codebase (the honest regime, mirroring prepare_data.py's by-seed holdout). Pair
// training with `--mask-prompt` so the loss lands only on the assistant turn.
//
// HONEST LIMITATION (2026-07-07 first cut): today the refactor pack writes its
// certified record to the Comb as a PROSE SUMMARY (behavior-guard emits
// "Verdict APPROVE (<date>) for <id> [behavior=.. structure=.. tangling=..]:
// <delta>"), so the (input→output) pairs this produces are COARSE — the "before"
// code is not in the leaf. The exporter ALSO parses a structured CertifiedRefactoring
// when the leaf content is JSON (the forward-compatible path): enriching the pack
// to write that structured record — the documented follow-up — upgrades corpus
// quality with zero change here. The seam (certified record → training corpus) is
// the architecturally load-bearing part, and it is real now.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package distill

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/agix-ai/agix/core/kmstore"
)

// DefaultSystem is the role prompt prepended to every training example. It states
// the behavior-preservation contract the certified refactorings were held to.
const DefaultSystem = "You are a refactoring surgeon. Apply one behavior-preserving structural refactoring: preserve observable behavior exactly, improve internal structure, and never tangle a feature or fix into the change. Prefer the high-level structural refactorings (extract class/subclass, split class, extract method) over renames."

// CertifiedRefactoring is the forward-compatible STRUCTURED record a refactor bee
// may write as JSON into a Comb leaf's content. When present it yields a rich
// training example; when absent the exporter falls back to parsing the prose
// summary the pack writes today. Every field is optional so a partial record still
// maps.
type CertifiedRefactoring struct {
	Codebase    string `json:"codebase"`    // source repo id — the by-codebase holdout key
	Smell       string `json:"smell"`       // the structural smell that was found
	Refactoring string `json:"refactoring"` // the refactoring type applied (extract_class, …)
	Before      string `json:"before"`      // the "before" code / context the model sees (the input)
	After       string `json:"after"`       // the certified behavior-preserving diff (the output)
	MetricDelta string `json:"metric_delta"`
	Verdict     string `json:"verdict"` // APPROVE / REFUSE
	Rationale   string `json:"rationale"`
}

// Example is one certified training example plus the codebase it came from (the
// holdout key). System/User/Assistant become the three chat turns.
type Example struct {
	System    string
	User      string
	Assistant string
	Codebase  string // whole-codebase holdout key; "(unknown)" when the leaf lacks one
}

const unknownCodebase = "(unknown)"

// verdictProse matches the prose summary behavior-guard writes today:
//
//	Verdict APPROVE (2026-07-07) for extract-class-src/foo:42 [behavior=true structure=true tangling=false reason=x]: <delta>
var verdictProse = regexp.MustCompile(`^Verdict (APPROVE|REFUSE) \(([^)]*)\) for (\S+) \[([^\]]*)\]:\s*(.*)$`)

// Options configures an export run.
type Options struct {
	OutDir    string  // directory to write {train,valid,test}.jsonl into
	System    string  // role prompt (DefaultSystem when empty)
	MinTrust  float64 // drop certified leaves below this verifier trust (default 0.9 = APPROVE)
	FracValid float64 // fraction of codebases held out for validation (default 0.12)
	FracTest  float64 // fraction of codebases held out for test (default 0.12)
	Seed      int64   // RNG seed for the deterministic split
}

func (o Options) withDefaults() Options {
	if o.System == "" {
		o.System = DefaultSystem
	}
	if o.MinTrust <= 0 {
		o.MinTrust = 0.9
	}
	if o.FracValid <= 0 {
		o.FracValid = 0.12
	}
	if o.FracTest <= 0 {
		o.FracTest = 0.12
	}
	if o.Seed == 0 {
		o.Seed = 7
	}
	return o
}

// Stats reports the outcome of an export.
type Stats struct {
	LeavesIn  int
	Examples  int
	Skipped   int
	Codebases int
	Train     int
	Valid     int
	Test      int
}

// LeafToExample maps one certified Comb leaf to a training example. It returns
// (_, false) for a leaf that is not a usable certified refactoring: a non-APPROVE
// verdict, a below-floor trust, empty content, an un-attested leaf (no verifier),
// or a campaign/meta summary that is not an (input→output) pair. system is the role
// prompt to stamp on the example.
func LeafToExample(l kmstore.Leaf, system string, minTrust float64) (Example, bool) {
	if strings.TrimSpace(l.Content) == "" {
		return Example{}, false
	}
	// Attestation is the "certified" gate: a leaf a distinct verifier vouched for
	// above the floor. The caller should already enumerate attested-only, but guard
	// here too so LeafToExample is safe on any leaf.
	if strings.TrimSpace(l.Verifier) == "" || l.TrustScore < minTrust {
		return Example{}, false
	}

	// 1. Structured path: a CertifiedRefactoring embedded in the content — either the
	//    whole content is the JSON object, or (the convention behavior-guard writes) a
	//    human-readable prose summary is followed by the JSON object on its own line,
	//    so the leaf stays auditable AND machine-parseable.
	if cr, ok := extractCertified(l.Content); ok {
		if cr.Verdict != "" && !strings.EqualFold(cr.Verdict, "APPROVE") {
			return Example{}, false
		}
		if ex := exampleFromStructured(cr, system); strings.TrimSpace(ex.Assistant) != "" {
			return ex, true
		}
		return Example{}, false
	}

	// 2. Coarse prose path: parse the verdict summary the pack writes today.
	if m := verdictProse.FindStringSubmatch(l.Content); m != nil {
		verdict, _, candidate, _, delta := m[1], m[2], m[3], m[4], m[5]
		if !strings.EqualFold(verdict, "APPROVE") || strings.TrimSpace(delta) == "" {
			return Example{}, false
		}
		return Example{
			System:    system,
			User:      fmt.Sprintf("Apply the certified behavior-preserving refactoring for candidate %q. Show the change and confirm behavior is preserved.", candidate),
			Assistant: strings.TrimSpace(delta),
			Codebase:  codebaseFromCandidate(candidate),
		}, true
	}

	// Anything else (campaign summaries, free-form leaves) is not a training pair.
	return Example{}, false
}

func exampleFromStructured(cr CertifiedRefactoring, system string) Example {
	var user strings.Builder
	if cr.Smell != "" {
		fmt.Fprintf(&user, "Smell: %s\n", cr.Smell)
	}
	if cr.Refactoring != "" {
		fmt.Fprintf(&user, "Apply: %s\n", cr.Refactoring)
	}
	if cr.Before != "" {
		fmt.Fprintf(&user, "Code:\n%s", cr.Before)
	} else {
		user.WriteString("Apply the certified behavior-preserving refactoring.")
	}
	assistant := strings.TrimSpace(strings.TrimSpace(cr.After) + "\n\n" + strings.TrimSpace(cr.Rationale))
	cb := cr.Codebase
	if strings.TrimSpace(cb) == "" {
		cb = unknownCodebase
	}
	return Example{System: system, User: strings.TrimSpace(user.String()), Assistant: assistant, Codebase: cb}
}

// extractCertified pulls a CertifiedRefactoring out of a leaf's content. It supports
// two conventions: the whole content is the JSON object, OR a human-readable prose
// summary is followed by the JSON object on its own line (behavior-guard's write —
// the leaf stays auditable AND machine-parseable). A JSON object with none of
// after/refactoring/before is rejected as "not a real record".
func extractCertified(content string) (CertifiedRefactoring, bool) {
	try := func(s string) (CertifiedRefactoring, bool) {
		s = strings.TrimSpace(s)
		if !strings.HasPrefix(s, "{") || !strings.HasSuffix(s, "}") {
			return CertifiedRefactoring{}, false
		}
		var cr CertifiedRefactoring
		if err := json.Unmarshal([]byte(s), &cr); err != nil {
			return CertifiedRefactoring{}, false
		}
		if cr.After == "" && cr.Refactoring == "" && cr.Before == "" {
			return CertifiedRefactoring{}, false
		}
		return cr, true
	}
	if cr, ok := try(content); ok { // whole content is the record
		return cr, true
	}
	// Scan bottom-up: the record is appended beneath the prose summary.
	lines := strings.Split(content, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if cr, ok := try(lines[i]); ok {
			return cr, true
		}
	}
	return CertifiedRefactoring{}, false
}

// codebaseFromCandidate best-efforts a codebase key from a candidate id. Today's
// behavior-guard ids don't carry the codebase, so this returns "(unknown)" and the
// split groups such examples together — true per-codebase holdout requires the
// structured record's Codebase field (the documented follow-up).
func codebaseFromCandidate(candidate string) string {
	// A candidate like "extract-class-services/billing/foo.go:42" — take the path's
	// first segment after the refactoring kind if one is discernible; else unknown.
	if i := strings.IndexAny(candidate, "/"); i > 0 {
		// walk back to the segment start
		seg := candidate[:i]
		if j := strings.LastIndex(seg, "-"); j >= 0 && j+1 < len(seg) {
			return seg[j+1:] + "/" + firstPathSeg(candidate[i+1:])
		}
	}
	return unknownCodebase
}

func firstPathSeg(p string) string {
	if i := strings.IndexByte(p, '/'); i >= 0 {
		return p[:i]
	}
	return p
}

// chatRecord renders an Example as the mlx-lm chat JSONL object.
func chatRecord(e Example) map[string]any {
	return map[string]any{
		"messages": []map[string]string{
			{"role": "system", "content": e.System},
			{"role": "user", "content": e.User},
			{"role": "assistant", "content": e.Assistant},
		},
	}
}

// SplitByCodebase partitions examples into train/valid/test by holding out WHOLE
// codebases (never splitting one codebase across sets — that would leak). The split
// is deterministic given seed. Every codebase lands entirely in one bucket.
func SplitByCodebase(examples []Example, fracValid, fracTest float64, seed int64) (train, valid, test []Example) {
	byCB := map[string][]Example{}
	for _, e := range examples {
		byCB[e.Codebase] = append(byCB[e.Codebase], e)
	}
	codebases := make([]string, 0, len(byCB))
	for cb := range byCB {
		codebases = append(codebases, cb)
	}
	sort.Strings(codebases) // deterministic pre-shuffle order
	rng := rand.New(rand.NewSource(seed))
	rng.Shuffle(len(codebases), func(i, j int) { codebases[i], codebases[j] = codebases[j], codebases[i] })

	n := len(codebases)
	nTest := frac(n, fracTest)
	nValid := frac(n, fracValid)
	// With few codebases, guarantee train is non-empty by capping holdout.
	if nTest+nValid >= n && n > 0 {
		nTest = 0
		if nValid >= n {
			nValid = 0
		}
	}
	testCB := codebases[:nTest]
	validCB := codebases[nTest : nTest+nValid]
	trainCB := codebases[nTest+nValid:]

	for _, cb := range testCB {
		test = append(test, byCB[cb]...)
	}
	for _, cb := range validCB {
		valid = append(valid, byCB[cb]...)
	}
	for _, cb := range trainCB {
		train = append(train, byCB[cb]...)
	}
	return train, valid, test
}

// frac rounds n*f to the nearest int, with a floor of 1 when n>0 and f>0 (so a
// small corpus still yields a holdout), mirroring prepare_data.py's max(1, round).
func frac(n int, f float64) int {
	if n == 0 || f <= 0 {
		return 0
	}
	k := int(float64(n)*f + 0.5)
	if k < 1 {
		k = 1
	}
	if k > n {
		k = n
	}
	return k
}

// Export maps certified leaves to examples, splits them by codebase, and writes
// {train,valid,test}.jsonl into opts.OutDir. Leaves that are not usable certified
// refactorings are skipped (counted in Stats.Skipped).
func Export(leaves []kmstore.Leaf, opts Options) (Stats, error) {
	opts = opts.withDefaults()
	st := Stats{LeavesIn: len(leaves)}

	var examples []Example
	seenCB := map[string]struct{}{}
	for _, l := range leaves {
		ex, ok := LeafToExample(l, opts.System, opts.MinTrust)
		if !ok {
			st.Skipped++
			continue
		}
		examples = append(examples, ex)
		seenCB[ex.Codebase] = struct{}{}
	}
	st.Examples = len(examples)
	st.Codebases = len(seenCB)

	train, valid, test := SplitByCodebase(examples, opts.FracValid, opts.FracTest, opts.Seed)
	st.Train, st.Valid, st.Test = len(train), len(valid), len(test)

	if err := os.MkdirAll(opts.OutDir, 0o755); err != nil {
		return st, err
	}
	for name, rows := range map[string][]Example{"train": train, "valid": valid, "test": test} {
		if err := writeJSONL(filepath.Join(opts.OutDir, name+".jsonl"), rows); err != nil {
			return st, fmt.Errorf("distill: write %s: %w", name, err)
		}
	}
	return st, nil
}

func writeJSONL(path string, rows []Example) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	for _, e := range rows {
		if err := enc.Encode(chatRecord(e)); err != nil {
			return err
		}
	}
	return nil
}
