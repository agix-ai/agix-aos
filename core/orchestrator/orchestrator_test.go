package orchestrator_test

import (
	"context"
	"testing"

	"github.com/agix-ai/agix/core/orchestrator"
	"github.com/agix-ai/agix/core/router"
)

// stubNode is a minimal Node for topology + runner tests.
type stubNode struct {
	name string
	next string
}

func (s stubNode) Name() string { return s.name }
func (s stubNode) Run(context.Context, *orchestrator.State) (orchestrator.NodeResult, error) {
	return orchestrator.NodeResult{Next: s.next}, nil
}

func TestGraphValidateOK(t *testing.T) {
	g := orchestrator.NewGraph()
	g.AddNode(stubNode{name: "a"}).AddNode(stubNode{name: "b"})
	g.AddEdge("a", "b").AddEdge("b", orchestrator.End)
	g.SetEntry("a")
	if err := g.Validate(); err != nil {
		t.Fatalf("Validate: unexpected error: %v", err)
	}
}

func TestGraphValidateDanglingEdge(t *testing.T) {
	g := orchestrator.NewGraph()
	g.AddNode(stubNode{name: "a"})
	g.AddEdge("a", "nowhere") // points to a node that was never added
	g.SetEntry("a")
	if err := g.Validate(); err == nil {
		t.Fatal("Validate should reject an edge to an unregistered node")
	}
}

func TestGraphValidateNoEntry(t *testing.T) {
	g := orchestrator.NewGraph()
	g.AddNode(stubNode{name: "a"})
	if err := g.Validate(); err == nil {
		t.Fatal("Validate should reject a graph with no entry")
	}
}

func TestGraphValidateUnknownEntry(t *testing.T) {
	g := orchestrator.NewGraph()
	g.AddNode(stubNode{name: "a"}).SetEntry("ghost")
	if err := g.Validate(); err == nil {
		t.Fatal("Validate should reject an entry that is not registered")
	}
}

func TestGraphValidateGateTargetUnknown(t *testing.T) {
	g := orchestrator.NewGraph()
	g.AddNode(stubNode{name: "a"})
	g.AddNode(&orchestrator.GateNode{NodeName: "gate", OnApprove: "missing", OnReject: "a", RatifyKey: "x"})
	g.AddEdge("a", "gate")
	g.SetEntry("a")
	if err := g.Validate(); err == nil {
		t.Fatal("Validate should reject a gate routing to an unregistered node")
	}
}

func TestGraphNextPrecedence(t *testing.T) {
	g := orchestrator.NewGraph()
	g.AddNode(stubNode{name: "a"}).AddNode(stubNode{name: "static"}).AddNode(stubNode{name: "cond"})
	g.AddEdge("a", "static")
	g.AddConditionalEdge("a", func(*orchestrator.State) string { return "cond" })
	s := orchestrator.NewState()

	// explicit result target beats everything
	if got := g.Next("a", "explicit", s); got != "explicit" {
		t.Errorf("explicit precedence: got %q, want explicit", got)
	}
	// conditional beats static
	if got := g.Next("a", "", s); got != "cond" {
		t.Errorf("conditional precedence: got %q, want cond", got)
	}
	// no edge at all -> End
	if got := g.Next("orphan", "", s); got != orchestrator.End {
		t.Errorf("no-edge: got %q, want End", got)
	}
}

func TestMemCheckpointerRoundTrip(t *testing.T) {
	ctx := context.Background()
	cp := orchestrator.NewMemCheckpointer()

	s := orchestrator.NewState()
	s.Set("k", "v1")
	s.Append(router.Message{Role: "user", Content: "hello"})

	id, err := cp.Save(ctx, s)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if id == "" {
		t.Fatal("Save returned an empty checkpoint id")
	}

	// Mutate the live state AFTER the checkpoint — the snapshot must not move.
	s.Set("k", "v2")
	s.Append(router.Message{Role: "assistant", Content: "later"})

	loaded, err := cp.Load(ctx, id)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := loaded.GetString("k"); got != "v1" {
		t.Errorf("checkpoint isolation: k = %q, want v1 (live mutation leaked in)", got)
	}
	if len(loaded.Transcript) != 1 {
		t.Errorf("checkpoint isolation: transcript len = %d, want 1", len(loaded.Transcript))
	}

	if _, err := cp.Load(ctx, "ckpt-nope"); err == nil {
		t.Error("Load of an unknown checkpoint should error")
	}
}

func TestStateCloneIndependence(t *testing.T) {
	s := orchestrator.NewState()
	s.Set("k", "v1")
	clone := s.Clone()
	clone.Set("k", "v2")
	if s.GetString("k") != "v1" {
		t.Error("Clone should not share Data with the original")
	}
}
