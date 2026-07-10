package orchestrator

import "context"

// RunResult is the outcome of a Run or Resume. When Interrupted is non-nil the
// walk paused at a gate: the run is checkpointed under CheckpointID and Done is
// false — the caller obtains a GateDecision and calls Resume(CheckpointID, …).
// When Done is true the walk reached End. Err carries a graceful-degrade note
// (the run shipped what landed rather than looping).
type RunResult struct {
	State        *State
	Interrupted  *Interrupt
	CheckpointID string
	Done         bool
	Err          string
}

// Runner walks a Graph over a State. The port defines two entry points so any
// substrate (the in-memory MemRunner today, an ADK-Go-backed runner next) is a
// drop-in swap:
//
//   - Run starts a fresh walk; it either completes (Done) or pauses at a gate
//     (Interrupted + CheckpointID).
//   - Resume restarts a paused walk from its checkpoint, applying the verifier's
//     GateDecision at the gate that raised the interrupt.
type Runner interface {
	Run(ctx context.Context, g *Graph, s *State) (RunResult, error)
	Resume(ctx context.Context, checkpointID string, decision GateDecision) (RunResult, error)
}
