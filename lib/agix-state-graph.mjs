// agix-state-graph — Q2 native StateGraph primitive (Sprint 2).
//
// A tiny dependency-free state machine for orchestrator-style agents.
// Built natively rather than adopting LangGraph: the pattern is small,
// well-understood, and reusable across every per-client orchestrator,
// and a LangChain dependency would erode the Agix-runtime IP story
// (runtime backlog §Sprint 2, DeerFlow tech-radar brief §2.3).
//
// Shape (per the backlog):
//
//   const graph = defineGraph({
//     initial: 'idle',
//     states: ['idle', 'active', 'paused', 'completed'],
//     transitions: [
//       { from: 'idle',   event: 'cycle_started', to: 'active',
//         action: async (payload, ctx) => { ... } },
//       { from: 'active', event: 'tick',          to: 'active' },
//       { from: '*',      event: 'abort',         to: 'completed' },
//     ],
//     on_enter: { active: async (ctx) => { ... } },
//     on_exit:  { active: async (ctx) => { ... } },
//   });
//
//   await graph.fire('cycle_started', { cycleId });
//     → { from, to, event, result }   (result = action's return value)
//
// Semantics:
//   - Transition resolution: exact `from` match wins over wildcard '*'.
//   - Hook order on a transition A → B: on_exit[A] → action → on_enter[B].
//     Self-transitions (A → A) run action only (no exit/enter churn).
//   - Unknown event from the current state throws, naming the events
//     that ARE allowed — orchestrator bugs surface as readable errors.
//   - `graph.state` is the current state; `graph.history` records every
//     fired transition (capped) for legibility surfaces.
//   - Smoke mode (`defineGraph({ ..., smoke: true })`, set automatically
//     by `runtime.getStateGraph()`): transitions execute (the machine is
//     pure), but actions and hooks — the I/O — are skipped and logged,
//     symmetric to every other runtime smoke stub.

const HISTORY_CAP = 200;

export function defineGraph({
  initial,
  states = [],
  transitions = [],
  on_enter = {},
  on_exit = {},
  smoke = false,
} = {}) {
  if (!initial) throw new Error('defineGraph: initial state is required');
  if (!states.includes(initial)) {
    throw new Error(`defineGraph: initial state "${initial}" is not in states [${states.join(', ')}]`);
  }
  for (const t of transitions) {
    if (t.from !== '*' && !states.includes(t.from)) {
      throw new Error(`defineGraph: transition from unknown state "${t.from}"`);
    }
    if (!states.includes(t.to)) {
      throw new Error(`defineGraph: transition to unknown state "${t.to}"`);
    }
    if (!t.event) throw new Error('defineGraph: every transition needs an event');
  }

  let current = initial;
  const history = [];

  function resolveTransition(event) {
    return (
      transitions.find((t) => t.from === current && t.event === event) ||
      transitions.find((t) => t.from === '*' && t.event === event) ||
      null
    );
  }

  return {
    get state() { return current; },
    get history() { return [...history]; },

    /** Events valid from the current state (for legibility surfaces). */
    allowedEvents() {
      const names = transitions
        .filter((t) => t.from === current || t.from === '*')
        .map((t) => t.event);
      return [...new Set(names)];
    },

    async fire(event, payload = {}) {
      const transition = resolveTransition(event);
      if (!transition) {
        throw new Error(
          `state-graph: event "${event}" is not valid from state "${current}". ` +
          `Allowed: ${this.allowedEvents().join(', ') || '(none)'}`,
        );
      }
      const from = current;
      const to = transition.to;
      const ctx = { from, to, event, payload };

      let result = null;
      if (smoke) {
        console.error(`  [smoke] state-graph · ${from} —${event}→ ${to} (action skipped)`);
      } else {
        if (from !== to && typeof on_exit[from] === 'function') await on_exit[from](ctx);
        if (typeof transition.action === 'function') result = await transition.action(payload, ctx);
        if (from !== to && typeof on_enter[to] === 'function') await on_enter[to](ctx);
      }

      current = to;
      history.push({ from, to, event, ts: new Date().toISOString(), smoke });
      while (history.length > HISTORY_CAP) history.shift();

      return { from, to, event, result, smoke };
    },
  };
}
