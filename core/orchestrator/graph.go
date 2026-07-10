package orchestrator

import (
	"context"
	"errors"
	"fmt"
	"sort"
)

// End is the sentinel target that terminates a walk. An edge to End (or a node
// with no outgoing edge) ends the run.
const End = "END"

// NodeResult is what a Node returns. Next names the node to run next ("" = take
// the graph's default/conditional edge). A non-nil Interrupt PAUSES the run for
// human-in-the-loop ratification; the runner checkpoints State and returns.
type NodeResult struct {
	Next      string
	Interrupt *Interrupt
}

// Node is one unit of work in the graph. Run reads and mutates the shared State
// and reports where to go next (or that it must interrupt). Implementations must
// be deterministic under the mock provider so tests stay zero-network.
type Node interface {
	Name() string
	Run(ctx context.Context, s *State) (NodeResult, error)
}

// Interrupt describes a paused run awaiting a decision. Kind is the interrupt
// class (e.g. "ratify"); NodeName is the gate that raised it; Payload carries
// what the verifier needs to decide (e.g. the actor's output under review).
type Interrupt struct {
	ID       string         `json:"id"`
	Kind     string         `json:"kind"`
	NodeName string         `json:"nodeName"`
	Payload  map[string]any `json:"payload,omitempty"`
}

// GateDecision is the verifier's verdict, applied on Resume. By names the
// ratifying bee/human — the actor≠verifier record. Grounding records whether the
// approval was backed by an external oracle ("external") or is LLM-judgment-only
// ("judgment"); it rides into the ratify ledger frame so the audit trail — and
// any downstream attestation — can tell a deterministically-verified verdict
// from a prose one. Empty means unspecified (treated as judgment downstream).
type GateDecision struct {
	Approved  bool   `json:"approved"`
	Notes     string `json:"notes,omitempty"`
	By        string `json:"by,omitempty"`
	Grounding string `json:"grounding,omitempty"`
}

// Gate is a Node that pauses for ratification and, on resume, resolves a
// GateDecision to the next node. The runner type-asserts the interrupted node
// to Gate to route the verdict.
type Gate interface {
	Node
	Resolve(s *State, d GateDecision) (next string, err error)
}

// targetLister is implemented by nodes that route to named targets outside the
// static edge map (a Gate's OnApprove/OnReject). Validate checks these too.
type targetLister interface {
	Targets() []string
}

// Graph is a builder + resolved topology of Nodes. The zero value is not
// usable; call NewGraph. All Add* methods return the graph for chaining.
type Graph struct {
	entry string
	order []string // node insertion order (stable validation/iteration)
	nodes map[string]Node
	edges map[string]string              // from -> static default target
	cond  map[string]func(*State) string // from -> conditional target function
}

// NewGraph returns an empty graph.
func NewGraph() *Graph {
	return &Graph{
		nodes: map[string]Node{},
		edges: map[string]string{},
		cond:  map[string]func(*State) string{},
	}
}

// AddNode registers a node under its Name(). A duplicate name overwrites.
func (g *Graph) AddNode(n Node) *Graph {
	if _, exists := g.nodes[n.Name()]; !exists {
		g.order = append(g.order, n.Name())
	}
	g.nodes[n.Name()] = n
	return g
}

// AddEdge sets the default target for from. Use End as to to terminate.
func (g *Graph) AddEdge(from, to string) *Graph {
	g.edges[from] = to
	return g
}

// AddConditionalEdge sets a function that picks the next node from State at
// runtime. A conditional edge takes precedence over a static edge from the same
// node; a node's own NodeResult.Next takes precedence over both.
func (g *Graph) AddConditionalEdge(from string, fn func(*State) string) *Graph {
	g.cond[from] = fn
	return g
}

// SetEntry names the node the walk starts from.
func (g *Graph) SetEntry(name string) *Graph {
	g.entry = name
	return g
}

// Entry returns the entry node name.
func (g *Graph) Entry() string { return g.entry }

// Lookup returns the node registered under name.
func (g *Graph) Lookup(name string) (Node, bool) {
	n, ok := g.nodes[name]
	return n, ok
}

// Next resolves the edge out of from given State: an explicit result target
// wins, then a conditional edge, then a static edge; absent all three the walk
// terminates (End). explicit is the NodeResult.Next of the node just run ("" if
// none).
func (g *Graph) Next(from, explicit string, s *State) string {
	if explicit != "" {
		return explicit
	}
	if fn, ok := g.cond[from]; ok {
		if to := fn(s); to != "" {
			return to
		}
	}
	if to, ok := g.edges[from]; ok {
		return to
	}
	return End
}

// Validate reports the first structural fault: no entry, unknown entry, an edge
// from or to an unregistered node, or a gate routing to an unknown target. It
// does not evaluate conditional-edge functions (their targets are dynamic).
func (g *Graph) Validate() error {
	if g.entry == "" {
		return errors.New("orchestrator: graph has no entry node (call SetEntry)")
	}
	if _, ok := g.nodes[g.entry]; !ok {
		return fmt.Errorf("orchestrator: entry node %q is not registered", g.entry)
	}

	froms := make([]string, 0, len(g.edges))
	for from := range g.edges {
		froms = append(froms, from)
	}
	sort.Strings(froms)
	for _, from := range froms {
		if _, ok := g.nodes[from]; !ok {
			return fmt.Errorf("orchestrator: edge from unknown node %q", from)
		}
		if to := g.edges[from]; !g.isTarget(to) {
			return fmt.Errorf("orchestrator: edge %s -> %s points to an unknown node", from, to)
		}
	}

	for _, name := range g.order {
		tl, ok := g.nodes[name].(targetLister)
		if !ok {
			continue
		}
		for _, to := range tl.Targets() {
			if to == "" {
				continue
			}
			if !g.isTarget(to) {
				return fmt.Errorf("orchestrator: node %s routes to unknown node %q", name, to)
			}
		}
	}
	return nil
}

// isTarget reports whether name is a valid edge target (a registered node or the
// End sentinel).
func (g *Graph) isTarget(name string) bool {
	if name == End {
		return true
	}
	_, ok := g.nodes[name]
	return ok
}
