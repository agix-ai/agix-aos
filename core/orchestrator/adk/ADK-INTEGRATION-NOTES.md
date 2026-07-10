# ADK-Go binding — integration notes & status

The Agix orchestrator port (`core/orchestrator`) is substrate-agnostic. This
package is the **Google ADK-Go-backed substrate** behind it. It is deliberately a
**nested Go module** (its own `go.mod`) so ADK-Go's large Google-Cloud dependency
tree never touches the born-clean, zero-dependency `github.com/agix-ai/agix/core`
module. Nested modules are excluded from the parent's `./...`, so
`cd core && go build/vet/test ./...` stays stdlib-only and green no matter what
happens in here.

- **ADK-Go module path:** `google.golang.org/adk` (NOT `github.com/google/adk-go` —
  that is the repo URL; the declared module path is `google.golang.org/adk`).
- **Version pinned:** `v1.5.0`.
- **Build/test this binding:** `cd core/orchestrator/adk && go test ./...`
  (zero network, zero credentials — see below).

## How far the binding got

| Agix port concept              | ADK-Go concept                                   | Status |
|--------------------------------|--------------------------------------------------|--------|
| `orchestrator.Checkpointer`    | `session.Service` (`session.InMemoryService()`)  | **FUNCTIONAL** — Save creates an ADK session holding the JSON-serialized `State`; Load reads it back. Round-trip tested (`adk_test.go`), zero network. |
| `orchestrator.State`           | `session.Session` + `session.State` (k/v store)  | **FUNCTIONAL** — serialized under a reserved state key `agix.state`. |
| `orchestrator.Runner` (build)  | `runner.New` + `agent.New`                       | **WIRED** — real ADK runner + a *custom* agent are constructed locally, no network, no `model.Model` (hence no Gemini creds). |
| `orchestrator.Graph` / `Node`  | ADK agent tree / `agent.Config.Run` event stream | **TODO(adk)** — walk the graph inside the agent's `Run`, yielding one `session.Event` per node. |
| `orchestrator.Interrupt` / `Resume` | ADK long-running function-call + function-response (HITL) | **TODO(adk)** — raise a long-running function-call `session.Event` at a `GateNode`; resume by appending the verdict as a function-response and re-invoking `runner.Run`. |

`Runner.Run` / `Runner.Resume` return `ErrExecIncomplete` until the two `TODO(adk)`
items land. The **`mem` engine stays the default** for everything (CLI, demo,
tests); this substrate is the reversible seam under construction.

## Why the execution half is not wired yet (one flight, honestly)

ADK-Go's execution model is materially different from the explicit Node/Edge
graph the port exposes:

1. **Agents, not nodes.** `agent.Agent` has unexported methods — you cannot
   implement it directly; you must use ADK constructors (`agent.New`,
   `llmagent.New`, workflow agents). Execution is an **event-stream iterator**
   (`Run(InvocationContext) iter.Seq2[*session.Event, error]`) with LLM-driven
   agent transfer, not a synchronous edge walk. Mapping the Agix walk onto it
   means emitting correctly-shaped `session.Event`s (each embeds
   `model.LLMResponse` / `genai.Content`).
2. **HITL is function-call/response, not a return value.** ADK's interrupt/resume
   is a **long-running function-call** event that pauses the run; you resume by
   appending a **function-response** event to the same session and re-invoking the
   runner. The Agix `GateNode` returns an `Interrupt` struct synchronously — the
   semantics match, but the event/`genai` shaping is the real work.
3. **The model bridge.** A "normal" ADK agent (`llmagent.New`) needs a
   `model.Model` that speaks `genai.Content` and streams `model.LLMResponse`.
   Bridging that to the Agix `router.Router` (so the ADK path is cost-routed and
   provider-agnostic like the rest of core) is a self-contained adapter worth its
   own slice. The custom `agent.New` path sidesteps it for now, which is exactly
   why construction needs no credentials.

None of this blocks the flight's value: the **port + governance gate + MemRunner**
are fully functional and green, and the ADK **session/state binding is real and
tested**. The remaining work is well-scoped, not speculative.

## Next actions (a clean follow-on slice)

1. **AgentNode → ADK events.** In `graphAgentRun`, recover the graph + `State`
   from the invocation/session, run each `AgentNode` via the `router.Router`
   bridge, and `yield` a `session.Event` per node (author = node name).
2. **GateNode → long-running function call.** At a `GateNode`, `yield` a
   long-running function-call event and stop; persist the pending interrupt in the
   session state (the Checkpointer already round-trips state).
3. **Resume → function-response.** In `Runner.Resume`, append the `GateDecision`
   as a function-response event and re-invoke `runner.Run` to continue past the
   gate.
4. **Model bridge (optional, for `llmagent`).** Implement `model.Model` over
   `router.Router` so ADK LLM agents inherit Agix cost-routing; keep the
   credential-free custom-agent path as the default test lane.
5. **Eino fallback.** The same port admits a CloudWeGo Eino-backed runner as an
   alternative substrate; note it here when scoped.

Copyright 2026 Agix AI LLC. Apache-2.0.
