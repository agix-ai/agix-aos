// Package tools registers the comb-mcp MCP tools over the provenance-gated
// kmstore graph — the Comb (the hive's durable "honey"), exposed so any
// MCP-speaking agent (Claude Code, Cursor, the Agix fleet) can write, link,
// retrieve, and traverse governed knowledge as tools.
//
// The load-bearing rule mirrors the store and the `agix-core km` CLI exactly:
// a leaf is ATTESTED — and so retrievable under the governed read — only when a
// verifier DISTINCT from the author, and REGISTERED on the attestation roster,
// vouches with trust ≥ the floor (actor≠verifier). Retrieval and traversal are
// attested-only BY DEFAULT here; un-attested knowledge is opt-in and every leaf
// carries its own `attested` bit, so nothing un-vouched is ever returned as
// attested. This boundary adds no bypass of that gate.
//
// Provenance (author/verifier/trust) travels in the TOOL ARGUMENTS, exactly as
// the `km` CLI carries `--author/--verifier/--trust`. Transport auth (the HTTP
// bearer key) gates ACCESS to the server; it does not set a write's provenance.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package tools

import (
	"context"
	"errors"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/agix-ai/agix/core/kmstore"
	"github.com/agix-ai/agix/services/go-common/auth"
)

// DefaultDim is the embedding dimension used when none is configured. It MUST
// match the dim `agix-core km` writes/reads with (km.go's embedDim = 64) so a
// fact written by the CLI is retrievable via this server and vice versa — the
// two produce byte-identical HashEmbed vectors only at the same dim.
const DefaultDim = 64

// CombHeaders is comb-mcp's wire contract for the shared-key access gate. The
// agent header is read for attribution/logging; write PROVENANCE is carried in
// the tool arguments, not this header.
var CombHeaders = auth.Headers{Key: "X-Comb-Key", Agent: "X-Comb-Agent"}

// Instructions is the server-level guidance surfaced to MCP clients.
const Instructions = `agix-comb-mcp — the Comb: the hive's provenance-gated knowledge graph.

Write knowledge with comb.put, connect it with comb.link (typed edges), recall
it with comb.retrieve (semantic top-k) and comb.traverse (follow edges), and
inspect the store with comb.stats.

THE ATTESTATION GATE (non-negotiable): a leaf becomes "attested" only when a
verifier DISTINCT from the author, and REGISTERED on the store's roster, vouches
with trust ≥ the floor (actor≠verifier — no self-attestation, and an arbitrary
verifier string cannot forge one). comb.retrieve and comb.traverse return ONLY
attested, non-tombstoned knowledge by default; pass includeUnattested:true to
also see un-vouched leaves (each carries an "attested" bit — un-vouched knowledge
is never returned AS attested). An un-attested write that contradicts an existing
attested leaf is QUARANTINED to the audit trail, never destructively applied.

Provenance travels in the tool arguments (author/verifier/trust), like the
agix-core km CLI. Embeddings are computed with the frozen HashEmbed at the
server's fixed dimension, so writes and queries always align.`

// Config wires the tool handlers to a Comb store.
type Config struct {
	// Store is the durable provenance-gated graph KM store (the Comb).
	Store *kmstore.KMStore
	// Dim is the embedding dimension for HashEmbed. If <= 0, DefaultDim is used.
	// It MUST be constant for the life of a store: writes and queries only align
	// at the same dim (the store skips any candidate whose dim differs).
	Dim     int
	Version string
}

type service struct {
	store *kmstore.KMStore
	dim   int
}

// NewServer builds the MCP server with all Comb tools registered. The store is
// goroutine-safe (a *sql.DB pool in WAL mode + a mutex-guarded verifier roster),
// so concurrent tool calls over HTTP need no additional locking here.
func NewServer(cfg Config) *mcp.Server {
	dim := cfg.Dim
	if dim <= 0 {
		dim = DefaultDim
	}
	s := &service{store: cfg.Store, dim: dim}

	srv := mcp.NewServer(
		&mcp.Implementation{Name: "agix-comb-mcp", Title: "Agix Comb knowledge graph", Version: cfg.Version},
		&mcp.ServerOptions{Instructions: Instructions},
	)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "comb.put",
		Description: "Write a knowledge leaf into the Comb. Content is embedded with the frozen HashEmbed. " +
			"The leaf is ATTESTED only if a registered verifier DISTINCT from the author vouches with trust ≥ the " +
			"floor (actor≠verifier); otherwise it is stored un-attested (not rejected). An un-attested write that " +
			"contradicts an existing attested leaf is QUARANTINED to the audit trail and does NOT overwrite it. " +
			"Identical content dedupes to one id.",
	}, s.put)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "comb.link",
		Description: "Assert a typed edge src -[type]-> dst (e.g. depends-on|cites|supersedes|refines), carrying its " +
			"own provenance. The edge is attested by the same actor≠verifier rule as leaves; attested-only traversal " +
			"follows only attested edges.",
	}, s.link)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "comb.retrieve",
		Description: "Semantic top-k recall over the Comb. GOVERNED read: returns only attested, non-tombstoned leaves " +
			"by default. Pass includeUnattested:true to also surface un-vouched leaves (each result carries an " +
			"`attested` bit — un-vouched knowledge is never returned as attested).",
	}, s.retrieve)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "comb.traverse",
		Description: "Follow typed edges from a seed leaf for N hops, breadth-first (seed excluded). GOVERNED walk: " +
			"follows only attested edges and returns only attested leaves by default; includeUnattested:true widens it.",
	}, s.traverse)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "comb.stats",
		Description: "Snapshot the Comb: live/attested/ratified/tombstoned leaf counts, edge count, quarantine size, and the governing trust floor.",
	}, s.stats)

	return srv
}

// leafView is the JSON-friendly projection of a leaf returned to clients. The
// embedding vector is deliberately omitted (large, noisy); the `attested` bit is
// always present so a caller can never mistake un-vouched knowledge for vouched.
type leafView struct {
	ID         string  `json:"id"`
	Content    string  `json:"content"`
	Branch     string  `json:"branch,omitempty"`
	Author     string  `json:"author,omitempty"`
	Verifier   string  `json:"verifier,omitempty"`
	Attested   bool    `json:"attested"`
	Ratified   bool    `json:"ratified"`
	TrustScore float64 `json:"trustScore,omitempty"`
	CreatedAt  int64   `json:"createdAt,omitempty"`
}

func toLeafView(l kmstore.Leaf) leafView {
	return leafView{
		ID: l.ID, Content: l.Content, Branch: l.Branch,
		Author: l.Author, Verifier: l.Verifier,
		Attested: l.Attested, Ratified: l.Ratified,
		TrustScore: l.TrustScore, CreatedAt: l.CreatedAt,
	}
}

// ── comb.put ─────────────────────────────────────────────────────────────

type putArgs struct {
	Content  string  `json:"content" jsonschema:"leaf content / knowledge to write (required)"`
	ID       string  `json:"id,omitempty" jsonschema:"leaf id; default derived from a content hash (identical content dedupes, a reused id with new content is a detectable collision)"`
	Author   string  `json:"author,omitempty" jsonschema:"actor asserting this knowledge"`
	Verifier string  `json:"verifier,omitempty" jsonschema:"actor attesting it; MUST differ from author AND be a registered verifier to attest"`
	Trust    float64 `json:"trust,omitempty" jsonschema:"verifier confidence 0..1; must clear the trust floor to attest"`
	Branch   string  `json:"branch,omitempty" jsonschema:"TOGAF branch this leaf belongs to"`
	Ratified bool    `json:"ratified,omitempty" jsonschema:"operator-ratified (the Comb trunk-merge bit)"`
}

// putResult mirrors kmstore.PutResult with a human-readable message.
type putResult struct {
	kmstore.PutResult
	Message string `json:"message"`
}

func (s *service) put(_ context.Context, _ *mcp.CallToolRequest, in putArgs) (*mcp.CallToolResult, putResult, error) {
	if in.Content == "" {
		return nil, putResult{}, errors.New("comb.put: content is required")
	}
	res, err := s.store.Put(kmstore.Leaf{
		ID: in.ID, Content: in.Content, Branch: in.Branch,
		Author: in.Author, Verifier: in.Verifier, TrustScore: in.Trust, Ratified: in.Ratified,
		Embedding: kmstore.HashEmbed(in.Content, s.dim),
	})
	if err != nil {
		return nil, putResult{}, fmt.Errorf("comb.put: %w", err)
	}
	verb := "wrote un-attested"
	switch {
	case res.Quarantined:
		verb = "QUARANTINED (shield: un-attested write contradicts attested leaf)"
	case res.Attested:
		verb = "wrote attested"
	}
	return nil, putResult{PutResult: res, Message: fmt.Sprintf("%s leaf %s", verb, res.ID)}, nil
}

// ── comb.link ────────────────────────────────────────────────────────────

type linkArgs struct {
	Src      string  `json:"src" jsonschema:"source leaf id (required)"`
	Type     string  `json:"type" jsonschema:"edge type, e.g. depends-on|cites|supersedes|refines (required)"`
	Dst      string  `json:"dst" jsonschema:"destination leaf id (required)"`
	Author   string  `json:"author,omitempty" jsonschema:"actor asserting the edge"`
	Verifier string  `json:"verifier,omitempty" jsonschema:"actor attesting the edge; must differ from author and be registered to attest"`
	Trust    float64 `json:"trust,omitempty" jsonschema:"verifier confidence 0..1"`
}

type linkResult struct {
	Src     string `json:"src"`
	Type    string `json:"type"`
	Dst     string `json:"dst"`
	Message string `json:"message"`
}

func (s *service) link(_ context.Context, _ *mcp.CallToolRequest, in linkArgs) (*mcp.CallToolResult, linkResult, error) {
	if in.Src == "" || in.Type == "" || in.Dst == "" {
		return nil, linkResult{}, errors.New("comb.link: src, type, and dst are required")
	}
	if err := s.store.Link(in.Src, in.Type, in.Dst, kmstore.Provenance{
		Author: in.Author, Verifier: in.Verifier, TrustScore: in.Trust,
	}); err != nil {
		return nil, linkResult{}, fmt.Errorf("comb.link: %w", err)
	}
	return nil, linkResult{
		Src: in.Src, Type: in.Type, Dst: in.Dst,
		Message: fmt.Sprintf("linked %s -[%s]-> %s", in.Src, in.Type, in.Dst),
	}, nil
}

// ── comb.retrieve ────────────────────────────────────────────────────────

type retrieveArgs struct {
	Query string `json:"query" jsonschema:"query text; embedded and matched by cosine similarity (required)"`
	K     int    `json:"k,omitempty" jsonschema:"max hits to return (default 5)"`
	// IncludeUnattested inverts the governed default: leave it false (the default)
	// for the attested-only read; set true to ALSO surface un-vouched leaves.
	IncludeUnattested bool `json:"includeUnattested,omitempty" jsonschema:"also return un-attested leaves (default false = attested-only, the governed read)"`
}

type retrieveResult struct {
	Count        int        `json:"count"`
	AttestedOnly bool       `json:"attestedOnly"`
	Hits         []leafView `json:"hits"`
}

func (s *service) retrieve(_ context.Context, _ *mcp.CallToolRequest, in retrieveArgs) (*mcp.CallToolResult, retrieveResult, error) {
	if in.Query == "" {
		return nil, retrieveResult{}, errors.New("comb.retrieve: query is required")
	}
	k := in.K
	if k <= 0 {
		k = 5
	}
	attestedOnly := !in.IncludeUnattested
	hits, err := s.store.Retrieve(kmstore.HashEmbed(in.Query, s.dim), k, kmstore.RetrieveOpts{AttestedOnly: attestedOnly})
	if err != nil {
		return nil, retrieveResult{}, fmt.Errorf("comb.retrieve: %w", err)
	}
	views := make([]leafView, len(hits))
	for i, l := range hits {
		views[i] = toLeafView(l)
	}
	return nil, retrieveResult{Count: len(views), AttestedOnly: attestedOnly, Hits: views}, nil
}

// ── comb.traverse ────────────────────────────────────────────────────────

type traverseArgs struct {
	Seed              string `json:"seed" jsonschema:"seed leaf id to walk from (required)"`
	Type              string `json:"type" jsonschema:"edge type to follow (required)"`
	Hops              int    `json:"hops,omitempty" jsonschema:"hops to follow (default 1)"`
	IncludeUnattested bool   `json:"includeUnattested,omitempty" jsonschema:"also follow un-attested edges and return un-attested leaves (default false = governed walk)"`
}

type traverseResult struct {
	Count        int        `json:"count"`
	AttestedOnly bool       `json:"attestedOnly"`
	Reached      []leafView `json:"reached"`
}

func (s *service) traverse(_ context.Context, _ *mcp.CallToolRequest, in traverseArgs) (*mcp.CallToolResult, traverseResult, error) {
	if in.Seed == "" || in.Type == "" {
		return nil, traverseResult{}, errors.New("comb.traverse: seed and type are required")
	}
	hops := in.Hops
	if hops <= 0 {
		hops = 1
	}
	attestedOnly := !in.IncludeUnattested
	reached, err := s.store.Traverse(in.Seed, in.Type, hops, kmstore.TraverseOpts{AttestedOnly: attestedOnly})
	if err != nil {
		return nil, traverseResult{}, fmt.Errorf("comb.traverse: %w", err)
	}
	views := make([]leafView, len(reached))
	for i, l := range reached {
		views[i] = toLeafView(l)
	}
	return nil, traverseResult{Count: len(views), AttestedOnly: attestedOnly, Reached: views}, nil
}

// ── comb.stats ───────────────────────────────────────────────────────────

type statsArgs struct{}

func (s *service) stats(_ context.Context, _ *mcp.CallToolRequest, _ statsArgs) (*mcp.CallToolResult, kmstore.Stats, error) {
	st, err := s.store.Stats()
	if err != nil {
		return nil, kmstore.Stats{}, fmt.Errorf("comb.stats: %w", err)
	}
	return nil, st, nil
}
