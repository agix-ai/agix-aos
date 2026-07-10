// Package mem is the working default graph engine — an in-memory Runner that
// walks an orchestrator.Graph, brackets every node with node_start/node_done
// audit entries, and implements the interrupt/resume governance loop with a
// Checkpointer. Deterministic and zero-cost under the mock provider, so the
// whole substrate is testable with no network and no API key.
//
// It graceful-degrades like the rest of the hive: on a node error it ships what
// landed with an error note and stops — never a retry loop.
//
// seam: this is the reference substrate behind the orchestrator port. An
// ADK-Go-backed runner (orchestrator/adk) implements the SAME orchestrator.Runner
// interface, so swapping the engine never touches node or agent code.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package mem

import (
	"context"
	"fmt"

	"github.com/agix-ai/agix/core/ledger"
	"github.com/agix-ai/agix/core/orchestrator"
)

// MemRunner is an in-process orchestrator.Runner. Construct with New. A single
// MemRunner tracks its paused runs by checkpoint id, so one runner can carry
// multiple graphs' interrupts concurrently.
type MemRunner struct {
	checkpointer orchestrator.Checkpointer
	ledger       *ledger.Ledger
	pending      map[string]pendingRun
}

type pendingRun struct {
	graph     *orchestrator.Graph
	interrupt *orchestrator.Interrupt
}

// Options configures a MemRunner. A nil Checkpointer defaults to a fresh
// in-process MemCheckpointer; a nil Ledger disables audit.
type Options struct {
	Checkpointer orchestrator.Checkpointer
	Ledger       *ledger.Ledger
}

// New returns a MemRunner.
func New(opts Options) *MemRunner {
	cp := opts.Checkpointer
	if cp == nil {
		cp = orchestrator.NewMemCheckpointer()
	}
	return &MemRunner{
		checkpointer: cp,
		ledger:       opts.Ledger,
		pending:      map[string]pendingRun{},
	}
}

// Run walks g from its entry over s. It returns when the walk completes (Done)
// or a gate raises an Interrupt (checkpointed under CheckpointID, Done false).
func (m *MemRunner) Run(ctx context.Context, g *orchestrator.Graph, s *orchestrator.State) (orchestrator.RunResult, error) {
	if err := g.Validate(); err != nil {
		return orchestrator.RunResult{State: s}, err
	}
	if s == nil {
		s = orchestrator.NewState()
	}
	return m.walk(ctx, g, s, g.Entry())
}

// Resume restarts the run paused under checkpointID, applying decision at the
// gate that raised the interrupt. It loads the checkpointed State, records the
// ratify verdict, resolves the gate to its next node, and continues to
// completion (or the next interrupt).
func (m *MemRunner) Resume(ctx context.Context, checkpointID string, decision orchestrator.GateDecision) (orchestrator.RunResult, error) {
	p, ok := m.pending[checkpointID]
	if !ok {
		return orchestrator.RunResult{}, fmt.Errorf("mem: no paused run for checkpoint %q", checkpointID)
	}
	s, err := m.checkpointer.Load(ctx, checkpointID)
	if err != nil {
		return orchestrator.RunResult{}, fmt.Errorf("mem: load checkpoint %q: %w", checkpointID, err)
	}

	node, ok := p.graph.Lookup(p.interrupt.NodeName)
	if !ok {
		return orchestrator.RunResult{State: s}, fmt.Errorf("mem: interrupted node %q not in graph", p.interrupt.NodeName)
	}
	gate, ok := node.(orchestrator.Gate)
	if !ok {
		return orchestrator.RunResult{State: s}, fmt.Errorf("mem: node %q is not a Gate; cannot resume with a decision", p.interrupt.NodeName)
	}

	m.log(ledger.Entry{Kind: ledger.KindRatify, Agent: decisionBy(decision), Data: map[string]any{
		"gate":      p.interrupt.NodeName,
		"approved":  decision.Approved,
		"by":        decision.By,
		"notes":     decision.Notes,
		"grounding": decision.Grounding,
	}})

	next, err := gate.Resolve(s, decision)
	if err != nil {
		return orchestrator.RunResult{State: s}, fmt.Errorf("mem: gate %q resolve: %w", p.interrupt.NodeName, err)
	}

	delete(m.pending, checkpointID)
	return m.walk(ctx, p.graph, s, next)
}

// walk runs nodes from current until End, an interrupt, or an error.
func (m *MemRunner) walk(ctx context.Context, g *orchestrator.Graph, s *orchestrator.State, current string) (orchestrator.RunResult, error) {
	for current != orchestrator.End {
		node, ok := g.Lookup(current)
		if !ok {
			return orchestrator.RunResult{State: s}, fmt.Errorf("mem: no node %q", current)
		}

		m.log(ledger.Entry{Kind: ledger.KindNodeStart, Agent: current, Data: map[string]any{"node": current}})

		res, err := node.Run(ctx, s)
		if err != nil {
			// heals posture: ship what landed with an error note, do not loop.
			m.log(ledger.Entry{Kind: ledger.KindNodeDone, Agent: current,
				Data: map[string]any{"node": current, "ok": false, "error": err.Error()}})
			return orchestrator.RunResult{State: s, Err: err.Error()}, err
		}

		if res.Interrupt != nil {
			id, saveErr := m.checkpointer.Save(ctx, s)
			if saveErr != nil {
				return orchestrator.RunResult{State: s}, fmt.Errorf("mem: checkpoint at gate %q: %w", current, saveErr)
			}
			m.pending[id] = pendingRun{graph: g, interrupt: res.Interrupt}
			m.log(ledger.Entry{Kind: ledger.KindGatePause, Agent: current, Data: map[string]any{
				"node":       current,
				"kind":       res.Interrupt.Kind,
				"checkpoint": id,
				"payload":    res.Interrupt.Payload,
			}})
			return orchestrator.RunResult{State: s, Interrupted: res.Interrupt, CheckpointID: id}, nil
		}

		m.log(ledger.Entry{Kind: ledger.KindNodeDone, Agent: current,
			Data: map[string]any{"node": current, "ok": true}})

		current = g.Next(current, res.Next, s)
	}
	return orchestrator.RunResult{State: s, Done: true}, nil
}

func (m *MemRunner) log(e ledger.Entry) {
	if m.ledger == nil {
		return
	}
	_ = m.ledger.Append(e)
}

func decisionBy(d orchestrator.GateDecision) string {
	if d.By != "" {
		return d.By
	}
	return "verifier"
}

var _ orchestrator.Runner = (*MemRunner)(nil)
