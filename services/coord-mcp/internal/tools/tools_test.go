package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/agix-ai/agix/services/coord-mcp/internal/ledger"
	"github.com/agix-ai/agix/services/go-common/auth"
)

// headerTransport injects auth + identity headers into every request, the way
// an agent's .mcp.json headers block would.
type headerTransport struct {
	base    http.RoundTripper
	headers map[string]string
}

func (h *headerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	for k, v := range h.headers {
		req.Header.Set(k, v)
	}
	return h.base.RoundTrip(req)
}

func newTestServer(t *testing.T) (*httptest.Server, auth.Keys) {
	t.Helper()
	store, err := ledger.NewStore(context.Background(), &ledger.MemorySnapshotter{})
	if err != nil {
		t.Fatal(err)
	}
	keys := auth.Keys{FleetKey: "fleet-secret", CoordinatorKey: "coord-secret"}
	server := NewServer(Config{Store: store, Keys: keys, Version: "test"})
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)
	mux := http.NewServeMux()
	mux.Handle("/mcp", auth.Middleware(keys, CoordHeaders, handler)) // same wiring as main.go
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, keys
}

func connect(t *testing.T, ts *httptest.Server, bearer, agent string) *mcp.ClientSession {
	t.Helper()
	client := mcp.NewClient(&mcp.Implementation{Name: "test-agent", Version: "0"}, nil)
	transport := &mcp.StreamableClientTransport{
		Endpoint: ts.URL + "/mcp",
		HTTPClient: &http.Client{Transport: &headerTransport{
			base: http.DefaultTransport,
			headers: map[string]string{
				"Authorization":    "Bearer " + bearer,
				CoordHeaders.Agent: agent,
			},
		}},
	}
	session, err := client.Connect(context.Background(), transport, nil)
	if err != nil {
		t.Fatalf("connect as %s: %v", agent, err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

// call invokes a tool and decodes its structured content into out.
func call(t *testing.T, s *mcp.ClientSession, tool string, args, out any) *mcp.CallToolResult {
	t.Helper()
	res, err := s.CallTool(context.Background(), &mcp.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		t.Fatalf("CallTool(%s): %v", tool, err)
	}
	if out != nil && !res.IsError {
		raw, err := json.Marshal(res.StructuredContent)
		if err != nil {
			t.Fatalf("marshal structured content: %v", err)
		}
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("decode %s structured content: %v", tool, err)
		}
	}
	return res
}

func textOf(res *mcp.CallToolResult) string {
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String()
}

// TestHTTPRoundTrip exercises the full agent flow over Streamable HTTP:
// claim → overlapping claim rejected → check_overlap → foreign release
// rejected → owner release → path clear → audit tail.
func TestHTTPRoundTrip(t *testing.T) {
	ts, _ := newTestServer(t)
	agentA := connect(t, ts, "fleet-secret", "agent-a")
	agentB := connect(t, ts, "fleet-secret", "agent-b")

	// the coordination tools are all registered
	list, err := agentA.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"claim_lease": true, "release_lease": true, "heartbeat": true,
		"list_leases": true, "check_overlap": true, "get_events": true}
	for _, tool := range list.Tools {
		delete(want, tool.Name)
		if tool.Description == "" {
			t.Errorf("tool %s missing a description", tool.Name)
		}
	}
	if len(want) != 0 {
		t.Fatalf("missing tools: %v", want)
	}

	// agent-a claims
	var claimed leaseResult
	res := call(t, agentA, "claim_lease", map[string]any{
		"branches": []string{"claude/lane-a"},
		"claims":   []map[string]any{{"path": "services/coord-mcp/**"}},
		"notes":    "building the thing",
	}, &claimed)
	if res.IsError {
		t.Fatalf("claim failed: %s", textOf(res))
	}
	if claimed.Lease.Agent != "agent-a" {
		t.Fatalf("claim attributed to %q, want agent-a (header identity)", claimed.Lease.Agent)
	}
	leaseID := claimed.Lease.ID

	// agent-b's overlapping claim is rejected (IsError, not a protocol error)
	res = call(t, agentB, "claim_lease", map[string]any{
		"branches": []string{"claude/lane-b"},
		"claims":   []map[string]any{{"path": "services/coord-mcp/README.md"}},
	}, nil)
	if !res.IsError || !strings.Contains(textOf(res), "overlaps active claims") {
		t.Fatalf("overlapping claim should be rejected, got: %s", textOf(res))
	}

	// check_overlap sees the conflict for agent-b…
	var check checkResult
	call(t, agentB, "check_overlap", map[string]any{
		"files": []string{"services/coord-mcp/DESIGN.md"},
	}, &check)
	if check.OK || len(check.Conflicts) != 1 || check.Conflicts[0].Agent != "agent-a" {
		t.Fatalf("check_overlap for agent-b: %+v", check)
	}
	// …and none for the owner
	call(t, agentA, "check_overlap", map[string]any{
		"files": []string{"services/coord-mcp/DESIGN.md"},
	}, &check)
	if !check.OK {
		t.Fatalf("owner must not conflict with itself: %+v", check)
	}

	// heartbeat by owner works; by another agent is refused
	res = call(t, agentA, "heartbeat", map[string]any{"leaseId": leaseID}, nil)
	if res.IsError {
		t.Fatalf("owner heartbeat: %s", textOf(res))
	}
	res = call(t, agentB, "heartbeat", map[string]any{"leaseId": leaseID}, nil)
	if !res.IsError {
		t.Fatal("foreign heartbeat must be refused")
	}

	// release by a NON-owner is refused (anti-self-unclaim)
	res = call(t, agentB, "release_lease", map[string]any{"leaseId": leaseID}, nil)
	if !res.IsError || !strings.Contains(textOf(res), "not the lease owner") {
		t.Fatalf("foreign release must be refused, got: %s", textOf(res))
	}

	// list shows the one active lease
	var lr listResult
	call(t, agentB, "list_leases", map[string]any{}, &lr)
	if lr.Count != 1 || lr.Leases[0].ID != leaseID {
		t.Fatalf("list_leases: %+v", lr)
	}

	// owner releases
	res = call(t, agentA, "release_lease", map[string]any{"leaseId": leaseID}, nil)
	if res.IsError {
		t.Fatalf("owner release: %s", textOf(res))
	}

	// now agent-b's claim goes through
	res = call(t, agentB, "claim_lease", map[string]any{
		"branches": []string{"claude/lane-b"},
		"claims":   []map[string]any{{"path": "services/coord-mcp/README.md"}},
	}, nil)
	if res.IsError {
		t.Fatalf("claim after release: %s", textOf(res))
	}

	// audit tail is append-only and complete
	var ev eventsResult
	call(t, agentA, "get_events", map[string]any{"tail": 10}, &ev)
	types := make([]string, len(ev.Events))
	for i, e := range ev.Events {
		types[i] = string(e.Type)
	}
	wantTypes := []string{"claimed", "heartbeat", "released", "claimed"}
	if len(types) != len(wantTypes) {
		t.Fatalf("event tail = %v, want %v", types, wantTypes)
	}
	for i := range wantTypes {
		if types[i] != wantTypes[i] {
			t.Fatalf("event tail = %v, want %v", types, wantTypes)
		}
	}
}

// TestCoordinatorCanReleaseForeignLease encodes the coordinator escape hatch:
// releases are never automatic, but an operator with the coordinator key can
// release a dead agent's lease — attributably.
func TestCoordinatorCanReleaseForeignLease(t *testing.T) {
	ts, _ := newTestServer(t)
	agentA := connect(t, ts, "fleet-secret", "agent-a")
	operator := connect(t, ts, "coord-secret", "ops")

	var claimed leaseResult
	res0 := call(t, agentA, "claim_lease", map[string]any{
		"branches": []string{"claude/lane-a"},
		"claims":   []map[string]any{{"path": "apps/never-merged/**"}},
	}, &claimed)
	if res0.IsError || claimed.Lease == nil {
		t.Fatalf("claim failed: %s", textOf(res0))
	}

	var released leaseResult
	res := call(t, operator, "release_lease", map[string]any{"leaseId": claimed.Lease.ID}, &released)
	if res.IsError {
		t.Fatalf("coordinator release: %s", textOf(res))
	}
	if released.Lease.ReleasedBy != "ops" {
		t.Fatalf("coordinator release must be attributed, got %+v", released.Lease)
	}
}

// TestUnauthenticatedRejected: no valid bearer key → the middleware 401s and
// no MCP session can even be established.
func TestUnauthenticatedRejected(t *testing.T) {
	ts, _ := newTestServer(t)
	client := mcp.NewClient(&mcp.Implementation{Name: "rogue", Version: "0"}, nil)
	transport := &mcp.StreamableClientTransport{Endpoint: ts.URL + "/mcp"}
	if _, err := client.Connect(context.Background(), transport, nil); err == nil {
		t.Fatal("connect without a bearer key must fail")
	}
	transport = &mcp.StreamableClientTransport{
		Endpoint: ts.URL + "/mcp",
		HTTPClient: &http.Client{Transport: &headerTransport{
			base:    http.DefaultTransport,
			headers: map[string]string{"Authorization": "Bearer wrong-key"},
		}},
	}
	if _, err := client.Connect(context.Background(), transport, nil); err == nil {
		t.Fatal("connect with a wrong bearer key must fail")
	}
}

// TestMissingAgentIdentity: a valid key but no X-Coord-Agent header can read
// but cannot claim (identity attributes every write).
func TestMissingAgentIdentity(t *testing.T) {
	ts, _ := newTestServer(t)
	anon := connect(t, ts, "fleet-secret", "")
	res := call(t, anon, "claim_lease", map[string]any{
		"branches": []string{"b"},
		"claims":   []map[string]any{{"path": "x/**"}},
	}, nil)
	if !res.IsError || !strings.Contains(textOf(res), "agent identity required") {
		t.Fatalf("claim without identity must be refused, got: %s", textOf(res))
	}
	var lr listResult
	if res := call(t, anon, "list_leases", map[string]any{}, &lr); res.IsError {
		t.Fatalf("reads should work without identity: %s", textOf(res))
	}
}

// TestCheckOverlapAgentOverride: the effective agent for conflict exclusion is
// ALWAYS the authenticated identity — a non-coordinator passing agent=<owner>
// must NOT get a false "no overlap" on the owner's files. The coordinator key
// may check on another agent's behalf.
func TestCheckOverlapAgentOverride(t *testing.T) {
	ts, _ := newTestServer(t)
	agentA := connect(t, ts, "fleet-secret", "agent-a")
	agentB := connect(t, ts, "fleet-secret", "agent-b")
	operator := connect(t, ts, "coord-secret", "ops")

	res := call(t, agentA, "claim_lease", map[string]any{
		"branches": []string{"claude/lane-a"},
		"claims":   []map[string]any{{"path": "apps/api/**"}},
	}, nil)
	if res.IsError {
		t.Fatalf("claim: %s", textOf(res))
	}

	// agent-b spoofing agent=agent-a still sees agent-a's claims as conflicts
	var check checkResult
	res = call(t, agentB, "check_overlap", map[string]any{
		"files": []string{"apps/api/src/index.ts"},
		"agent": "agent-a",
	}, &check)
	if res.IsError {
		t.Fatalf("check_overlap: %s", textOf(res))
	}
	if check.OK || len(check.Conflicts) != 1 || check.Conflicts[0].Agent != "agent-a" {
		t.Fatalf("spoofed agent override must be ignored (conflicts still reported), got %+v", check)
	}
	if !strings.Contains(check.Message, "ignored") {
		t.Fatalf("ignored override should be called out in the message, got %q", check.Message)
	}

	// the coordinator MAY check on agent-a's behalf (owner's own files clear)
	res = call(t, operator, "check_overlap", map[string]any{
		"files": []string{"apps/api/src/index.ts"},
		"agent": "agent-a",
	}, &check)
	if res.IsError {
		t.Fatalf("coordinator check_overlap: %s", textOf(res))
	}
	if !check.OK {
		t.Fatalf("coordinator on-behalf check must honor the override, got %+v", check)
	}
}
