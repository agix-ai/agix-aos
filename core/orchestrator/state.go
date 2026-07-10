package orchestrator

import "github.com/agix-ai/agix/core/router"

// State is the shared medium threaded through a run — the in-run stigmergy
// substrate. Data carries arbitrary keyed values between nodes; Transcript
// accumulates the conversation turns each AgentNode contributes. Distinct from
// the cross-run coord lease ledger: State lives for the duration of one graph
// walk (checkpointed across an interrupt), the lease ledger coordinates across
// parallel runs.
type State struct {
	Data       map[string]any   `json:"data"`
	Transcript []router.Message `json:"transcript"`
}

// NewState returns an empty, ready-to-use State.
func NewState() *State {
	return &State{Data: map[string]any{}}
}

// Set stores val under key, initializing Data if needed.
func (s *State) Set(key string, val any) {
	if s.Data == nil {
		s.Data = map[string]any{}
	}
	s.Data[key] = val
}

// Get returns the value under key and whether it was present.
func (s *State) Get(key string) (any, bool) {
	v, ok := s.Data[key]
	return v, ok
}

// GetString returns the string value under key, or "" if absent/non-string.
func (s *State) GetString(key string) string {
	if v, ok := s.Data[key]; ok {
		if str, ok := v.(string); ok {
			return str
		}
	}
	return ""
}

// Append adds one or more turns to the Transcript.
func (s *State) Append(msgs ...router.Message) {
	s.Transcript = append(s.Transcript, msgs...)
}

// Clone returns an independent copy suitable for checkpointing: the Data map and
// Transcript slice are copied so mutations to the live State after a checkpoint
// do not leak into the snapshot.
//
// seam: this is a shallow copy of Data VALUES — nested mutable values (maps,
// slices held under a Data key) are shared. The demo threads only strings, so
// this is sound today; a durable Checkpointer will serialize State fully.
func (s *State) Clone() *State {
	if s == nil {
		return NewState()
	}
	data := make(map[string]any, len(s.Data))
	for k, v := range s.Data {
		data[k] = v
	}
	tr := make([]router.Message, len(s.Transcript))
	copy(tr, s.Transcript)
	return &State{Data: data, Transcript: tr}
}
