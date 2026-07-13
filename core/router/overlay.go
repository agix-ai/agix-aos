// Per-capability routing overlay — the persisted layer that lets ONE capability
// graduate to a different provider without moving the rest of the run. Where
// ForceProvider is all-or-nothing (pin the WHOLE run to one provider), the
// overlay is a surgical, capability-scoped override that OUTRANKS ForceProvider:
// a graduated capability (e.g. cheap-classification→local) keeps routing to its
// own provider even when the run is pinned elsewhere with `--provider anthropic`.
//
// PRECEDENCE (resolved in Resolve): overlay > forced > default table.
//
// The overlay is a tiny capability→provider map persisted at ~/.agix/routing.json
// (e.g. {"cheap-classification":"local"}). The Model is kept from the table — the
// overlaid provider receives the table's model id as an opaque string, exactly
// mirroring ForceProvider (which also keeps the models). So a made-up/absent model
// still reaches the overlay provider: capability routing resolves the provider from
// the overlay, never by prefix-inferring it from the model id.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package router

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// knownProviderNames is the canonical provider-name namespace the overlay accepts
// (the same set the CLI's --provider lane registers). Kept here so both the router
// and the persistence loader validate against one source of truth.
var knownProviderNames = []string{"anthropic", "gemini", "local", "mock", "openai"}

// KnownProviders returns the sorted canonical provider names an overlay may target.
func KnownProviders() []string {
	out := make([]string, len(knownProviderNames))
	copy(out, knownProviderNames)
	sort.Strings(out)
	return out
}

func knownProvider(name string) bool {
	for _, p := range knownProviderNames {
		if p == name {
			return true
		}
	}
	return false
}

// KnownCapabilities returns the sorted set of routable capability keys (the same
// keys DefaultRoutingTable populates) — the overlay's accepted capability domain.
func KnownCapabilities() []Capability {
	caps := []Capability{
		CapCheapClassification, CapDefaultQuality, CapLongContext, CapToolUseHeavy, CapVision,
	}
	sort.Slice(caps, func(i, j int) bool { return caps[i] < caps[j] })
	return caps
}

func validCapability(c Capability) bool {
	switch c {
	case CapDefaultQuality, CapCheapClassification, CapLongContext, CapToolUseHeavy, CapVision:
		return true
	}
	return false
}

func capabilityNames() string {
	caps := KnownCapabilities()
	names := make([]string, len(caps))
	for i, c := range caps {
		names[i] = string(c)
	}
	return strings.Join(names, ", ")
}

// SetCapabilityProvider adds (or replaces) one capability→provider override on the
// router's overlay. It validates the capability against Resolve's known set (the
// router's own table) and the provider against the known provider namespace, so an
// unknown cap or provider is rejected with a clear error rather than silently
// mis-routing. The overlaid capability then RESISTS ForceProvider (overlay > forced).
func (r *Router) SetCapabilityProvider(c Capability, provider string) error {
	if _, ok := r.table[c]; !ok {
		return fmt.Errorf("unknown capability %q; known: %s", c, r.knownCaps())
	}
	if !knownProvider(provider) {
		return fmt.Errorf("unknown provider %q; known: %s", provider, strings.Join(KnownProviders(), ", "))
	}
	if r.overlay == nil {
		r.overlay = map[Capability]string{}
	}
	r.overlay[c] = provider
	return nil
}

// SetOverlay applies a whole capability→provider overlay, validating every entry.
// On the first invalid entry it returns the error and leaves the router unchanged
// beyond the entries already applied (callers pass a validated map from LoadOverlay).
func (r *Router) SetOverlay(m map[Capability]string) error {
	// Deterministic order so an error is reproducible.
	keys := make([]string, 0, len(m))
	for c := range m {
		keys = append(keys, string(c))
	}
	sort.Strings(keys)
	for _, k := range keys {
		if err := r.SetCapabilityProvider(Capability(k), m[Capability(k)]); err != nil {
			return err
		}
	}
	return nil
}

// IsOverlaid reports whether capability c is currently overridden by the overlay.
func (r *Router) IsOverlaid(c Capability) bool {
	_, ok := r.overlay[c]
	return ok
}

// ApplyOverlayFile loads the persisted overlay at path and applies it. A missing or
// empty file is a no-op (default routing unchanged); a malformed or invalid file
// returns an error.
func (r *Router) ApplyOverlayFile(path string) error {
	overlay, err := LoadOverlay(path)
	if err != nil {
		return err
	}
	return r.SetOverlay(overlay)
}

// DefaultOverlayPath is ~/.agix/routing.json — the instance home the rest of the
// runtime uses (mirrors defaultDBPath in the CLI). Falls back to a CWD-relative
// path when the home dir cannot be resolved.
func DefaultOverlayPath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(".agix", "routing.json")
	}
	return filepath.Join(home, ".agix", "routing.json")
}

// LoadOverlay reads and validates the overlay at path. A missing or whitespace-only
// file yields an empty overlay and no error (the default, overlay-free path). Any
// unknown capability or provider is rejected with a clear, actionable error.
func LoadOverlay(path string) (map[Capability]string, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[Capability]string{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("routing overlay: read %s: %w", path, err)
	}
	if strings.TrimSpace(string(data)) == "" {
		return map[Capability]string{}, nil
	}
	var raw map[string]string
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("routing overlay: parse %s: %w", path, err)
	}
	overlay := make(map[Capability]string, len(raw))
	for k, v := range raw {
		c := Capability(k)
		if !validCapability(c) {
			return nil, fmt.Errorf("routing overlay %s: unknown capability %q; known: %s", path, k, capabilityNames())
		}
		if !knownProvider(v) {
			return nil, fmt.Errorf("routing overlay %s: unknown provider %q for capability %q; known: %s",
				path, v, k, strings.Join(KnownProviders(), ", "))
		}
		overlay[c] = v
	}
	return overlay, nil
}

// SaveOverlay validates and writes the overlay to path (creating ~/.agix if needed),
// pretty-printed with stable key order. An EMPTY overlay removes the file so the
// default, overlay-free path stays pristine (a subsequent LoadOverlay is a no-op).
func SaveOverlay(path string, overlay map[Capability]string) error {
	for c, p := range overlay {
		if !validCapability(c) {
			return fmt.Errorf("routing overlay: unknown capability %q; known: %s", c, capabilityNames())
		}
		if !knownProvider(p) {
			return fmt.Errorf("routing overlay: unknown provider %q for capability %q; known: %s",
				p, c, strings.Join(KnownProviders(), ", "))
		}
	}
	if len(overlay) == 0 {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("routing overlay: remove %s: %w", path, err)
		}
		return nil
	}
	raw := make(map[string]string, len(overlay))
	for c, p := range overlay {
		raw[string(c)] = p
	}
	// encoding/json sorts map keys, so the file is deterministic.
	data, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return fmt.Errorf("routing overlay: encode: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("routing overlay: mkdir %s: %w", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		return fmt.Errorf("routing overlay: write %s: %w", path, err)
	}
	return nil
}
