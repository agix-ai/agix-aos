// Package orchestrator is the Agix-owned graph/runner PORT — the thin,
// zero-dependency seam that keeps the execution substrate swappable and the
// decision reversible. Agent code builds a Graph of Nodes and hands it to a
// Runner; which engine actually walks the graph (the in-memory MemRunner today,
// Google ADK-Go next, CloudWeGo Eino as a fallback) is a one-line swap that
// never touches node code.
//
// The port encodes one beehive governance primitive directly: actor≠verifier.
// A GateNode does not decide — it RETURNS an Interrupt describing what must be
// ratified and pauses the run. A different bee (or a human) resumes the run with
// a GateDecision, and only then does the work flow into the comb (OnApprove) or
// divert to remediation (OnReject). This is LangGraph/ADK's interrupt/resume
// human-in-the-loop pattern, landed in Go, on top of Agix's own types so the
// substrate underneath stays replaceable.
//
// Layering (no cycles): this package depends only on router + ledger + stdlib.
// The concrete engines live one level down (orchestrator/mem, orchestrator/adk)
// and depend on this package, not the reverse.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package orchestrator
