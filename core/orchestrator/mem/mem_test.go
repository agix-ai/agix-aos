package mem_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/orchestrator"
	"github.com/agix-ai/agix/core/orchestrator/mem"
)

// stubNode marks the State when run and can carry an interrupt or an error.
type stubNode struct {
	name      string
	next      string
	mark      string
	interrupt *orchestrator.Interrupt
	err       error
}

func (s *stubNode) Name() string { return s.name }
func (s *stubNode) Run(_ context.Context, st *orchestrator.State) (orchestrator.NodeResult, error) {
	if s.mark != "" {
		st.Set(s.mark, true)
	}
	return orchestrator.NodeResult{Next: s.next, Interrupt: s.interrupt}, s.err
}

func newLedger(t *testing.T) *ledger.Ledger {
	t.Helper()
	led, err := ledger.Open(filepath.Join(t.TempDir(), "ledger.jsonl"))
	if err != nil {
		t.Fatalf("ledger.Open: %v", err)
	}
	return led
}

// gateGraph builds a → gate ─approve→ approved / ─reject→ rejected, each
// terminal marking State so the taken branch is observable.
func gateGraph() *orchestrator.Graph {
	g := orchestrator.NewGraph()
	g.AddNode(&stubNode{name: "a", mark: "ran.a"})
	g.AddNode(&orchestrator.GateNode{NodeName: "gate", OnApprove: "approved", OnReject: "rejected", RatifyKey: "ran.a"})
	g.AddNode(&stubNode{name: "approved", mark: "ran.approved"})
	g.AddNode(&stubNode{name: "rejected", mark: "ran.rejected"})
	g.AddEdge("a", "gate")
	g.AddEdge("approved", orchestrator.End)
	g.AddEdge("rejected", orchestrator.End)
	g.SetEntry("a")
	return g
}

func TestRunToCompletion(t *testing.T) {
	ctx := context.Background()
	led := newLedger(t)
	g := orchestrator.NewGraph()
	g.AddNode(&stubNode{name: "a", mark: "ran.a"}).AddNode(&stubNode{name: "b", mark: "ran.b"})
	g.AddEdge("a", "b").AddEdge("b", orchestrator.End)
	g.SetEntry("a")

	r := mem.New(mem.Options{Ledger: led})
	res, err := r.Run(ctx, g, orchestrator.NewState())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.Done {
		t.Error("expected Done for a gate-free graph")
	}
	if res.Interrupted != nil {
		t.Error("did not expect an interrupt")
	}
	if _, ok := res.State.Get("ran.a"); !ok {
		t.Error("node a should have run")
	}
	if _, ok := res.State.Get("ran.b"); !ok {
		t.Error("node b should have run")
	}
	assertCount(t, led, ledger.KindNodeStart, 2)
	assertCount(t, led, ledger.KindNodeDone, 2)
}

func TestInterruptAtGate(t *testing.T) {
	ctx := context.Background()
	led := newLedger(t)
	r := mem.New(mem.Options{Ledger: led})

	res, err := r.Run(ctx, gateGraph(), orchestrator.NewState())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Done {
		t.Error("run should PAUSE at the gate, not complete")
	}
	if res.Interrupted == nil {
		t.Fatal("expected an interrupt at the gate")
	}
	if res.Interrupted.Kind != "ratify" || res.Interrupted.NodeName != "gate" {
		t.Errorf("interrupt = %+v, want kind=ratify node=gate", res.Interrupted)
	}
	if res.CheckpointID == "" {
		t.Error("a paused run must carry a checkpoint id")
	}
	if _, ok := res.State.Get("ran.approved"); ok {
		t.Error("no terminal should run before ratification")
	}
	assertCount(t, led, ledger.KindGatePause, 1)
}

func TestResumeApprove(t *testing.T) {
	ctx := context.Background()
	led := newLedger(t)
	r := mem.New(mem.Options{Ledger: led})

	paused, err := r.Run(ctx, gateGraph(), orchestrator.NewState())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	done, err := r.Resume(ctx, paused.CheckpointID, orchestrator.GateDecision{Approved: true, By: "curator-1"})
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if !done.Done {
		t.Error("resume(approve) should complete the run")
	}
	if _, ok := done.State.Get("ran.approved"); !ok {
		t.Error("approve should route to the approved terminal")
	}
	if _, ok := done.State.Get("ran.rejected"); ok {
		t.Error("approve must NOT run the rejected terminal")
	}
	assertRatifyVerdict(t, led, true)
}

func TestResumeReject(t *testing.T) {
	ctx := context.Background()
	led := newLedger(t)
	r := mem.New(mem.Options{Ledger: led})

	paused, err := r.Run(ctx, gateGraph(), orchestrator.NewState())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	done, err := r.Resume(ctx, paused.CheckpointID, orchestrator.GateDecision{Approved: false, By: "curator-1"})
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if !done.Done {
		t.Error("resume(reject) should complete the run")
	}
	if _, ok := done.State.Get("ran.rejected"); !ok {
		t.Error("reject should route to the rejected terminal")
	}
	if _, ok := done.State.Get("ran.approved"); ok {
		t.Error("reject must NOT run the approved terminal")
	}
	assertRatifyVerdict(t, led, false)
}

func TestResumeUnknownCheckpoint(t *testing.T) {
	r := mem.New(mem.Options{})
	if _, err := r.Resume(context.Background(), "ckpt-nope", orchestrator.GateDecision{Approved: true}); err == nil {
		t.Error("Resume of an unknown checkpoint should error")
	}
}

func TestGracefulDegradeOnNodeError(t *testing.T) {
	ctx := context.Background()
	led := newLedger(t)
	boom := errors.New("boom: synthetic node failure")
	g := orchestrator.NewGraph()
	g.AddNode(&stubNode{name: "a", err: boom})
	g.AddEdge("a", orchestrator.End)
	g.SetEntry("a")

	r := mem.New(mem.Options{Ledger: led})
	res, err := r.Run(ctx, g, orchestrator.NewState())
	if err == nil {
		t.Fatal("expected the node error to surface")
	}
	if res.Err == "" {
		t.Error("RunResult.Err should carry the failure note")
	}
	if res.Done {
		t.Error("a degraded run is not Done")
	}
	// The node_done audit records the failure (heals posture: ship what landed).
	entries, _ := led.Read(ledger.KindNodeDone, time.Time{})
	if len(entries) != 1 {
		t.Fatalf("want 1 node_done entry, got %d", len(entries))
	}
	if ok, _ := entries[0].Data["ok"].(bool); ok {
		t.Error("node_done should record ok=false on failure")
	}
}

func assertCount(t *testing.T, led *ledger.Ledger, kind string, want int) {
	t.Helper()
	got, err := led.Read(kind, time.Time{})
	if err != nil {
		t.Fatalf("Read(%q): %v", kind, err)
	}
	if len(got) != want {
		t.Errorf("kind %q: got %d entries, want %d", kind, len(got), want)
	}
}

func assertRatifyVerdict(t *testing.T, led *ledger.Ledger, wantApproved bool) {
	t.Helper()
	got, err := led.Read(ledger.KindRatify, time.Time{})
	if err != nil {
		t.Fatalf("Read(ratify): %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want exactly 1 ratify entry, got %d", len(got))
	}
	approved, _ := got[0].Data["approved"].(bool)
	if approved != wantApproved {
		t.Errorf("ratify verdict = %v, want %v", approved, wantApproved)
	}
}
