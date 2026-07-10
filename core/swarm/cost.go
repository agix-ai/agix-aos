package swarm

import "github.com/agix-ai/agix/core/router"

// BeeCost is one bee's contribution to a swarm run — who it was, what phase it
// worked, the model it routed to, and its token/cost/latency accounting. The
// Bees slice on Cost is the per-bee provenance the study arm sums and audits.
type BeeCost struct {
	Actor    string       `json:"actor"`
	Role     string       `json:"role"`
	Phase    string       `json:"phase"`
	Model    string       `json:"model"`
	Subtask  string       `json:"subtask,omitempty"`
	Usage    router.Usage `json:"usage"`
	LatencyS float64      `json:"latency_s"`
}

// Cost is the whole-swarm rollup. USD/token totals are the sum of every bee's
// usage, so the invariant Cost.USD == Σ Bees[i].Usage.CostUSD always holds
// (trivially $0 under the mock provider). LatencyS is the sum of per-bee
// latencies (total bee-seconds), not wall-clock, since workers overlap.
type Cost struct {
	USD          float64   `json:"usd"`
	InputTokens  int       `json:"input_tokens"`
	OutputTokens int       `json:"output_tokens"`
	CachedTokens int       `json:"cached_tokens"`
	LatencyS     float64   `json:"latency_s"`
	Bees         []BeeCost `json:"bees"`
}

// add folds one bee's usage into the rollup and records its provenance. It is
// called only from the orchestrating goroutine (never from a fan-out worker), so
// no lock is needed.
func (c *Cost) add(b BeeCost) {
	c.Bees = append(c.Bees, b)
	c.USD += b.Usage.CostUSD
	c.InputTokens += b.Usage.InputTokens
	c.OutputTokens += b.Usage.OutputTokens
	c.CachedTokens += b.Usage.CachedTokens
	c.LatencyS += b.LatencyS
}
