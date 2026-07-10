// Package tool is the net-new primitive that lets a bee actually USE tools, not
// just make one model call: a small Tool interface and a Registry a bee carries
// into a tool-use loop (see core/agent). It is a pure, stdlib-only leaf — it
// imports nothing from the rest of core — so the interface stays a clean
// dependency boundary that the agent loop, the swarm, and hivekit all build on
// without an import cycle.
//
// A Tool advertises a JSON-schema input contract and executes deterministically
// from JSON arguments; the Registry is the immutable-after-build set of tools a
// bee is allowed to call, with lookup by name and a deterministic (registration-
// order) listing so the schemas offered to the model never reorder between runs.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package tool

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// Tool is one capability a bee can invoke during a tool-use loop. Implementations
// are the boundary where a model's intent ("call add with a=2,b=3") becomes a
// real side effect or computation. Execute is handed the raw JSON arguments the
// model produced (validated against InputSchema by the implementation, not the
// loop) and returns a string result that is threaded back into the model's next
// turn; an error is fed back to the model as an error result rather than aborting
// the loop (the heals posture), so the model can recover or the max-iterations
// cap can trip.
type Tool interface {
	// Name is the unique identifier the model calls the tool by. It must be
	// non-empty and unique within a Registry.
	Name() string
	// Description tells the model when and how to use the tool.
	Description() string
	// InputSchema is the JSON Schema for the tool's arguments, offered to the
	// model so it produces well-shaped calls. It may be nil (no declared schema).
	InputSchema() json.RawMessage
	// Execute runs the tool against the model-produced JSON arguments and returns
	// its result. An error is threaded back to the model as a tool error, not
	// raised to the caller.
	Execute(ctx context.Context, args json.RawMessage) (string, error)
}

// Grounder is an OPTIONAL capability a Tool may implement to declare that its
// result can constitute EXTERNAL GROUNDING — a deterministic pass an
// actor≠verifier decision may trust (a test suite that passed, an exec exit-0, a
// metric threshold that cleared). Grounds classifies a completed, non-error
// Execute output: it returns true only when that output represents a PASSING
// external oracle. The exec tool implements it (exit code 0); a critic/LLM tool
// does not, so an approval that rests on prose alone stays judgment-only. The
// agent tool-use loop records this per invocation so the swarm can distinguish an
// oracle-backed run from a prose-only one without knowing any tool's format.
type Grounder interface {
	Grounds(result string) bool
}

// Registry is the set of tools a bee carries. Build it once (New / Register) and
// treat it as read-only for the duration of a run: Lookup and List are the hot
// path the tool-use loop calls. List preserves registration order so the tool
// schemas offered to the model are deterministic run to run.
type Registry struct {
	byName map[string]Tool
	order  []string
}

// New builds a Registry from the given tools, failing on an empty or duplicate
// name so a misconfigured tool set is caught at construction rather than mid-loop.
func New(tools ...Tool) (*Registry, error) {
	r := &Registry{byName: make(map[string]Tool, len(tools))}
	for _, t := range tools {
		if err := r.Register(t); err != nil {
			return nil, err
		}
	}
	return r, nil
}

// Register adds one tool, keyed by its Name(). It errors on a nil tool, an empty
// name, or a name already registered — the registry is a namespace and a silent
// collision would let the model call the wrong implementation.
func (r *Registry) Register(t Tool) error {
	if t == nil {
		return fmt.Errorf("tool: cannot register a nil tool")
	}
	name := strings.TrimSpace(t.Name())
	if name == "" {
		return fmt.Errorf("tool: cannot register a tool with an empty name")
	}
	if r.byName == nil {
		r.byName = make(map[string]Tool)
	}
	if _, dup := r.byName[name]; dup {
		return fmt.Errorf("tool: duplicate tool name %q", name)
	}
	r.byName[name] = t
	r.order = append(r.order, name)
	return nil
}

// Lookup returns the tool registered under name, and whether it was found.
func (r *Registry) Lookup(name string) (Tool, bool) {
	t, ok := r.byName[name]
	return t, ok
}

// List returns the tools in registration order (deterministic). The slice is a
// fresh copy, so a caller may not mutate the registry through it.
func (r *Registry) List() []Tool {
	out := make([]Tool, 0, len(r.order))
	for _, name := range r.order {
		out = append(out, r.byName[name])
	}
	return out
}

// Len reports how many tools the registry holds. The tool-use loop uses it to
// decide whether a task has any tools to offer at all.
func (r *Registry) Len() int { return len(r.order) }
