package tool_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/agix-ai/agix/core/tool"
)

// fnTool is a minimal Tool for exercising the registry: it carries its name and
// a fixed reply.
type fnTool struct {
	name  string
	reply string
}

func (f fnTool) Name() string                 { return f.name }
func (f fnTool) Description() string          { return f.name + " tool" }
func (f fnTool) InputSchema() json.RawMessage { return json.RawMessage(`{"type":"object"}`) }
func (f fnTool) Execute(context.Context, json.RawMessage) (string, error) {
	return f.reply, nil
}

func TestRegistryLookupAndList(t *testing.T) {
	reg, err := tool.New(fnTool{name: "echo", reply: "e"}, fnTool{name: "add", reply: "a"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if reg.Len() != 2 {
		t.Fatalf("Len = %d, want 2", reg.Len())
	}

	got, ok := reg.Lookup("add")
	if !ok {
		t.Fatal("Lookup(add) not found")
	}
	if got.Name() != "add" {
		t.Errorf("Lookup(add).Name() = %q, want add", got.Name())
	}
	if _, ok := reg.Lookup("missing"); ok {
		t.Error("Lookup(missing) should report not found")
	}

	// List preserves registration order (deterministic schema offering).
	names := []string{}
	for _, x := range reg.List() {
		names = append(names, x.Name())
	}
	if len(names) != 2 || names[0] != "echo" || names[1] != "add" {
		t.Errorf("List order = %v, want [echo add]", names)
	}
}

func TestRegistryRejectsDuplicateAndEmptyNames(t *testing.T) {
	if _, err := tool.New(fnTool{name: "dup"}, fnTool{name: "dup"}); err == nil {
		t.Error("New should reject a duplicate tool name")
	}
	if _, err := tool.New(fnTool{name: "  "}); err == nil {
		t.Error("New should reject an empty/whitespace tool name")
	}
	var reg tool.Registry
	if err := reg.Register(nil); err == nil {
		t.Error("Register(nil) should error")
	}
	// Zero-value registry is usable via Register (lazy map init).
	if err := reg.Register(fnTool{name: "ok"}); err != nil {
		t.Errorf("Register on zero-value registry: %v", err)
	}
	if reg.Len() != 1 {
		t.Errorf("Len = %d, want 1 after one Register", reg.Len())
	}
}
