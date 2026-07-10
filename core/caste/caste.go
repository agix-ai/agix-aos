// Package caste is the hive's role→caste taxonomy — the single place that maps
// a bee's ROLE (what it does: forager, verifier, conductor…) to its CASTE (its
// governance rank: queen, worker, drone) and mints its canonical actor
// reference. It is a stdlib-plus-apiary leaf: it reuses apiary.ActorRef so the
// actor-ref wire string can never drift from the cross-hive envelope's notion of
// an actor, and it imports nothing else from core, so both the swarm engine and
// the boundary code can depend on it without an import cycle.
//
// The caste split is the mechanical basis for actor≠verifier: a Queen decomposes
// and synthesizes, Workers forage and verify (a distinct worker grades another's
// work), and only a Drone may cross a hive boundary (RBAC-governed).
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package caste

import (
	"fmt"
	"sync"

	"github.com/agix-ai/agix/core/apiary"
)

// Caste is a bee's governance rank. The set is closed and mirrors apiary's
// validCastes, so an actor minted here always parses back through
// apiary.ParseActorRef.
type Caste string

const (
	// Queen decomposes a task and synthesizes the workers' results.
	Queen Caste = "queen"
	// Worker forages a subtask or verifies another bee's work (actor≠verifier).
	Worker Caste = "worker"
	// Drone is the boundary bee — the only caste permitted to cross a hive
	// boundary, RBAC-governed.
	Drone Caste = "drone"
)

// Actor builds the canonical actor reference for one role instance, reusing
// apiary.ActorRef so the wire string is defined in exactly one place. The
// designation is "<role>-<instance>" (e.g. Actor("agix", Worker, "forager", 1)
// → "agix/worker/forager-1").
func Actor(hive string, c Caste, role string, instance int) string {
	return apiary.ActorRef(hive, string(c), fmt.Sprintf("%s-%d", role, instance))
}

// DefaultCaste maps a role to its governing caste. Conducting/directing roles
// are queens; foraging/verifying/curating roles are workers; boundary-crossing
// roles are drones; an unknown role defaults to Worker (the safe, least-authority
// caste).
func DefaultCaste(role string) Caste {
	switch role {
	case "conductor", "director", "sensei":
		return Queen
	case "verifier", "forager", "curator", "researcher":
		return Worker
	case "pr-bot", "git-orchestrator", "secretary":
		return Drone
	default:
		return Worker
	}
}

// Roster hands out monotonic, per-role instance numbers so a swarm can mint
// unique actor designations (forager-1, forager-2, …) without collisions. The
// zero value is ready to use; it is safe for concurrent use by fan-out
// goroutines.
type Roster struct {
	mu sync.Mutex
	n  map[string]int
}

// Next returns the next 1-based instance number for role, incrementing the
// per-role counter under the lock.
func (r *Roster) Next(role string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.n == nil {
		r.n = map[string]int{}
	}
	r.n[role]++
	return r.n[role]
}
