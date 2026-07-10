// The Broker is the least-privilege gate. A bee never resolves a secret
// directly; it asks the Broker for a ref under a role, and the Broker consults a
// policy allowlist before it will touch the Vault. Every decision is audited by
// ref + decision + source — never by value.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package secrets

import (
	"context"
	"fmt"
)

// Policy is the allowlist: a role maps to the exact set of refs it may access. A
// role absent from the map, or a ref absent from its list, is denied. This is
// deny-by-default — the safe direction for a security boundary.
type Policy map[string][]Ref

// Allows reports whether role may access ref under this policy.
func (p Policy) Allows(role string, ref Ref) bool {
	for _, allowed := range p[role] {
		if allowed == ref {
			return true
		}
	}
	return false
}

// AuditFunc receives one secret_access record per authorization decision. It is
// injected so the guard bee can wire it to the append-only ledger later. It is
// handed the ref, the decision, and the backend source — NEVER the secret value.
type AuditFunc func(role string, ref Ref, allowed bool, source string)

// subprocessRole labels secret_access records emitted by WithSecretEnv, which
// injects already-granted secrets into a scoped child process (it has no role of
// its own to policy-check — see the field comment on WithSecretEnv).
const subprocessRole = "subprocess-env"

// Broker gates access to the Vault behind a Policy and records every decision.
type Broker struct {
	// Vault resolves granted refs. Real wiring passes a *Vault; tests pass a fake
	// SourcedResolver so no keychain/gcloud call is made.
	Vault SourcedResolver
	// Policy is the role→refs allowlist (deny by default).
	Policy Policy
	// Audit, when non-nil, receives one record per decision.
	Audit AuditFunc
}

// NewBroker wires a Broker. Any argument may be zero: a nil Policy denies
// everything, a nil Audit drops records.
func NewBroker(vault SourcedResolver, policy Policy, audit AuditFunc) *Broker {
	return &Broker{Vault: vault, Policy: policy, Audit: audit}
}

// Grant is the just-in-time gate. It consults the policy allowlist; if role is
// not permitted ref it audits the denial and returns ErrDenied WITHOUT touching
// the Vault. Otherwise it audits the authorization and resolves the value via
// the Vault. The audited `allowed` flag reflects the POLICY decision — a
// permitted ref whose lookup then fails is still audited allowed=true (the
// authorization was granted; the store simply had no value).
func (b *Broker) Grant(ctx context.Context, role string, ref Ref) (string, error) {
	source := b.source()
	if !b.Policy.Allows(role, ref) {
		b.emit(role, ref, false, source)
		return "", fmt.Errorf("%w: role %q may not access %q", ErrDenied, role, ref)
	}
	b.emit(role, ref, true, source)
	val, err := b.Vault.Resolve(ctx, ref)
	if err != nil {
		return "", err
	}
	return val, nil
}

// WithSecretEnv resolves the granted secrets and calls fn with a MINIMAL env
// slice holding ONLY those KEY=value pairs — for injecting into a scoped
// subprocess. It never mutates or exposes the parent process environment, and
// writes nothing to disk. Local secret byte copies are zeroed on return
// (best-effort: Go strings are immutable, so the string form fn observed cannot
// be wiped — the intermediate buffers and the slice references are).
//
// Note (least-privilege): the signature carries no role, so WithSecretEnv does
// NOT re-check the policy allowlist — it trusts that grants were already
// authorized (e.g. via Grant). Callers must not build grants from unvetted
// input. It still audits every secret it touches under the subprocess-env role.
func (b *Broker) WithSecretEnv(ctx context.Context, grants map[string]Ref, fn func(env []string) error) error {
	source := b.source()
	env := make([]string, 0, len(grants))
	raw := make([][]byte, 0, len(grants))

	// Zero intermediate buffers and drop slice references no matter how we exit.
	defer func() {
		zeroAll(raw)
		for i := range env {
			env[i] = ""
		}
	}()

	for key, ref := range grants {
		val, err := b.Vault.Resolve(ctx, ref)
		if err != nil {
			return fmt.Errorf("secrets: resolve %q for %q: %w", ref, key, err)
		}
		b.emit(subprocessRole, ref, true, source)
		buf := []byte(val)
		raw = append(raw, buf)
		env = append(env, key+"="+val)
	}
	return fn(env)
}

// source names the backend for audit, tolerating a nil Vault.
func (b *Broker) source() string {
	if b.Vault == nil {
		return "none"
	}
	return b.Vault.Source()
}

// emit forwards one audit record if an AuditFunc is wired.
func (b *Broker) emit(role string, ref Ref, allowed bool, source string) {
	if b.Audit != nil {
		b.Audit(role, ref, allowed, source)
	}
}

// zeroAll overwrites every byte of every buffer — best-effort secret hygiene.
func zeroAll(bufs [][]byte) {
	for _, buf := range bufs {
		for i := range buf {
			buf[i] = 0
		}
	}
}
