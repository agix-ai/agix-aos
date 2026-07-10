// Package agentspec is the reborn agent contract: a fully DECLARATIVE description
// of one bee — data + prompts, not Go code — that the fleet runner executes as a
// governed hivekit bee.
//
// The whole point of the reborn fleet port is that an agent stops being a 40-60KB
// Node agent.mjs and becomes a Spec: its identity (name/role/caste), its trust
// boundary (guard-bee secret allowlist + advisory fs/op limits), its declared
// tools, its per-role model tiering, and its behavioral prompt (the "how", lifted
// out of code into `instructions`). The Go runtime supplies execution + governance
// — the actor≠verifier tool-use loop, Comb access, and the guard-bee boundary —
// so the same governed shape is applied to every agent, and a non-Go author can
// ship a new bee by writing a spec. The `public` flag rides the contract so the
// OSS/proprietary genericization boundary is a property of the agent, not the
// build script.
//
// This package is a stdlib-plus-caste leaf: it decodes and validates specs and
// resolves the role→caste taxonomy through core/caste (the one place that mapping
// lives), and imports nothing heavier, so a spec can be parsed and checked without
// pulling in the swarm engine. The runner (core/fleet) is the package that turns a
// validated Spec into a running governed hive.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package agentspec

import (
	"fmt"
	"strings"

	"github.com/agix-ai/agix/core/caste"
)

// SpecFileName is the canonical on-disk filename for a reborn agent spec. It lives
// beside the legacy Node manifest during the port (agents/<name>/agent.json next to
// agents/<name>/manifest.yaml), so PORT-then-retire can proceed one agent at a time.
const SpecFileName = "agent.json"

// Known trust levels (advisory identity, mirrored from the Node soul doctrine).
// Trust is a soft, auditable declaration; it also seeds the caste when no explicit
// caste is set (conductor→queen, proposer→worker, boundary→drone).
const (
	TrustConductor = "conductor" // decomposes + synthesizes; the queen-led lead
	TrustProposer  = "proposer"  // produces a proposal/diagnosis; never the final authority
	TrustBoundary  = "boundary"  // crosses a hive boundary; the only credential-carrying caste
)

// Spec is the reborn agent contract — the declarative replacement for a Node
// agent's manifest.yaml + soul/policy blocks + the behavioral prompts that used to
// live in agent.mjs. A Spec is DATA: it is authorable without writing Go, and the
// runner (core/fleet) supplies the governed execution.
type Spec struct {
	// Identity.
	Name        string `json:"name"`                   // unique slug; the hive name + policy role key
	DisplayName string `json:"display_name,omitempty"` // human label
	Description string `json:"description,omitempty"`  // one-line what-it-does

	// Distribution. Public rides the contract so the OSS/proprietary split is a
	// property of the agent (the genericization seam), not the release script.
	Tier   string `json:"tier,omitempty"` // basic | pro | enterprise
	Public bool   `json:"public"`         // ships in the open AOS pack

	// Governance identity. Role is free-form (conductor, investigator, researcher…)
	// and resolves to a caste through core/caste; Caste is an explicit override;
	// Trust is the advisory trust level and also seeds the caste when Caste is empty.
	Role  string `json:"role"`            // what it does → caste
	Caste string `json:"caste,omitempty"` // queen | worker | drone (explicit override)
	Trust string `json:"trust,omitempty"` // conductor | proposer | boundary (advisory)

	// Behavior. Instructions is the agent's prompt/persona — the "how" lifted out
	// of Node code into the contract. It is required: a declarative agent that
	// carries no behavior is a manifest, not an agent.
	Instructions string `json:"instructions"`

	// Capabilities. Tools are declared by logical name and resolved against the
	// runner's catalog at run time; an unresolved name is reported, not fatal.
	Tools  []string   `json:"tools,omitempty"`
	Models ModelTiers `json:"models,omitempty"`

	// Boundary is the guard-bee trust boundary: the secret refs this agent's role
	// may resolve (a least-privilege allowlist), plus advisory fs/op limits ported
	// from the Node policy.yaml.
	Boundary Boundary `json:"boundary,omitempty"`

	// Operational metadata (advisory provenance — consumed by the launchd/Cloud Run
	// fire surface and the outputs ledger, not by the swarm).
	Config   []ConfigVar `json:"config,omitempty"`
	Schedule []string    `json:"schedule,omitempty"` // cron lines
	Outputs  []Output    `json:"outputs,omitempty"`
}

// ModelTiers is the per-role model tiering (ported from a Node manifest's
// `defaults` block). Empty fields route the role by its capability tier instead of
// an explicit model, exactly as hivekit's builder does.
type ModelTiers struct {
	Queen    string   `json:"queen,omitempty"`    // decompose + synthesize
	Worker   []string `json:"worker,omitempty"`   // per-worker models, assigned round-robin
	Verifier string   `json:"verifier,omitempty"` // the DISTINCT grader (actor≠verifier)
	Workers  int      `json:"workers,omitempty"`  // worker-bee count; 0 → runner default
}

// Boundary is the trust boundary. Secrets is the guard-bee allowlist — the exact
// set of logical secret refs this agent's role is permitted to resolve
// (deny-by-default for anything not listed). Read/Write/Deny are advisory limits
// ported verbatim from the Node policy.yaml; they are declared here so the runtime
// enforcement seam (core/secrets policy) has a single source of truth, even where
// the current runtime honors them advisorily.
type Boundary struct {
	Secrets []string `json:"secrets,omitempty"` // secret refs this role may resolve
	Read    []string `json:"read,omitempty"`    // advisory fs read globs
	Write   []string `json:"write,omitempty"`   // advisory fs write globs
	Deny    []string `json:"deny,omitempty"`    // denied operations/paths (e.g. "git push", ".github/workflows/")

	// Exec is the governed exec tool's ALLOWLIST: the command-prefixes this agent may
	// run ("go test", "gh", "git status"). It is enforced (not advisory) by the exec
	// tool — empty means the exec capability runs nothing (deny-by-default). Deny
	// (above) vetoes even an allowed prefix, so one boundary declares both limits.
	Exec []string `json:"exec,omitempty"`
	// ExecEnv is the guard-bee grant for the exec tool: child env var NAME → logical
	// secret ref (e.g. {"GH_TOKEN": "gh-token"}). At run time the ref is authorized
	// against the policy and, if allowed, injected ONLY into an exec child's env via
	// a Broker capability — never held as a raw key by the agent. A ref here must also
	// appear in Secrets (the allowlist it is checked against).
	ExecEnv map[string]string `json:"exec_env,omitempty"`
}

// ConfigVar is one required/optional configuration input (e.g. ANTHROPIC_API_KEY).
type ConfigVar struct {
	Name     string `json:"name"`
	Required bool   `json:"required,omitempty"`
}

// Output is one declared output surface (advisory provenance).
type Output struct {
	Kind string `json:"kind"`           // file | email | state
	Path string `json:"path,omitempty"` // where it lands
}

// ResolveCaste maps the spec to its governing caste. An explicit Caste wins; else
// the Trust level seeds it (conductor→queen, proposer→worker, boundary→drone);
// else the role→caste taxonomy in core/caste decides (unknown role → worker, the
// safe least-authority default). This is the mechanical basis for actor≠verifier:
// a conductor is a queen, a proposer is a worker, a boundary bee is a drone.
func (s *Spec) ResolveCaste() caste.Caste {
	if c := strings.ToLower(strings.TrimSpace(s.Caste)); c != "" {
		return caste.Caste(c)
	}
	switch strings.ToLower(strings.TrimSpace(s.Trust)) {
	case TrustConductor:
		return caste.Queen
	case TrustBoundary, "drone":
		return caste.Drone
	case TrustProposer:
		return caste.Worker
	}
	return caste.DefaultCaste(strings.ToLower(strings.TrimSpace(s.Role)))
}

// validCastes is the closed set a resolved/explicit caste must land in.
var validCastes = map[caste.Caste]bool{caste.Queen: true, caste.Worker: true, caste.Drone: true}

// Validate checks the spec is well-formed enough to run: it has an identity, a
// role, a behavior, a caste that resolves into the taxonomy, and no malformed
// tool/config/boundary entries. It is deliberately strict on the load path so a
// hand-authored spec fails at parse time, not mid-run.
func (s *Spec) Validate() error {
	if strings.TrimSpace(s.Name) == "" {
		return fmt.Errorf("agentspec: name is required")
	}
	if strings.ContainsAny(s.Name, " \t/\\") {
		return fmt.Errorf("agentspec: %q: name must be a slug (no spaces or slashes)", s.Name)
	}
	if strings.TrimSpace(s.Role) == "" {
		return fmt.Errorf("agentspec: %q: role is required", s.Name)
	}
	if strings.TrimSpace(s.Instructions) == "" {
		return fmt.Errorf("agentspec: %q: instructions are required (a declarative agent must carry its behavior)", s.Name)
	}
	if c := s.ResolveCaste(); !validCastes[c] {
		return fmt.Errorf("agentspec: %q: caste %q is not one of queen|worker|drone", s.Name, c)
	}
	if t := strings.ToLower(strings.TrimSpace(s.Trust)); t != "" &&
		t != TrustConductor && t != TrustProposer && t != TrustBoundary {
		return fmt.Errorf("agentspec: %q: trust %q is not one of conductor|proposer|boundary", s.Name, s.Trust)
	}
	seen := make(map[string]bool, len(s.Tools))
	for _, name := range s.Tools {
		n := strings.TrimSpace(name)
		if n == "" {
			return fmt.Errorf("agentspec: %q: empty tool name", s.Name)
		}
		if seen[n] {
			return fmt.Errorf("agentspec: %q: duplicate tool %q", s.Name, n)
		}
		seen[n] = true
	}
	for _, c := range s.Config {
		if strings.TrimSpace(c.Name) == "" {
			return fmt.Errorf("agentspec: %q: config entry with an empty name", s.Name)
		}
	}
	// A guard-bee exec grant must name a non-empty env var AND a ref that the agent's
	// own secret allowlist declares — a grant for a ref the boundary does not permit
	// would never be authorized, so it is a spec error, caught at parse time.
	for envVar, ref := range s.Boundary.ExecEnv {
		if strings.TrimSpace(envVar) == "" {
			return fmt.Errorf("agentspec: %q: exec_env entry with an empty env var name", s.Name)
		}
		r := strings.TrimSpace(ref)
		if r == "" {
			return fmt.Errorf("agentspec: %q: exec_env[%s] has an empty secret ref", s.Name, envVar)
		}
		if !containsFold(s.Boundary.Secrets, r) {
			return fmt.Errorf("agentspec: %q: exec_env[%s] grants %q, which is not in boundary.secrets", s.Name, envVar, r)
		}
	}
	return nil
}

// containsFold reports whether want (trimmed) appears in list (trimmed).
func containsFold(list []string, want string) bool {
	for _, s := range list {
		if strings.TrimSpace(s) == want {
			return true
		}
	}
	return false
}
