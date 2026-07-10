package swarm

import (
	"context"
	"sync"
	"time"

	"github.com/agix-ai/agix/core/agent"
	"github.com/agix-ai/agix/core/caste"
	"github.com/agix-ai/agix/core/coord"
	"github.com/agix-ai/agix/core/router"
)

// workerOut is one worker bee's landed result. Each fan-out goroutine writes
// exactly one workerOut into its own slice index, so there is no shared mutation
// and no lock is needed on the outputs.
type workerOut struct {
	Subtask Subtask
	Result  agent.Result
	Bee     BeeCost
	Err     error
}

// fanOut runs each subtask on its own worker bee IN PARALLEL, bounded by
// o.Concurrency. Every worker reuses the tested agent loop verbatim
// (lease-claim → router.Chat → ledger → lease-release), claiming a DISTINCT
// subtask scope on the shared coord ledger; the ledger's mutex makes the
// parallel claims race-free, and distinct scopes mean no two workers collide.
//
// Heals posture: a worker error is captured in its workerOut and shipped partial
// — siblings are never cancelled.
func fanOut(ctx context.Context, r *router.Router, leases coord.LeaseLedger, o Options, runScope string, subtasks []Subtask) []workerOut {
	outs := make([]workerOut, len(subtasks))
	sem := make(chan struct{}, o.Concurrency)
	var wg sync.WaitGroup

	for i, st := range subtasks {
		wg.Add(1)
		go func(i int, st Subtask) {
			defer wg.Done()
			sem <- struct{}{}        // acquire a concurrency slot
			defer func() { <-sem }() // release it

			prompt := st.Prompt
			if o.Retriever != nil {
				if aug, _, aerr := o.Retriever.Augment(ctx, st.Prompt); aerr == nil && aug != "" {
					prompt = aug
				}
			}

			actor := caste.Actor(o.Hive, caste.Worker, "forager", i+1)
			ag := &agent.Agent{Name: actor, Router: r, Ledger: o.Ledger, Leases: leases}

			// Round-robin the explicit worker models across the N workers
			// (e.g. 2 models, 4 workers → m0,m1,m0,m1). Empty = capability default.
			var workerModel string
			if n := len(o.WorkerModels); n > 0 {
				workerModel = o.WorkerModels[i%n]
			}

			start := time.Now()
			res, err := ag.Run(ctx, agent.Task{
				Name:       st.ID,
				Prompt:     prompt,
				Scope:      []string{runScope + "/subtask/" + st.ID},
				Capability: o.WorkerCap,
				Model:      workerModel,
				MaxTokens:  o.MaxTokens, // each forage honors the per-slice budget
				Tools:      o.Tools,     // nil = single-call forage; set = tool-use loop
			})
			lat := time.Since(start).Seconds()

			model := recordedModel(workerModel, res.Model)
			if err != nil {
				model = "degraded"
			}
			// Write ONLY this goroutine's slot — no shared mutation.
			outs[i] = workerOut{
				Subtask: st,
				Result:  res,
				Err:     err,
				Bee: BeeCost{
					Actor:    actor,
					Role:     "forager",
					Phase:    "work",
					Model:    model,
					Subtask:  st.ID,
					Usage:    res.Usage,
					LatencyS: lat,
				},
			}
		}(i, st)
	}

	wg.Wait()
	return outs
}
