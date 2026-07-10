package orchestrator

import (
	"context"
	"fmt"
	"sync"
)

// Checkpointer persists a paused run's State so a run can survive the gap
// between interrupt and resume — potentially across processes or days. Save
// returns an opaque id the caller passes to Resume; Load restores the snapshot.
type Checkpointer interface {
	Save(ctx context.Context, s *State) (checkpointID string, err error)
	Load(ctx context.Context, id string) (*State, error)
}

// MemCheckpointer is an in-process Checkpointer — the working default for the
// mem engine and tests. It clones on Save and Load so snapshots are independent
// of the live run. Safe for concurrent use.
//
// seam: a durable Checkpointer (Eino-style StatefulInterrupt, or a
// coord-mcp-backed store) will let a gate pause persist across restarts and let
// a human ratify hours later from another process. Do NOT build it here; this
// in-memory map is the contract's reference implementation.
type MemCheckpointer struct {
	mu    sync.Mutex
	seq   int
	store map[string]*State
}

// NewMemCheckpointer returns an empty in-process checkpointer.
func NewMemCheckpointer() *MemCheckpointer {
	return &MemCheckpointer{store: map[string]*State{}}
}

// Save snapshots s under a fresh id.
func (c *MemCheckpointer) Save(_ context.Context, s *State) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seq++
	id := fmt.Sprintf("ckpt-%04d", c.seq)
	c.store[id] = s.Clone()
	return id, nil
}

// Load restores the snapshot saved under id (a fresh clone each call).
func (c *MemCheckpointer) Load(_ context.Context, id string) (*State, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s, ok := c.store[id]
	if !ok {
		return nil, fmt.Errorf("orchestrator: no checkpoint %q", id)
	}
	return s.Clone(), nil
}

var _ Checkpointer = (*MemCheckpointer)(nil)
