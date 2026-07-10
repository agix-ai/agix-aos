// Package adk is the ADK-Go-backed substrate behind the Agix orchestrator port.
// It implements the SAME orchestrator.Runner + orchestrator.Checkpointer
// interfaces as the in-memory engine, so swapping the substrate is a one-line
// change that never touches node or agent code — the whole point of the port.
//
// This lives in its OWN Go module (see go.mod) so ADK-Go's large Google-Cloud
// dependency tree never pollutes the born-clean, zero-dependency core module.
// Nested modules are excluded from `core`'s ./... , so the core build/vet/test
// stay stdlib-only and green regardless of what happens here.
//
// # How far this binding got (honest status)
//
//   - FUNCTIONAL: Checkpointer maps orchestrator.State onto ADK's real
//     session.Service (session.InMemoryService()) — Save creates an ADK session
//     holding the serialized state; Load reads it back. This compiles and runs
//     with zero network and zero credentials (in-memory session store), and is
//     covered by adk_test.go. It proves the "Agix Checkpointer → ADK session /
//     state" half of the mapping concretely.
//   - WIRED, NOT YET EXECUTING: Runner constructs the real ADK plumbing —
//     agent.New (a custom agent, so no model.Model / no Gemini creds needed) and
//     runner.New — with the session service above. Construction does NO network
//     call. Driving the Agix graph walk THROUGH runner.Run (emitting one
//     session.Event per node, and mapping a GateNode Interrupt onto ADK's
//     long-running function-call HITL so Resume feeds a function-response) is the
//     remaining work, marked `// TODO(adk):` below. Run/Resume return
//     ErrExecIncomplete until that lands. See ADK-INTEGRATION-NOTES.md.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package adk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"sync"

	"github.com/agix-ai/agix/core/orchestrator"

	adkagent "google.golang.org/adk/agent"
	adkrunner "google.golang.org/adk/runner"
	adksession "google.golang.org/adk/session"
)

const (
	appName      = "agix"
	userID       = "agix-runner"
	stateBlobKey = "agix.state" // reserved ADK-session state key holding the JSON blob
)

// ErrExecIncomplete is returned by Runner.Run/Resume: the ADK session/state
// binding is functional (see Checkpointer), but walking the Agix graph through
// ADK's runner/agent event stream is not wired yet. Use the mem engine as the
// default; this is the reversible substrate seam under construction.
var ErrExecIncomplete = errors.New("adk: graph execution over ADK runner not wired yet (session/state binding IS functional — see Checkpointer + ADK-INTEGRATION-NOTES.md; TODO(adk))")

// ─── Checkpointer: FUNCTIONAL binding onto ADK session/state ─────────────────

// Checkpointer implements orchestrator.Checkpointer backed by a real ADK
// session.Service. Each checkpoint is an ADK session whose state carries the
// serialized orchestrator.State. Safe for concurrent use.
//
// This is the concrete "Agix Checkpointer → ADK session/state" mapping: it uses
// ADK types and a real ADK service, yet needs no network or credentials because
// session.InMemoryService() is local. A durable ADK backend (Vertex AI /
// database session service) is a drop-in for the service field.
type Checkpointer struct {
	svc adksession.Service

	mu  sync.Mutex
	seq int
}

// NewCheckpointer returns a Checkpointer over ADK's in-memory session service.
func NewCheckpointer() *Checkpointer {
	return &Checkpointer{svc: adksession.InMemoryService()}
}

// Save serializes s into a fresh ADK session and returns the session id as the
// checkpoint id.
func (c *Checkpointer) Save(ctx context.Context, s *orchestrator.State) (string, error) {
	blob, err := json.Marshal(s)
	if err != nil {
		return "", fmt.Errorf("adk: marshal state: %w", err)
	}
	c.mu.Lock()
	c.seq++
	id := fmt.Sprintf("adk-ckpt-%04d", c.seq)
	c.mu.Unlock()

	if _, err := c.svc.Create(ctx, &adksession.CreateRequest{
		AppName:   appName,
		UserID:    userID,
		SessionID: id,
		State:     map[string]any{stateBlobKey: string(blob)},
	}); err != nil {
		return "", fmt.Errorf("adk: create session %q: %w", id, err)
	}
	return id, nil
}

// Load reads the ADK session under id and deserializes its state.
func (c *Checkpointer) Load(ctx context.Context, id string) (*orchestrator.State, error) {
	resp, err := c.svc.Get(ctx, &adksession.GetRequest{
		AppName:   appName,
		UserID:    userID,
		SessionID: id,
	})
	if err != nil {
		return nil, fmt.Errorf("adk: get session %q: %w", id, err)
	}
	if resp == nil || resp.Session == nil {
		return nil, fmt.Errorf("adk: no session %q", id)
	}
	v, err := resp.Session.State().Get(stateBlobKey)
	if err != nil {
		return nil, fmt.Errorf("adk: read state %q: %w", id, err)
	}
	blob, ok := v.(string)
	if !ok {
		return nil, fmt.Errorf("adk: state blob for %q is %T, want string", id, v)
	}
	var s orchestrator.State
	if err := json.Unmarshal([]byte(blob), &s); err != nil {
		return nil, fmt.Errorf("adk: unmarshal state %q: %w", id, err)
	}
	if s.Data == nil {
		s.Data = map[string]any{}
	}
	return &s, nil
}

var _ orchestrator.Checkpointer = (*Checkpointer)(nil)

// ─── Runner: real ADK plumbing wired; graph execution TODO ───────────────────

// Runner implements orchestrator.Runner over ADK-Go. It constructs the real ADK
// runner + a custom ADK agent (no model.Model, so no Gemini credentials) backed
// by the functional session/state Checkpointer above. Construction performs NO
// network call. Graph execution over the ADK event stream is the remaining work.
type Runner struct {
	cp  *Checkpointer
	adk *adkrunner.Runner

	mu      sync.Mutex
	pending map[string]pendingRun // checkpointID -> paused run
}

type pendingRun struct {
	graph     *orchestrator.Graph
	interrupt *orchestrator.Interrupt
}

// NewRunner builds the ADK-backed runner. It wires session.Service, a custom
// agent.New agent, and runner.New — all locally, no network, no credentials.
func NewRunner() (*Runner, error) {
	cp := NewCheckpointer()

	// A CUSTOM ADK agent (agent.New with a Run func) avoids needing a model.Model,
	// so no Gemini/GOOGLE credentials are required to construct the runner. The
	// Run body is the graph-walk-to-events mapping — TODO(adk) below.
	ag, err := adkagent.New(adkagent.Config{
		Name:        "agix-graph",
		Description: "Agix orchestrator graph executed as an ADK agent",
		Run:         graphAgentRun,
	})
	if err != nil {
		return nil, fmt.Errorf("adk: build agent: %w", err)
	}

	ar, err := adkrunner.New(adkrunner.Config{
		AppName:           appName,
		Agent:             ag,
		SessionService:    cp.svc,
		AutoCreateSession: true,
	})
	if err != nil {
		return nil, fmt.Errorf("adk: build runner: %w", err)
	}

	return &Runner{cp: cp, adk: ar, pending: map[string]pendingRun{}}, nil
}

// graphAgentRun is the ADK agent body. TODO(adk): walk the Agix graph from
// InvocationContext (graph + State recovered from session state), yielding one
// session.Event per node, and raising an ADK long-running function-call event at
// a GateNode so the run pauses for a human/verifier function-response (ADK's
// interrupt/resume HITL primitive — mirrors orchestrator.GateNode).
func graphAgentRun(_ adkagent.InvocationContext) iter.Seq2[*adksession.Event, error] {
	return func(yield func(*adksession.Event, error) bool) {
		// TODO(adk): emit node_start/node_done events + the gate function-call
		// event here. Left empty (no events) until the mapping lands.
	}
}

// Run maps orchestrator.Runner.Run onto ADK. TODO(adk): drive the walk through
// r.adk.Run(ctx, userID, sessionID, msg, cfg) and translate ADK events + a
// long-running function-call pause back into a RunResult. Until then it reports
// ErrExecIncomplete without any network call.
func (r *Runner) Run(_ context.Context, _ *orchestrator.Graph, s *orchestrator.State) (orchestrator.RunResult, error) {
	return orchestrator.RunResult{State: s, Err: ErrExecIncomplete.Error()}, ErrExecIncomplete
}

// Resume maps orchestrator.Runner.Resume onto ADK. TODO(adk): reload the ADK
// session, append the decision as a function-response event, and re-invoke the
// runner to continue past the gate.
func (r *Runner) Resume(_ context.Context, _ string, _ orchestrator.GateDecision) (orchestrator.RunResult, error) {
	return orchestrator.RunResult{Err: ErrExecIncomplete.Error()}, ErrExecIncomplete
}

var _ orchestrator.Runner = (*Runner)(nil)
