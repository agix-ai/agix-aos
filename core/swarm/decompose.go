package swarm

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/agix-ai/agix/core/apiary"
	"github.com/agix-ai/agix/core/router"
)

const queenSystem = "You are the Queen of an Agix hive. Decompose the task into exactly N independent subtasks a cheap worker can solve in isolation and that can be synthesized. Return ONLY JSON."

// decomposition is the shape the Queen is asked to return.
type decomposition struct {
	Subtasks []Subtask `json:"subtasks"`
}

// decompose runs ONE Queen model call to split the task into o.Workers
// subtasks. It is parse-or-fallback: if the reply is not a parseable JSON object
// with exactly o.Workers subtasks (the mock provider always fails this), it
// falls back to a deterministic split so first-light stays green and offline. It
// returns the subtasks, the Queen's BeeCost, and a non-empty degraded marker if
// the model call itself failed.
func decompose(ctx context.Context, r *router.Router, o Options) (subtasks []Subtask, bee BeeCost, degraded string) {
	n := o.Workers
	queenActor := apiary.ActorRef(o.Hive, "queen", "root")
	prompt := fmt.Sprintf(
		"Task: %s\n\nDecompose this into exactly %d independent subtasks, each solvable by a single cheap worker in isolation and later synthesizable. "+
			"Reply with only a JSON object whose subtasks field is an array of objects with id, title, and prompt string fields.",
		o.Task, n)

	start := time.Now()
	resp, err := r.Chat(ctx, router.ChatRequest{
		System:     queenSystem,
		Messages:   []router.Message{{Role: "user", Content: prompt}},
		MaxTokens:  o.MaxTokens,
		Capability: o.QueenCap,
		Model:      o.QueenModel,
	})
	lat := time.Since(start).Seconds()

	bee = BeeCost{Actor: queenActor, Role: "queen", Phase: "decompose", Model: recordedModel(o.QueenModel, resp.Model), Usage: resp.Usage, LatencyS: lat}
	if err != nil {
		// heals posture: a broken provider still yields a runnable split.
		bee.Model = "degraded"
		return fallbackSplit(o.Task, n), bee, "queen-decompose-failed"
	}
	if subs, ok := parseSubtasks(resp.Text, n); ok {
		return subs, bee, ""
	}
	return fallbackSplit(o.Task, n), bee, ""
}

// parseSubtasks extracts a JSON object from text and accepts it only if it holds
// exactly n non-empty-prompt subtasks. Missing ids are filled positionally.
func parseSubtasks(text string, n int) ([]Subtask, bool) {
	js := extractJSON(text)
	if js == "" {
		return nil, false
	}
	var d decomposition
	if err := json.Unmarshal([]byte(js), &d); err != nil {
		return nil, false
	}
	if len(d.Subtasks) != n {
		return nil, false
	}
	for i := range d.Subtasks {
		if strings.TrimSpace(d.Subtasks[i].Prompt) == "" {
			return nil, false
		}
		if strings.TrimSpace(d.Subtasks[i].ID) == "" {
			d.Subtasks[i].ID = fmt.Sprintf("st-%d", i+1)
		}
		if strings.TrimSpace(d.Subtasks[i].Title) == "" {
			d.Subtasks[i].Title = fmt.Sprintf("Subtask %d", i+1)
		}
	}
	return d.Subtasks, true
}

// fallbackSplit is the deterministic decomposition: n self-contained slices of
// the same task, each instructing its worker to solve one slice in isolation and
// produce a mergeable result.
func fallbackSplit(task string, n int) []Subtask {
	if n < 1 {
		n = 1
	}
	subs := make([]Subtask, n)
	for i := 0; i < n; i++ {
		subs[i] = Subtask{
			ID:    fmt.Sprintf("st-%d", i+1),
			Title: fmt.Sprintf("Slice %d of %d", i+1, n),
			Prompt: fmt.Sprintf(
				"You are foraging slice %d of %d of a larger task, working in isolation from the other workers. "+
					"Produce a self-contained result for your slice that can be merged with the rest.\n\nOverall task: %s",
				i+1, n, task),
		}
	}
	return subs
}

// extractJSON returns the substring from the first '{' to the last '}', or ""
// when there is no brace pair (e.g. the mock provider's plain-text reply).
func extractJSON(s string) string {
	i := strings.IndexByte(s, '{')
	j := strings.LastIndexByte(s, '}')
	if i < 0 || j < 0 || j < i {
		return ""
	}
	return s[i : j+1]
}
