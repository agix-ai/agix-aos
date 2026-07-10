package agentspec_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/agix-ai/agix/core/agentspec"
	"github.com/agix-ai/agix/core/caste"
)

// a minimal valid spec the mutators below start from.
func valid() agentspec.Spec {
	return agentspec.Spec{
		Name:         "tester",
		Role:         "investigator",
		Trust:        agentspec.TrustProposer,
		Instructions: "find the root cause; never patch.",
	}
}

func TestValidateAcceptsMinimalSpec(t *testing.T) {
	s := valid()
	if err := s.Validate(); err != nil {
		t.Fatalf("valid spec rejected: %v", err)
	}
}

func TestValidateRejectsMissingFields(t *testing.T) {
	cases := map[string]func(*agentspec.Spec){
		"no name":         func(s *agentspec.Spec) { s.Name = "" },
		"no role":         func(s *agentspec.Spec) { s.Role = "" },
		"no instructions": func(s *agentspec.Spec) { s.Instructions = "" },
		"spacey name":     func(s *agentspec.Spec) { s.Name = "two words" },
		"slashy name":     func(s *agentspec.Spec) { s.Name = "a/b" },
		"bad caste":       func(s *agentspec.Spec) { s.Caste = "empress" },
		"bad trust":       func(s *agentspec.Spec) { s.Trust = "vibes" },
		"empty tool":      func(s *agentspec.Spec) { s.Tools = []string{"ok", ""} },
		"dup tool":        func(s *agentspec.Spec) { s.Tools = []string{"read", "read"} },
		"empty config":    func(s *agentspec.Spec) { s.Config = []agentspec.ConfigVar{{Name: ""}} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			s := valid()
			mutate(&s)
			if err := s.Validate(); err == nil {
				t.Errorf("%s: expected a validation error, got nil", name)
			}
		})
	}
}

func TestResolveCaste(t *testing.T) {
	cases := []struct {
		name string
		spec agentspec.Spec
		want caste.Caste
	}{
		{"explicit caste wins", agentspec.Spec{Caste: "drone", Trust: "proposer", Role: "conductor"}, caste.Drone},
		{"trust conductor → queen", agentspec.Spec{Trust: agentspec.TrustConductor, Role: "investigator"}, caste.Queen},
		{"trust proposer → worker", agentspec.Spec{Trust: agentspec.TrustProposer, Role: "conductor"}, caste.Worker},
		{"trust boundary → drone", agentspec.Spec{Trust: agentspec.TrustBoundary, Role: "investigator"}, caste.Drone},
		{"role conductor → queen", agentspec.Spec{Role: "conductor"}, caste.Queen},
		{"unknown role → worker", agentspec.Spec{Role: "investigator"}, caste.Worker},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.spec.ResolveCaste(); got != c.want {
				t.Errorf("ResolveCaste() = %q, want %q", got, c.want)
			}
		})
	}
}

func TestLoadAndDiscover(t *testing.T) {
	root := t.TempDir()
	write := func(name, body string) {
		dir := filepath.Join(root, name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, agentspec.SpecFileName), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("bee", `{"name":"bee","role":"forager","instructions":"forage"}`)
	write("ant", `{"name":"ant","role":"conductor","trust":"conductor","instructions":"lead"}`)
	// A legacy dir with no agent.json must be skipped, not error.
	if err := os.MkdirAll(filepath.Join(root, "legacy"), 0o755); err != nil {
		t.Fatal(err)
	}

	specs, err := agentspec.Discover(root)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(specs) != 2 {
		t.Fatalf("Discover found %d specs, want 2 (legacy dir skipped)", len(specs))
	}
	if specs[0].Name != "ant" || specs[1].Name != "bee" {
		t.Errorf("Discover not sorted by name: got %q, %q", specs[0].Name, specs[1].Name)
	}
	if specs[0].ResolveCaste() != caste.Queen {
		t.Errorf("ant should resolve to queen (trust=conductor), got %q", specs[0].ResolveCaste())
	}

	// An invalid spec present in the tree is a hard error, not a silent skip.
	write("broken", `{"name":"broken","role":"x"}`) // missing instructions
	if _, err := agentspec.Discover(root); err == nil {
		t.Error("Discover should fail on an invalid spec, got nil")
	}

	// LoadName resolves a single agent by name.
	s, err := agentspec.LoadName(root, "bee")
	if err != nil {
		t.Fatalf("LoadName: %v", err)
	}
	if s.Name != "bee" {
		t.Errorf("LoadName returned %q, want bee", s.Name)
	}
}
