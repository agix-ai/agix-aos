// Package fleet is the reborn agent runner: it turns a validated agentspec.Spec
// into a running GOVERNED hive. It is the seam that makes an agent "mostly data" —
// the Spec declares identity, tools, model tiers, and a trust boundary, and the
// Runner maps that declaration onto the tested primitives (hivekit for the
// actor≠verifier tool-use loop, core/secrets for the guard-bee boundary, core/tool
// for the declared capabilities) so every agent inherits the same governed shape.
//
// The mapping is deliberately thin: hivekit already guarantees a distinct verifier
// bee and a $0/offline mock default, so the Runner adds no new governance — it only
// translates a Spec into a hivekit.Hive and enforces the two contract properties
// hivekit does not know about: the guard-bee secret allowlist (an agent may only
// resolve the refs its boundary declares) and the public/proprietary gate (an
// OSS-only runner refuses a proprietary spec).
//
// fleet is a leaf that nothing in core imports; wiring hivekit/secrets/tool here
// introduces no cycle.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package fleet

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/agix-ai/agix/core/agentspec"
	"github.com/agix-ai/agix/core/caste"
	"github.com/agix-ai/agix/core/comb"
	"github.com/agix-ai/agix/core/hivekit"
	"github.com/agix-ai/agix/core/kmstore"
	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/secrets"
	"github.com/agix-ai/agix/core/tool"
	emailtool "github.com/agix-ai/agix/core/tool/email"
	exectool "github.com/agix-ai/agix/core/tool/exec"
	"github.com/agix-ai/agix/core/tool/fs"
	ledgertool "github.com/agix-ai/agix/core/tool/ledger"
	"github.com/agix-ai/agix/core/tool/metric"
)

// mailCredentialGrants maps a well-known logical secret ref (as it appears in an
// agent's boundary.secrets allowlist) to the credential env NAME a mail transport
// reads it under. It is the email tool's guard-bee grant derivation — the analogue
// of a Boundary.ExecEnv, expressed by convention over the existing boundary rather
// than a new spec field, so a manifest declaring `smtp-app-password` in its
// boundary already wires the SMTP_PASSWORD credential (deny-by-default: only a ref
// that is BOTH in this table AND policy-allowed becomes a grant).
var mailCredentialGrants = map[string]string{
	"smtp-app-password": "SMTP_PASSWORD",
	"smtp-password":     "SMTP_PASSWORD",
	"smtp-user":         "SMTP_USER",
	"smtp-host":         "SMTP_HOST",
	"workspace-gmail":   "GMAIL_TOKEN",
	"gmail-token":       "GMAIL_TOKEN",
	"notify-token":      "NOTIFY_TOKEN",
	"notify-webhook":    "NOTIFY_WEBHOOK",
}

// kindSecretAccess is the ledger Kind for a guard-bee boundary decision — the
// agent-authorization half of the secret_access trail (whether this agent's role
// may resolve a ref). The ledger Kind is a plain string, so the fleet layer names
// its own frame without touching the core ledger's closed agent-path kinds.
const kindSecretAccess = "secret_access"

// Runner executes reborn specs. The zero value is usable but bare; prefer New,
// which defaults the provider to the $0/offline mock. All fields are exported so a
// deployment can wire a real tool catalog, an audit ledger, a deployment-wide
// secret policy, and the OSS-only gate.
type Runner struct {
	// Provider selects the model provider for every run ("mock" default).
	Provider string
	// Catalog maps a spec's declared logical tool name to a PRE-BUILT implementation
	// (an explicit override, or a credentialed/global tool a deployment wires). It is
	// consulted FIRST; a name it does not carry falls through to the built-in
	// boundary-scoped filesystem + metric tools (see builtinTool). A declared tool
	// resolved by neither is reported (RunResult.UnresolvedTools), never fatal — an
	// un-ported capability degrades the run, it does not break it.
	Catalog map[string]tool.Tool
	// RepoRoot is the target tree the built-in filesystem/metric tools are scoped to
	// (the sidecar `--repoRoot` seam). Every read/glob/grep/walk/write/metric call an
	// agent makes resolves UNDER this root and can never escape it. Empty defaults to
	// the current working directory. The agent's Boundary (read/write globs, deny)
	// further constrains what inside the root each tool may touch.
	RepoRoot string
	// Ledger is the append-only audit sink the governed run and the boundary
	// decisions write to. nil disables audit.
	Ledger *ledger.Ledger
	// Policy is the DEPLOYMENT's secret allowlist (role→refs). When set it is the
	// authority the guard-bee boundary is checked against, so a spec cannot request
	// a secret the deployment has not granted its role. nil derives a self-consistent
	// policy from each spec (the spec is trusted to declare its own least privilege).
	Policy secrets.Policy
	// Audit, when set, receives one record per boundary decision (role, ref,
	// allowed, source) — never a secret value. It is the guard-bee's secret_access
	// trail for the agent-authorization layer.
	Audit secrets.AuditFunc
	// Vault is the guard-bee's secret store, used ONLY to construct the capability an
	// exec tool needs (a `gh` command receiving GH_TOKEN via a scoped grant). It is
	// resolved lazily and never by the agent directly. nil means no secret can be
	// granted to an exec child — the credentialed tool degrades to unauthenticated
	// (deny-by-default). Construction performs no backend call.
	Vault secrets.SourcedResolver
	// ExecTimeout bounds a single governed exec; <=0 uses the exec tool's default.
	ExecTimeout time.Duration
	// Mailer is the deployment's live email/notification transport, injected for the
	// credentialed email tool (an SMTP client, the Gmail API, a webhook, wrapped in an
	// email.SenderFunc). nil means the email tool runs its $0/offline DryRunSender
	// (records the message, sends nothing) — the honest default. A live Mailer that
	// needs a credential is only ever invoked with a guard-bee grant (fail-closed).
	Mailer emailtool.Sender
	// PublicOnly, when true, makes Run refuse a spec with Public=false — the OSS
	// distribution gate, so the open pack can never execute a proprietary agent.
	PublicOnly bool

	// Comb is the durable provenance-gated KM store a completed run attests its
	// certified artifact into — the WRITE side of the flywheel. nil disables
	// attestation (the historical behavior: a run produces a verdict but records
	// no leaf). When set, Run applies the attestation policy on completion
	// (comb.AttestRun): an externally-grounded approval auto-attests; a
	// judgment-only approval is held pending a human co-sign; a rejection records
	// nothing. See attest.go.
	Comb *kmstore.KMStore
	// Verifiers is the operator's attestation roster — the actor refs the
	// DEPLOYMENT trusts to vouch for a write (who counts as a verifier for
	// auto-attestation). It seeds the Comb store's roster before a run's verdict is
	// attested; a run's verifier actor must be on it (here or via the
	// AGIX_KM_VERIFIERS env, which Run also honors) or the leaf lands un-attested.
	// Empty + no env → nothing is a trusted verifier and every leaf stays
	// un-attested (fail-closed).
	Verifiers []string
	// CombBranch is the TOGAF branch attested leaves are written on (default
	// "software", where refactoring records live and distill-export reads).
	CombBranch string
}

// New returns a Runner with born-clean defaults: the mock provider (so a spec runs
// $0/offline with no key and no network) and an empty tool catalog.
func New() *Runner {
	return &Runner{Provider: "mock", Catalog: map[string]tool.Tool{}}
}

// Register adds a tool to the catalog under the logical name a spec declares it by.
// It panics on a nil tool or empty name — a misconfigured catalog is a programming
// error, caught at wiring time, not a per-run degradation.
func (r *Runner) Register(name string, t tool.Tool) {
	if t == nil || strings.TrimSpace(name) == "" {
		panic("fleet: Register needs a non-empty name and a non-nil tool")
	}
	if r.Catalog == nil {
		r.Catalog = map[string]tool.Tool{}
	}
	r.Catalog[name] = t
}

// GrantDecision is one guard-bee boundary decision: whether this agent's role is
// authorized to resolve a declared secret ref, and the source that decided it. It
// carries the ref name, never the value.
type GrantDecision struct {
	Role    string
	Ref     string
	Allowed bool
	Source  string
}

// RunResult is the outcome of running one spec: the governed swarm Result plus the
// contract-level facts a reviewer inspects — the distinct verifier that proves
// actor≠verifier, the tools that could not be resolved, and the guard-bee boundary
// decisions.
type RunResult struct {
	Spec            *agentspec.Spec
	Caste           caste.Caste
	Result          hivekit.Result
	QueenActor      string
	VerifierActor   string
	Tools           []string        // declared tools that resolved to a catalog impl
	UnresolvedTools []string        // declared tools with no catalog impl (an un-ported capability)
	Boundary        []GrantDecision // guard-bee decisions for each declared secret ref
	// Attestation reports what the flywheel write side did with this run's
	// certified artifact (attested / pending co-sign / nothing). Zero value when
	// no Comb store is wired (Runner.Comb == nil).
	Attestation comb.AttestOutcome
}

// Hive maps a validated spec onto a configured hivekit.Hive: the hive is named for
// the agent, tiered per the spec's models, and given every declared tool that
// resolves against the catalog. It returns the built hive and the declared tool
// names that did NOT resolve (an un-ported capability). The hive is queen-led
// regardless of caste — a conductor spec IS the queen, and a proposer spec runs as
// the worker forage under a distinct verifier — so actor≠verifier holds either way.
func (r *Runner) Hive(spec *agentspec.Spec) (*hivekit.Hive, []string, error) {
	resolved, _, unresolved := r.resolveTools(spec)
	provider := r.Provider
	if provider == "" {
		provider = "mock"
	}
	h := hivekit.New().
		Named(spec.Name).
		Provider(provider).
		Queen(spec.Models.Queen).
		Workers(spec.Models.Workers, spec.Models.Worker...).
		Verifier(spec.Models.Verifier)
	if r.Ledger != nil {
		h = h.Ledger(r.Ledger)
	}
	if len(resolved) > 0 {
		h = h.WithTools(resolved...)
	}
	return h, unresolved, nil
}

// Run executes the spec as a governed hive against the given task. It enforces the
// two contract properties hivekit does not know about — the public/proprietary gate
// and the guard-bee secret allowlist — then folds the agent's instructions into the
// task envelope and runs the governed swarm. The returned RunResult carries the
// distinct verifier (actor≠verifier), the boundary decisions, and any unresolved
// tools, alongside the swarm Result.
func (r *Runner) Run(ctx context.Context, spec *agentspec.Spec, task string) (RunResult, error) {
	if spec == nil {
		return RunResult{}, fmt.Errorf("fleet: nil spec")
	}
	if err := spec.Validate(); err != nil {
		return RunResult{}, err
	}
	if r.PublicOnly && !spec.Public {
		return RunResult{Spec: spec}, fmt.Errorf("fleet: %q is proprietary (public=false); this runner is public-only", spec.Name)
	}

	// Guard-bee boundary: authorize each declared secret ref against the effective
	// policy BEFORE any run. This is the agent-authorization layer (whether THIS
	// agent's role may ask for a ref); the provider key resolution itself still
	// flows through the vault seam in core/provider/keyenv.
	boundary := r.checkBoundary(spec)

	h, unresolved, err := r.Hive(spec)
	if err != nil {
		return RunResult{Spec: spec}, err
	}

	_, resolvedNames, _ := r.resolveTools(spec)
	out := RunResult{
		Spec:            spec,
		Caste:           spec.ResolveCaste(),
		QueenActor:      h.QueenActor(),
		VerifierActor:   h.VerifierActor(),
		Tools:           resolvedNames,
		UnresolvedTools: unresolved,
		Boundary:        boundary,
	}

	res, runErr := h.Run(ctx, envelope(spec, task))
	out.Result = res
	if runErr != nil {
		return out, runErr
	}

	// Flywheel WRITE side: attest the run's certified artifact into the Comb under
	// the attestation policy (externally grounded → attest; judgment-only → hold
	// for co-sign; rejected → nothing). This is the seam that was missing — no
	// fleet path ever attested, so the certified corpus stayed empty end to end.
	if r.Comb != nil {
		out.Attestation = r.attest(out)
	}
	return out, nil
}

// checkBoundary authorizes each declared secret ref against the effective policy
// and audits the decision (value-free). With Runner.Policy set, the deployment's
// allowlist is the authority; without it, a self-consistent policy is derived from
// the spec (the spec declares its own least privilege). A denied ref is recorded,
// not fatal — it matches the Node agents' advisory-in-v0.2 posture while giving the
// runtime enforcement seam a real, audited decision to build on.
func (r *Runner) checkBoundary(spec *agentspec.Spec) []GrantDecision {
	pol, source := r.effectivePolicy(spec)
	decisions := make([]GrantDecision, 0, len(spec.Boundary.Secrets))
	for _, s := range spec.Boundary.Secrets {
		ref := secrets.Ref(strings.TrimSpace(s))
		allowed := pol.Allows(spec.Name, ref)
		if r.Audit != nil {
			r.Audit(spec.Name, ref, allowed, source)
		}
		r.logBoundary(spec.Name, string(ref), allowed, source)
		decisions = append(decisions, GrantDecision{Role: spec.Name, Ref: string(ref), Allowed: allowed, Source: source})
	}
	return decisions
}

// effectivePolicy is the single authority a secret decision is checked against:
// the DEPLOYMENT's policy when Runner.Policy is set (so a spec cannot request a
// ref the deployment has not granted its role), else a self-consistent policy
// derived from the spec (the spec is trusted to declare its own least privilege).
// The returned source labels which authority decided, for the audit trail.
func (r *Runner) effectivePolicy(spec *agentspec.Spec) (secrets.Policy, string) {
	if r.Policy != nil {
		return r.Policy, "policy"
	}
	return policyFromSpec(spec), "spec"
}

// resolveTools maps each declared tool name to a live implementation, scoped to
// the agent's guard-bee boundary + the run's RepoRoot, preserving declaration
// order. Resolution order is: the pre-built Catalog first (deployment overrides +
// credentialed tools), then the built-in boundary-scoped filesystem/metric tools.
// A name resolved by neither is returned as unresolved (reported, not fatal). This
// is the seam that turns a manifest's `tools: ["read","grep","glob","write"]` from
// a name into a real, governed capability the worker's tool-use loop can execute.
func (r *Runner) resolveTools(spec *agentspec.Spec) (resolved []tool.Tool, resolvedNames, unresolved []string) {
	ws := r.workspace(spec)
	execCfg := r.execConfig(spec)
	mailCfg := r.mailConfig(spec)
	for _, name := range spec.Tools {
		n := strings.TrimSpace(name)
		if t, ok := r.Catalog[n]; ok {
			resolved = append(resolved, t)
			resolvedNames = append(resolvedNames, n)
			continue
		}
		if t, ok := builtinTool(n, ws); ok {
			resolved = append(resolved, t)
			resolvedNames = append(resolvedNames, n)
			continue
		}
		// The credentialed built-in: a declared exec/shell/run/bash capability becomes
		// the governed exec tool scoped to the agent's allowlist + deny + RepoRoot +
		// any authorized secret grant. Resolved AFTER the catalog + fs/metric so a
		// deployment can still override "exec" with a hardened impl.
		if t, ok := exectool.Tool(n, execCfg); ok {
			resolved = append(resolved, t)
			resolvedNames = append(resolvedNames, n)
			continue
		}
		// The other credentialed built-in: a declared email/notify/send/mail capability
		// becomes the governed email tool, its live transport injected by the deployment
		// (nil → a $0 dry-run recorder) and its credential grant derived from the agent's
		// boundary — never held raw by the agent. Resolved after exec so a deployment can
		// still override "email" with a hardened impl.
		if t, ok := emailtool.Tool(n, mailCfg); ok {
			resolved = append(resolved, t)
			resolvedNames = append(resolvedNames, n)
			continue
		}
		// The read-only audit built-in: a declared ledger/audit capability becomes the
		// read-only ledger tool over the run's audit sink — the born-clean analog of the
		// legacy getLedger().read() seam (the naturalist's "recent development" grounding).
		// Deny-by-default: only when an audit sink is wired (r.Ledger != nil) does it
		// resolve; with no ledger the capability degrades to unresolved (reported, not
		// fatal). Resolved after email so a deployment can still override "ledger".
		if r.Ledger != nil {
			if t, ok := ledgertool.Tool(n, r.Ledger); ok {
				resolved = append(resolved, t)
				resolvedNames = append(resolvedNames, n)
				continue
			}
		}
		unresolved = append(unresolved, n)
	}
	return resolved, resolvedNames, unresolved
}

// execConfig builds the governance envelope the exec tool is constructed with,
// straight from the spec's boundary and the run's RepoRoot: the command allowlist
// (Boundary.Exec), the deny list (Boundary.Deny — its op-style entries are the exec
// denies), the working-dir root, and the guard-bee secret grants.
//
// The grant is deny-by-default and least-privilege: for each Boundary.ExecEnv entry
// (env var → ref) the ref is AUTHORIZED against the effective policy, and ONLY an
// allowed ref becomes a grant. A grant is wired to a Broker (vault + policy + audit)
// so the secret is resolved and scoped into the child at exec time — never held raw
// by the agent. With no Vault, or no authorized grant, the exec tool carries no
// secret and a credentialed command runs unauthenticated.
func (r *Runner) execConfig(spec *agentspec.Spec) exectool.Config {
	pol, _ := r.effectivePolicy(spec)
	grants := make(map[string]secrets.Ref, len(spec.Boundary.ExecEnv))
	for envVar, ref := range spec.Boundary.ExecEnv {
		rf := secrets.Ref(strings.TrimSpace(ref))
		key := strings.TrimSpace(envVar)
		if key == "" || rf == "" {
			continue
		}
		if pol.Allows(spec.Name, rf) {
			grants[key] = rf
		}
	}
	cfg := exectool.Config{
		Root:    r.RepoRoot,
		Allow:   spec.Boundary.Exec,
		Deny:    spec.Boundary.Deny,
		Timeout: r.ExecTimeout,
		Grants:  grants,
	}
	if r.Vault != nil && len(grants) > 0 {
		cfg.Broker = secrets.NewBroker(r.Vault, pol, r.Audit)
	}
	return cfg
}

// mailConfig builds the governance envelope the email tool is constructed with — the
// exact guard-bee shape execConfig builds, one capability over. The live transport is
// the deployment's Mailer (nil → a $0 dry-run recorder). The credential grant is
// deny-by-default + least-privilege: each well-known mail credential ref the agent's
// boundary declares is AUTHORIZED against the effective policy, and only an allowed
// ref becomes a grant wired to a Broker (vault + policy + audit) so the secret is
// resolved and scoped into the send at delivery time — never held raw by the agent.
// With no Vault, or no authorized grant, a credentialed transport degrades to a
// queued (not-sent) state. DefaultTo is derived from the agent's declared "email"
// output surface so a digest to "operator" needs no per-call recipient.
func (r *Runner) mailConfig(spec *agentspec.Spec) emailtool.Config {
	pol, _ := r.effectivePolicy(spec)
	grants := make(map[string]secrets.Ref)
	for _, s := range spec.Boundary.Secrets {
		ref := secrets.Ref(strings.TrimSpace(s))
		key, known := mailCredentialGrants[string(ref)]
		if !known || ref == "" {
			continue
		}
		if pol.Allows(spec.Name, ref) {
			grants[key] = ref
		}
	}
	cfg := emailtool.Config{
		Sender:    r.Mailer,
		DefaultTo: mailDefaultTo(spec),
		Grants:    grants,
	}
	if r.Vault != nil && len(grants) > 0 {
		cfg.Broker = secrets.NewBroker(r.Vault, pol, r.Audit)
	}
	return cfg
}

// mailDefaultTo derives the fallback recipient from the agent's declared email
// output surface (outputs: [{kind: "email", path: "operator"}]), so a manifest that
// says "I email the operator" needs no per-call recipient. Empty when none declared.
func mailDefaultTo(spec *agentspec.Spec) []string {
	for _, o := range spec.Outputs {
		if strings.EqualFold(strings.TrimSpace(o.Kind), "email") {
			if to := strings.TrimSpace(o.Path); to != "" {
				return []string{to}
			}
		}
	}
	return nil
}

// workspace builds the boundary-scoped filesystem capability the built-in tools
// are constructed against: the run's RepoRoot as the confining root, plus the
// agent's declared read/write allow-globs and deny list lifted verbatim from its
// Boundary. The tool IS the capability — nothing an agent holds can escape this.
func (r *Runner) workspace(spec *agentspec.Spec) fs.Workspace {
	return fs.Workspace{
		Root:  r.RepoRoot,
		Read:  spec.Boundary.Read,
		Write: spec.Boundary.Write,
		Deny:  spec.Boundary.Deny,
	}
}

// builtinTool resolves one logical name to a boundary-scoped built-in tool: the
// filesystem catalog (read/glob/grep/walk/list/write) first, then the structural
// metric tool (metric/structural-metric). Unknown names return (nil, false) so the
// caller can try the credentialed exec built-in (see resolveTools) or report them
// unresolved. The exec/shell/run/bash capability is resolved in resolveTools rather
// than here because it needs the richer guard-bee envelope (command allowlist +
// secret grants), which this workspace-only signature does not carry.
func builtinTool(name string, ws fs.Workspace) (tool.Tool, bool) {
	if t, ok := fs.Tool(name, ws); ok {
		return t, true
	}
	if t, ok := metric.Tool(name, ws); ok {
		return t, true
	}
	return nil, false
}

func (r *Runner) logBoundary(role, ref string, allowed bool, source string) {
	if r.Ledger == nil {
		return
	}
	_ = r.Ledger.Append(ledger.Entry{Kind: kindSecretAccess, Agent: role, Data: map[string]any{
		"ref": ref, "allowed": allowed, "source": source,
	}})
}

// policyFromSpec derives a self-consistent allowlist: the agent's role may resolve
// exactly the refs its own boundary declares. It is the fallback when no deployment
// policy is injected.
func policyFromSpec(spec *agentspec.Spec) secrets.Policy {
	refs := make([]secrets.Ref, 0, len(spec.Boundary.Secrets))
	for _, s := range spec.Boundary.Secrets {
		refs = append(refs, secrets.Ref(strings.TrimSpace(s)))
	}
	return secrets.Policy{spec.Name: refs}
}

// envelope folds the agent's declarative instructions into the task the queen
// decomposes. This is a faithful REDUCTION, not the final shape: hivekit/swarm do
// not yet accept a per-agent system prompt, so the instructions ride the task
// envelope rather than the model's system role. Persona injection into the swarm's
// decompose/synthesize/verify prompts is the tracked seam (see the port notes).
func envelope(spec *agentspec.Spec, task string) string {
	instr := strings.TrimSpace(spec.Instructions)
	task = strings.TrimSpace(task)
	if instr == "" {
		return task
	}
	var b strings.Builder
	b.WriteString("You are ")
	if spec.DisplayName != "" {
		b.WriteString(spec.DisplayName)
	} else {
		b.WriteString(spec.Name)
	}
	b.WriteString(", an Agix agent.\n\n[AGENT INSTRUCTIONS]\n")
	b.WriteString(instr)
	b.WriteString("\n\n[TASK]\n")
	b.WriteString(task)
	return b.String()
}
