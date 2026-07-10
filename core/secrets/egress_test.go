package secrets_test

import (
	"strings"
	"testing"

	"github.com/agix-ai/agix/core/secrets"
)

func TestEgressScannerCatchesEachShape(t *testing.T) {
	pemBlock := "-----BEGIN RSA PRIVATE KEY-----\n" + // # public-clean: ok synthetic PEM fixture (exercises the private-key egress detector; not a real key)
		"MIIEowIBAAKCAQEArandomlookingbase64contenthereXYZ0123456789abcdef\n" +
		"-----END RSA PRIVATE KEY-----"

	cases := []struct {
		name   string
		secret string
		want   string
	}{
		{"anthropic", "sk-ant-api03-AbCdEf0123456789GhIjKlMnOpQrStUvWx", secrets.KindAnthropicKey}, // # public-clean: ok synthetic key fixture (detector test)
		{"openrouter", "sk-or-v1-0123456789abcdef0123456789abcdef", secrets.KindOpenRouterKey},
		{"github", "ghp_1234567890abcdefghij1234567890abcd", secrets.KindGitHubToken}, // # public-clean: ok synthetic token fixture (detector test)
		{"aws", "AKIAIOSFODNN7EXAMPLE", secrets.KindAWSAccessKey},                     // # public-clean: ok AWS doc example key fixture (detector test)
		{"google", "AIzaSyA0123456789abcdefghijklmnopqrstuvw", secrets.KindGoogleAPIKey},
		{"pem", pemBlock, secrets.KindPrivateKey},
		{"high-entropy", "xQ8vN2mZ7rL5kP1wT3bY9cF6hJ0dG4sA1eR", secrets.KindHighEntropy},
	}

	sc := secrets.NewEgressScanner()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			text := "prefix noise " + tc.secret + " suffix noise"
			fs := sc.Scan(text)
			if !hasKind(fs, tc.want) {
				t.Fatalf("Scan(%s) = %+v, want a %s finding", tc.name, fs, tc.want)
			}
			// A Finding must not carry the secret bytes — verify the offsets it
			// reports actually cover the planted secret without exposing it.
			for _, f := range fs {
				if f.Start < 0 || f.End > len(text) || f.Start >= f.End {
					t.Errorf("finding has bogus offsets: %+v", f)
				}
			}
			red := sc.Redact(text)
			if strings.Contains(red, tc.secret) {
				t.Errorf("Redact left the secret in place: %q", red)
			}
			if !strings.Contains(red, "[REDACTED:"+tc.want+"]") {
				t.Errorf("Redact = %q, want a [REDACTED:%s] marker", red, tc.want)
			}
		})
	}
}

func TestEgressScannerAnthropicInLargerText(t *testing.T) {
	// No false negative on a key buried in a realistic PR-diff-like blob.
	key := "sk-ant-api03-ZZZaaa111bbb222ccc333ddd444eee555" // # public-clean: ok synthetic key fixture (detector test)
	text := `diff --git a/config.ts b/config.ts
+  const client = new Anthropic({
+    apiKey: "` + key + `", // TODO: move to vault
+  });
   export default client;`

	sc := secrets.NewEgressScanner()
	fs := sc.Scan(text)
	if !hasKind(fs, secrets.KindAnthropicKey) {
		t.Fatalf("buried sk-ant key not found; findings=%+v", fs)
	}
	if red := sc.Redact(text); strings.Contains(red, key) {
		t.Fatalf("Redact left the buried key: %q", red)
	}
}

func TestEgressScannerNoFalsePositiveOnProse(t *testing.T) {
	sc := secrets.NewEgressScanner()
	prose := "The quick brown fox jumps over the lazy dog near the hive entrance."
	if fs := sc.Scan(prose); len(fs) != 0 {
		t.Errorf("prose flagged %d findings, want 0: %+v", len(fs), fs)
	}
}

func TestEgressScannerRedactMultiple(t *testing.T) {
	sc := secrets.NewEgressScanner()
	text := "a=ghp_1234567890abcdefghij1234567890abcd b=AKIAIOSFODNN7EXAMPLE end" // # public-clean: ok synthetic secret fixtures (detector test)
	red := sc.Redact(text)
	if strings.Contains(red, "ghp_") || strings.Contains(red, "AKIA") {
		t.Fatalf("Redact missed a secret: %q", red)
	}
	if !strings.HasPrefix(red, "a=[REDACTED:") || !strings.HasSuffix(red, " end") {
		t.Errorf("Redact mangled surrounding text: %q", red)
	}
}

// TestRedactKnownStripsKeysButKeepsIDs proves the boundary redactor (wired into
// ledger.Append + apiary report-home): it removes real credential shapes but
// leaves structured identifiers (a UUID lease/envelope id) intact — the full
// Redact would sweep the UUID up as high-entropy, corrupting the audit trail.
func TestRedactKnownStripsKeysButKeepsIDs(t *testing.T) {
	sc := secrets.NewEgressScanner()
	const key = "AIzaSyABCD0123456789abcdefghijklmnopqrs"
	const uuid = "018f9c2a-1111-7000-8000-000000000abc" // envelope/lease id shape
	text := "envelope " + uuid + " leaked key=" + key + " done"

	red := sc.RedactKnown(text)
	if strings.Contains(red, key) {
		t.Fatalf("RedactKnown left the API key: %q", red)
	}
	if !strings.Contains(red, "[REDACTED:google-api-key]") {
		t.Fatalf("RedactKnown = %q, want a google-api-key marker", red)
	}
	if !strings.Contains(red, uuid) {
		t.Fatalf("RedactKnown must preserve the UUID id, got: %q", red)
	}

	// Contrast: a high-entropy random token is preserved by RedactKnown (no
	// entropy pass) but swept by the full Redact — which is exactly why the wired
	// boundaries use RedactKnown, so they don't corrupt the governance audit trail.
	const hi = "xQ8vN2mZ7rL5kP1wT3bY9cF6hJ0dG4sA1eR"
	if got := sc.RedactKnown("token " + hi + " end"); !strings.Contains(got, hi) {
		t.Fatalf("RedactKnown must preserve a non-key high-entropy token, got: %q", got)
	}
	if got := sc.Redact("token " + hi + " end"); strings.Contains(got, hi) {
		t.Fatalf("full Redact should sweep the high-entropy token, got: %q", got)
	}
}

func hasKind(fs []secrets.Finding, kind string) bool {
	for _, f := range fs {
		if f.Kind == kind {
			return true
		}
	}
	return false
}
