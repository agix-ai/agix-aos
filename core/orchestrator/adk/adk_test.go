package adk_test

import (
	"context"
	"errors"
	"testing"

	"github.com/agix-ai/agix/core/orchestrator"
	"github.com/agix-ai/agix/core/orchestrator/adk"
	"github.com/agix-ai/agix/core/router"
)

// TestCheckpointerRoundTrip exercises the FUNCTIONAL half of the ADK binding:
// orchestrator.State persisted to and restored from a real ADK session.Service
// (in-memory — zero network, zero credentials).
func TestCheckpointerRoundTrip(t *testing.T) {
	ctx := context.Background()
	cp := adk.NewCheckpointer()

	s := orchestrator.NewState()
	s.Set("task", "ship a login page")
	s.Set("forage.output", "draft")
	s.Append(router.Message{Role: "user", Content: "ship a login page"})

	id, err := cp.Save(ctx, s)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if id == "" {
		t.Fatal("Save returned an empty checkpoint id")
	}

	loaded, err := cp.Load(ctx, id)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := loaded.GetString("task"); got != "ship a login page" {
		t.Errorf("task = %q, want 'ship a login page'", got)
	}
	if got := loaded.GetString("forage.output"); got != "draft" {
		t.Errorf("forage.output = %q, want draft", got)
	}
	if len(loaded.Transcript) != 1 || loaded.Transcript[0].Content != "ship a login page" {
		t.Errorf("transcript not round-tripped: %+v", loaded.Transcript)
	}
}

func TestCheckpointerLoadUnknown(t *testing.T) {
	if _, err := adk.NewCheckpointer().Load(context.Background(), "adk-ckpt-nope"); err == nil {
		t.Error("Load of an unknown session should error")
	}
}

// TestRunnerConstructsWithoutNetwork proves NewRunner wires the real ADK
// runner/agent/session plumbing with NO network call and NO credentials — the
// guard the flight requires. Graph execution over ADK is not wired yet, so
// Run/Resume report ErrExecIncomplete (honest partial).
func TestRunnerConstructsWithoutNetwork(t *testing.T) {
	r, err := adk.NewRunner()
	if err != nil {
		t.Fatalf("NewRunner should construct locally without network/creds: %v", err)
	}

	_, err = r.Run(context.Background(), orchestrator.NewGraph(), orchestrator.NewState())
	if !errors.Is(err, adk.ErrExecIncomplete) {
		t.Errorf("Run err = %v, want ErrExecIncomplete", err)
	}
	_, err = r.Resume(context.Background(), "adk-ckpt-0001", orchestrator.GateDecision{Approved: true})
	if !errors.Is(err, adk.ErrExecIncomplete) {
		t.Errorf("Resume err = %v, want ErrExecIncomplete", err)
	}
}

// Compile-time proof the ADK binding satisfies the port interfaces.
var (
	_ orchestrator.Checkpointer = (*adk.Checkpointer)(nil)
	_ orchestrator.Runner       = (*adk.Runner)(nil)
)
