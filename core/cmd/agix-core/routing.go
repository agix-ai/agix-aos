// `agix route` — inspect and edit the per-capability routing overlay.
//
// The router resolves a Capability to a provider/model via a default table, an
// optional whole-run --provider force, and — outranking both — a persisted
// per-capability overlay at ~/.agix/routing.json. This file is the CLI over that
// overlay: show what a capability resolves to (marking overlaid ones), list the
// whole effective table, and set/unset individual overrides.
//
//	agix route                          list the full effective table
//	agix route list                     (same)
//	agix route <capability>             show the provider/model for one capability
//	agix route set <capability> <prov>  persist an override to ~/.agix/routing.json
//	agix route unset <capability>       remove an override
//
// PRECEDENCE: overlay > forced (--provider) > default table. An overlaid
// capability keeps its provider even when a run is pinned elsewhere — the point
// of graduation (e.g. cheap-classification→local under `--provider anthropic`).
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"fmt"
	"os"

	"github.com/agix-ai/agix/core/provider/anthropic"
	"github.com/agix-ai/agix/core/provider/gemini"
	"github.com/agix-ai/agix/core/provider/local"
	"github.com/agix-ai/agix/core/provider/mock"
	"github.com/agix-ai/agix/core/provider/openai"
	"github.com/agix-ai/agix/core/router"
)

// registerProviderByName registers the adapter for one provider name on r. It is
// the single source of truth for "name → adapter", reused by the --provider lane
// and by overlay-target registration (so an overlaid capability's provider is
// available to dispatch even if it is not the run's primary provider).
func registerProviderByName(r *router.Router, name string) error {
	switch name {
	case "mock":
		r.Register(mock.New())
	case "anthropic":
		r.Register(anthropic.New())
	case "openai":
		r.Register(openai.New())
	case "gemini":
		r.Register(gemini.New())
	case "local":
		r.Register(local.New())
	default:
		return fmt.Errorf("unknown provider %q (mock|anthropic|openai|gemini|local)", name)
	}
	return nil
}

// applyOverlayToRun loads the persisted overlay and applies it to a run's router
// AFTER any ForceProvider (so overlay precedence holds), registering each
// overlay-target provider so the resolved capability can actually dispatch. A
// missing/empty overlay is a no-op — the default $0-mock path is unchanged.
func applyOverlayToRun(r *router.Router) error {
	overlay, err := router.LoadOverlay(router.DefaultOverlayPath())
	if err != nil {
		return err
	}
	for c, prov := range overlay {
		if err := r.SetCapabilityProvider(c, prov); err != nil {
			return err
		}
		if err := registerProviderByName(r, prov); err != nil {
			return err
		}
	}
	return nil
}

// cmdRoute dispatches the `agix route …` verb.
func cmdRoute(args []string) int {
	if len(args) == 0 {
		return routeList()
	}
	switch args[0] {
	case "list":
		return routeList()
	case "set":
		if len(args) != 3 {
			fmt.Fprintln(os.Stderr, "route set: usage: agix route set <capability> <provider>")
			return 2
		}
		return routeSet(args[1], args[2])
	case "unset":
		if len(args) != 2 {
			fmt.Fprintln(os.Stderr, "route unset: usage: agix route unset <capability>")
			return 2
		}
		return routeUnset(args[1])
	default:
		return routeShow(args[0])
	}
}

// routeShow prints the effective provider/model for one capability, marking it
// "(overlaid)" when a persisted override is in effect.
func routeShow(capArg string) int {
	r := router.NewRouter()
	if err := r.ApplyOverlayFile(router.DefaultOverlayPath()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	c := router.Capability(capArg)
	route, err := r.Resolve(c)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	tag := ""
	if r.IsOverlaid(c) {
		tag = "  (overlaid)"
	}
	// match the house `label:  value` style used by run/flow/km/secret.
	fmt.Printf("route:  %s → %s/%s%s\n", route.Capability, route.Provider, route.Model, tag)
	return 0
}

// routeList prints the whole effective routing table, marking each capability
// (overlaid) or (default).
func routeList() int {
	r := router.NewRouter()
	if err := r.ApplyOverlayFile(router.DefaultOverlayPath()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println("routing table (effective):")
	for _, c := range router.KnownCapabilities() {
		route, err := r.Resolve(c)
		if err != nil {
			continue
		}
		tag := "(default)"
		if r.IsOverlaid(c) {
			tag = "(overlaid)"
		}
		fmt.Printf("  %-22s %s/%s  %s\n", route.Capability, route.Provider, route.Model, tag)
	}
	return 0
}

// routeSet validates and persists one capability→provider override.
func routeSet(capArg, provider string) int {
	c := router.Capability(capArg)
	// Validate the pair against Resolve's known caps + the known provider set.
	if err := router.NewRouter().SetCapabilityProvider(c, provider); err != nil {
		fmt.Fprintln(os.Stderr, "route set:", err)
		return 1
	}
	path := router.DefaultOverlayPath()
	overlay, err := router.LoadOverlay(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "route set:", err)
		return 1
	}
	overlay[c] = provider
	if err := router.SaveOverlay(path, overlay); err != nil {
		fmt.Fprintln(os.Stderr, "route set:", err)
		return 1
	}
	fmt.Printf("route set: %s → %s  (persisted to %s)\n", c, provider, path)
	return 0
}

// routeUnset removes one capability's override.
func routeUnset(capArg string) int {
	c := router.Capability(capArg)
	path := router.DefaultOverlayPath()
	overlay, err := router.LoadOverlay(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "route unset:", err)
		return 1
	}
	if _, ok := overlay[c]; !ok {
		fmt.Printf("route unset: %s has no override (nothing to do)\n", c)
		return 0
	}
	delete(overlay, c)
	if err := router.SaveOverlay(path, overlay); err != nil {
		fmt.Fprintln(os.Stderr, "route unset:", err)
		return 1
	}
	fmt.Printf("route unset: %s override removed  (%s)\n", c, path)
	return 0
}
