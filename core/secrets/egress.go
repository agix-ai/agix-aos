// The EgressScanner is the guard at the entrance. Anything crossing the hive
// boundary — a PR diff, a chat message, a ledger write — is inspected before it
// leaves so a secret can't ride out in plaintext. A Finding records only WHERE
// and WHAT KIND; it never stores the matched secret.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package secrets

import (
	"math"
	"regexp"
	"sort"
	"strings"
)

// Finding kinds. These label a match without revealing it.
const (
	KindAnthropicKey  = "anthropic-key"
	KindOpenRouterKey = "openrouter-key"
	KindGitHubToken   = "github-token"
	KindAWSAccessKey  = "aws-access-key-id"
	KindGoogleAPIKey  = "google-api-key"
	KindPrivateKey    = "private-key"
	KindHighEntropy   = "high-entropy-token"
)

// Finding locates a suspected secret in scanned text. It intentionally does NOT
// carry the matched substring — callers slice the source themselves only if they
// have a legitimate need, and Redact never exposes it.
type Finding struct {
	Kind  string // one of the Kind* constants
	Start int    // byte offset, inclusive
	End   int    // byte offset, exclusive
}

// defaultEntropyThreshold is the Shannon entropy (bits/char) above which a long
// alphanumeric run is treated as a probable credential. Random base64/hex tokens
// sit well above it; ordinary prose rarely forms runs this long at all.
const defaultEntropyThreshold = 3.5

// defaultEntropyMinLen is the minimum run length considered for the generic
// high-entropy catch-all. Short tokens are too ambiguous to flag on entropy.
const defaultEntropyMinLen = 24

// Precompiled detectors for known credential shapes.
var (
	reAnthropic = regexp.MustCompile(`sk-ant-[A-Za-z0-9_-]{16,}`)
	reOpenRoute = regexp.MustCompile(`sk-or-[A-Za-z0-9_-]{16,}`)
	reGitHub    = regexp.MustCompile(`gh[pousr]_[A-Za-z0-9]{20,}`)
	reAWS       = regexp.MustCompile(`AKIA[0-9A-Z]{16}`)
	reGoogle    = regexp.MustCompile(`AIza[0-9A-Za-z_-]{35}`)
	// Prefer the whole PEM block; fall back to the header when END is absent.
	rePEMBlock  = regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----`)
	rePEMHeader = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----`)
	// Candidate runs for the entropy pass (base64/hex/url-safe alphabets).
	reEntropyCand = regexp.MustCompile(`[A-Za-z0-9+/=_-]{` + itoa(defaultEntropyMinLen) + `,}`)
)

// EgressScanner detects credential-shaped substrings and redacts them.
type EgressScanner struct {
	entropyThreshold float64
}

// NewEgressScanner returns a scanner tuned with sensible defaults.
func NewEgressScanner() *EgressScanner {
	return &EgressScanner{entropyThreshold: defaultEntropyThreshold}
}

// Scan returns non-overlapping Findings, sorted by Start, for every known secret
// shape plus generic high-entropy tokens. The matched bytes are NEVER copied
// into a Finding.
func (s *EgressScanner) Scan(text string) []Finding { return s.scan(text, true) }

// ScanKnown returns findings for KNOWN credential shapes ONLY — it skips the
// generic high-entropy catch-all. The wired egress boundaries (ledger.Append,
// apiary report-home) use this: they must strip real API keys, but a UUID lease
// id or an envelope id in the governance audit trail sits above the entropy
// threshold and must NOT be swept up — over-redacting the audit record is itself
// a governance harm. The manual `secret scan` CLI keeps the full Scan.
func (s *EgressScanner) ScanKnown(text string) []Finding { return s.scan(text, false) }

func (s *EgressScanner) scan(text string, includeEntropy bool) []Finding {
	var fs []Finding
	add := func(kind string, locs [][]int) {
		for _, m := range locs {
			fs = append(fs, Finding{Kind: kind, Start: m[0], End: m[1]})
		}
	}
	add(KindAnthropicKey, reAnthropic.FindAllStringIndex(text, -1))
	add(KindOpenRouterKey, reOpenRoute.FindAllStringIndex(text, -1))
	add(KindGitHubToken, reGitHub.FindAllStringIndex(text, -1))
	add(KindAWSAccessKey, reAWS.FindAllStringIndex(text, -1))
	add(KindGoogleAPIKey, reGoogle.FindAllStringIndex(text, -1))

	pem := rePEMBlock.FindAllStringIndex(text, -1)
	if len(pem) == 0 {
		pem = rePEMHeader.FindAllStringIndex(text, -1)
	}
	add(KindPrivateKey, pem)

	// Generic high-entropy pass — only for runs not already claimed by a
	// specific detector, so a known key isn't double-reported.
	if includeEntropy {
		for _, m := range reEntropyCand.FindAllStringIndex(text, -1) {
			if overlapsAny(fs, m[0], m[1]) {
				continue
			}
			if shannonEntropy(text[m[0]:m[1]]) >= s.entropyThreshold {
				fs = append(fs, Finding{Kind: KindHighEntropy, Start: m[0], End: m[1]})
			}
		}
	}

	sort.Slice(fs, func(i, j int) bool {
		if fs[i].Start != fs[j].Start {
			return fs[i].Start < fs[j].Start
		}
		return fs[i].End > fs[j].End // longer first on a tie
	})
	return dropOverlaps(fs)
}

// Redact replaces every finding (known shapes + high-entropy) with
// "[REDACTED:<kind>]", leaving surrounding text intact. The secret bytes never
// appear in the result.
func (s *EgressScanner) Redact(text string) string { return redactWith(text, s.Scan(text)) }

// RedactKnown redacts only KNOWN credential shapes (no high-entropy pass) — the
// egress-boundary redactor. The "[REDACTED:<kind>]" marker contains no JSON
// metacharacters, so redacting a marshaled JSON line in place keeps it valid.
func (s *EgressScanner) RedactKnown(text string) string { return redactWith(text, s.ScanKnown(text)) }

func redactWith(text string, fs []Finding) string {
	if len(fs) == 0 {
		return text
	}
	var b strings.Builder
	last := 0
	for _, f := range fs {
		if f.Start < last {
			continue // defensive: Scan already drops overlaps
		}
		b.WriteString(text[last:f.Start])
		b.WriteString("[REDACTED:")
		b.WriteString(f.Kind)
		b.WriteString("]")
		last = f.End
	}
	b.WriteString(text[last:])
	return b.String()
}

// overlapsAny reports whether [start,end) intersects any existing finding.
func overlapsAny(fs []Finding, start, end int) bool {
	for _, f := range fs {
		if start < f.End && f.Start < end {
			return true
		}
	}
	return false
}

// dropOverlaps keeps the earliest finding and discards any that overlap it,
// walking a Start-sorted slice. This guarantees Redact can splice cleanly.
func dropOverlaps(fs []Finding) []Finding {
	if len(fs) == 0 {
		return fs
	}
	out := fs[:0:0]
	end := -1
	for _, f := range fs {
		if f.Start < end {
			continue
		}
		out = append(out, f)
		end = f.End
	}
	return out
}

// shannonEntropy returns the per-character Shannon entropy (bits) of s.
func shannonEntropy(s string) float64 {
	if s == "" {
		return 0
	}
	var counts [256]int
	n := 0
	for i := 0; i < len(s); i++ {
		counts[s[i]]++
		n++
	}
	var h float64
	for _, c := range counts {
		if c == 0 {
			continue
		}
		p := float64(c) / float64(n)
		h -= p * math.Log2(p)
	}
	return h
}

// itoa is a tiny stdlib-free int→string for building the entropy regex at init.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
