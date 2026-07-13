package router_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/agix-ai/agix/core/provider/mock"
	"github.com/agix-ai/agix/core/router"
)

// TestOverlayPrecedenceResolve proves the three-way precedence at Resolve:
// overlay > forced > default table.
func TestOverlayPrecedenceResolve(t *testing.T) {
	// (1) default table: cheap-classification → anthropic.
	r := router.NewRouter()
	got, err := r.Resolve(router.CapCheapClassification)
	if err != nil {
		t.Fatal(err)
	}
	if got.Provider != "anthropic" {
		t.Fatalf("default: cheap-classification provider = %q, want anthropic", got.Provider)
	}

	// (2) forced beats the default table.
	r.ForceProvider("mock")
	got, _ = r.Resolve(router.CapCheapClassification)
	if got.Provider != "mock" {
		t.Fatalf("forced: cheap-classification provider = %q, want mock", got.Provider)
	}

	// (3) overlay beats forced — the whole point of graduation.
	if err := r.SetCapabilityProvider(router.CapCheapClassification, "local"); err != nil {
		t.Fatal(err)
	}
	got, _ = r.Resolve(router.CapCheapClassification)
	if got.Provider != "local" {
		t.Fatalf("overlay: cheap-classification provider = %q, want local (overlay must beat forced)", got.Provider)
	}
	// A non-overlaid capability still follows the forced provider.
	other, _ := r.Resolve(router.CapDefaultQuality)
	if other.Provider != "mock" {
		t.Fatalf("non-overlaid default-quality provider = %q, want mock (forced)", other.Provider)
	}
	// When the overlay reroutes to a DIFFERENT provider, the table's model (which
	// belongs to the default provider) is CLEARED so the graduated provider resolves
	// its own canonical model — else e.g. openai would be handed a claude id.
	if got.Model != "" {
		t.Fatalf("overlaid-to-different-provider route model = %q, want \"\" (cleared)", got.Model)
	}
}

// TestOverlayToForeignProviderClearsModel is the regression for the bug the Agix
// pr-reviewer caught during dogfood: overlaying cheap-classification (table model
// claude-haiku-4-5, an anthropic id) to openai must NOT dispatch that claude id to
// openai — the model is cleared so openai defaults to its own (gpt-4.1).
func TestOverlayToForeignProviderClearsModel(t *testing.T) {
	r := router.NewRouter()
	if err := r.SetCapabilityProvider(router.CapCheapClassification, "openai"); err != nil {
		t.Fatal(err)
	}
	got, _ := r.Resolve(router.CapCheapClassification)
	if got.Provider != "openai" {
		t.Fatalf("provider = %q, want openai", got.Provider)
	}
	if got.Model == "claude-haiku-4-5" {
		t.Fatalf("foreign model %q leaked to openai — the exact bug", got.Model)
	}
	if got.Model != "" {
		t.Fatalf("model = %q, want \"\" (let openai default to gpt-4.1)", got.Model)
	}
}

// TestOverlayResistsForceProviderRegardlessOfOrder proves the overlay wins even
// when ForceProvider is called AFTER SetCapabilityProvider.
func TestOverlayResistsForceProviderRegardlessOfOrder(t *testing.T) {
	r := router.NewRouter()
	if err := r.SetCapabilityProvider(router.CapCheapClassification, "local"); err != nil {
		t.Fatal(err)
	}
	r.ForceProvider("anthropic") // pin the whole run to anthropic AFTER the overlay
	got, _ := r.Resolve(router.CapCheapClassification)
	if got.Provider != "local" {
		t.Fatalf("overlaid cap provider = %q, want local (overlay must resist a later ForceProvider)", got.Provider)
	}
}

// TestOverlayChatDispatchesToOverlayProvider proves the Chat path (not just
// Resolve) routes an overlaid capability to the overlay provider despite a forced
// provider — the E2E precedence at the dispatch level.
func TestOverlayChatDispatchesToOverlayProvider(t *testing.T) {
	r := router.NewRouter()
	r.Register(&mock.MockProvider{Named: "mock"})
	r.Register(&mock.MockProvider{Named: "local"})
	r.ForceProvider("mock")
	if err := r.SetCapabilityProvider(router.CapCheapClassification, "local"); err != nil {
		t.Fatal(err)
	}

	// Overlaid capability dispatches to local.
	resp, err := r.Chat(context.Background(), router.ChatRequest{
		Capability: router.CapCheapClassification,
		Messages:   []router.Message{{Role: "user", Content: "hi"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Provider != "local" {
		t.Fatalf("overlaid cheap-classification dispatched to %q, want local", resp.Provider)
	}

	// A non-overlaid capability still dispatches to the forced provider.
	resp2, err := r.Chat(context.Background(), router.ChatRequest{
		Capability: router.CapDefaultQuality,
		Messages:   []router.Message{{Role: "user", Content: "hi"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp2.Provider != "mock" {
		t.Fatalf("non-overlaid default-quality dispatched to %q, want mock (forced)", resp2.Provider)
	}
}

// TestSetCapabilityProviderRejectsUnknowns proves invalid caps/providers are
// rejected with an error and leave routing unchanged.
func TestSetCapabilityProviderRejectsUnknowns(t *testing.T) {
	r := router.NewRouter()
	if err := r.SetCapabilityProvider("nonsense", "local"); err == nil {
		t.Fatal("expected error for unknown capability")
	}
	if err := r.SetCapabilityProvider(router.CapCheapClassification, "borg"); err == nil {
		t.Fatal("expected error for unknown provider")
	}
	// Nothing was overlaid — default behavior intact.
	if r.IsOverlaid(router.CapCheapClassification) {
		t.Fatal("a rejected set must not overlay the capability")
	}
	got, _ := r.Resolve(router.CapCheapClassification)
	if got.Provider != "anthropic" {
		t.Fatalf("after rejected sets, provider = %q, want anthropic (unchanged)", got.Provider)
	}
}

// TestNewRouterUnaffectedWithoutOverlay proves the default $0 path is byte-for-byte
// unchanged when no overlay is applied.
func TestNewRouterUnaffectedWithoutOverlay(t *testing.T) {
	r := router.NewRouter()
	for _, c := range router.KnownCapabilities() {
		if r.IsOverlaid(c) {
			t.Fatalf("%s is overlaid on a fresh router, want none", c)
		}
	}
	// Default resolutions match the canonical table.
	got, _ := r.Resolve(router.CapVision)
	if got.Provider != "gemini" || got.Model != "gemini-2.5-flash" {
		t.Fatalf("vision = %s/%s, want gemini/gemini-2.5-flash", got.Provider, got.Model)
	}
}

// TestLoadSaveOverlayRoundTrip proves the persistence round-trips and that an
// empty overlay removes the file (pristine default path).
func TestLoadSaveOverlayRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routing.json")

	// Missing file → empty overlay, no error.
	got, err := router.LoadOverlay(path)
	if err != nil {
		t.Fatalf("LoadOverlay(missing): %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("missing file overlay = %v, want empty", got)
	}

	// Save then load.
	want := map[router.Capability]string{
		router.CapCheapClassification: "local",
		router.CapVision:              "openai",
	}
	if err := router.SaveOverlay(path, want); err != nil {
		t.Fatal(err)
	}
	got, err = router.LoadOverlay(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[router.CapCheapClassification] != "local" || got[router.CapVision] != "openai" {
		t.Fatalf("round-trip overlay = %v, want %v", got, want)
	}

	// Empty overlay removes the file.
	if err := router.SaveOverlay(path, map[router.Capability]string{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("empty SaveOverlay should remove the file; stat err = %v", err)
	}
}

// TestLoadOverlayRejectsInvalidFile proves a persisted file with an unknown
// capability or provider is rejected with a clear error.
func TestLoadOverlayRejectsInvalidFile(t *testing.T) {
	dir := t.TempDir()

	badCap := filepath.Join(dir, "badcap.json")
	if err := os.WriteFile(badCap, []byte(`{"not-a-cap":"local"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := router.LoadOverlay(badCap); err == nil {
		t.Fatal("expected error for unknown capability in file")
	}

	badProv := filepath.Join(dir, "badprov.json")
	if err := os.WriteFile(badProv, []byte(`{"cheap-classification":"borg"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := router.LoadOverlay(badProv); err == nil {
		t.Fatal("expected error for unknown provider in file")
	}

	malformed := filepath.Join(dir, "malformed.json")
	if err := os.WriteFile(malformed, []byte(`{not json`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := router.LoadOverlay(malformed); err == nil {
		t.Fatal("expected error for malformed JSON")
	}
}

// TestApplyOverlayFileMissingIsNoOp proves ApplyOverlayFile on a missing path is
// a no-op that leaves default routing intact.
func TestApplyOverlayFileMissingIsNoOp(t *testing.T) {
	r := router.NewRouter()
	path := filepath.Join(t.TempDir(), "does-not-exist.json")
	if err := r.ApplyOverlayFile(path); err != nil {
		t.Fatalf("ApplyOverlayFile(missing) error: %v", err)
	}
	got, _ := r.Resolve(router.CapCheapClassification)
	if got.Provider != "anthropic" {
		t.Fatalf("after no-op apply, provider = %q, want anthropic", got.Provider)
	}
}
