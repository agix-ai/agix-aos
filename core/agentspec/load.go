// Spec loading + fleet discovery. Specs are JSON on disk (agents/<name>/agent.json)
// so the zero-dep core stays zero-dep: encoding/json is stdlib, and a spec parses
// with no engine imports. YAML remains the operator's authoring format — the trivial
// YAML→JSON bridge lives OUTSIDE this module (the existing `bin/agix` toolchain),
// so the born-clean core never grows a YAML dependency to read the contract it runs.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package agentspec

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// Load reads and validates a single spec file. A parse error names the file; a
// validation error names the agent. The returned Spec is ready to run.
func Load(path string) (*Spec, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("agentspec: read %s: %w", path, err)
	}
	var s Spec
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("agentspec: parse %s: %w", path, err)
	}
	if err := s.Validate(); err != nil {
		return nil, err
	}
	return &s, nil
}

// LoadDir loads the spec at <dir>/agent.json — the canonical layout, where an
// agent's spec sits in its own directory beside its (legacy) manifest and assets.
func LoadDir(dir string) (*Spec, error) {
	return Load(filepath.Join(dir, SpecFileName))
}

// LoadName loads the spec for a named agent under root (root/<name>/agent.json).
// It is the lookup the `agent run <name>` CLI verb uses.
func LoadName(root, name string) (*Spec, error) {
	return LoadDir(filepath.Join(root, name))
}

// Discover walks root/*/agent.json and returns every reborn spec, sorted by name.
// Directories without an agent.json (an un-ported legacy Node agent) are skipped,
// so the reborn fleet grows one blessed port at a time inside the same agents/
// tree. A spec that is present but invalid is a hard error — a broken port must
// not be silently omitted.
func Discover(root string) ([]*Spec, error) {
	matches, err := filepath.Glob(filepath.Join(root, "*", SpecFileName))
	if err != nil {
		return nil, fmt.Errorf("agentspec: discover %s: %w", root, err)
	}
	specs := make([]*Spec, 0, len(matches))
	for _, path := range matches {
		s, err := Load(path)
		if err != nil {
			return nil, err
		}
		specs = append(specs, s)
	}
	sort.Slice(specs, func(i, j int) bool { return specs[i].Name < specs[j].Name })
	return specs, nil
}
