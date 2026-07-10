// km — the runtime CLI over the production provenance-gated KM store
// (core/kmstore). It lets the runtime, agents, and a human drive the hive's
// durable knowledge:
//
//	agix-core km put      --content "…" [--author A --verifier V --trust 0.9 --branch B --id X --ratified]
//	agix-core km link     --src X --type depends-on --dst Y [--author A --verifier V --trust 0.9]
//	agix-core km retrieve --query "…" [--k 5 --attested-only]
//	agix-core km traverse --seed X --type depends-on [--hops 2 --attested-only]
//	agix-core km reembed  [--dry-run --force]
//	agix-core km stats
//
// All subcommands take --db (default ~/.agix/km.db). Content/queries are turned
// into vectors by the env-selected embedder (kmstore.NewEmbedderFromEnv): the
// default is the deterministic, CGo-free, $0/offline hashing embedder (hash-64),
// so the store is drivable with no daemon; set AGIX_EMBED=nomic to use a local
// nomic-embed-text model via Ollama ($0, no key) for real semantic resolution.
// Production writes may also pass real embeddings through the kmstore API
// directly. Put and retrieve MUST use the same AGIX_EMBED for vectors to match.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/agix-ai/agix/core/kmstore"
)

const embedDim = 64

// embedText turns text into a vector using the env-selected embedder
// (AGIX_EMBED). It defaults to the frozen $0/offline hash-64 and degrades back to
// it on any transient embed error, so `km` never crashes or hangs on a missing
// daemon. A per-invocation single embedder keeps put/retrieve internally
// consistent; cross-command consistency is the operator's AGIX_EMBED to hold.
func embedText(text string) []float32 {
	emb, _ := kmstore.NewEmbedderFromEnv()
	v, err := emb.Embed(text)
	if err != nil {
		fmt.Fprintf(os.Stderr, "km: embed via %s failed, using hash-%d: %v\n", emb.Name(), embedDim, err)
		return kmstore.HashEmbed(text, embedDim)
	}
	return v
}

// verifierEnv names the comma-separated allowlist of principals authorized to
// ATTEST a write. It is the CLI's out-of-band roster seed: `km put --verifier X`
// only produces an attested leaf when X is listed here (or otherwise registered).
// This is what makes attestation non-forgeable — the --verifier flag alone
// cannot self-attest an unknown principal.
const verifierEnv = "AGIX_KM_VERIFIERS"

func cmdKM(args []string) int {
	if len(args) == 0 {
		kmUsage()
		return 2
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "put":
		return kmPut(rest)
	case "link":
		return kmLink(rest)
	case "retrieve":
		return kmRetrieve(rest)
	case "traverse":
		return kmTraverse(rest)
	case "cosign":
		return kmCosign(rest)
	case "reembed":
		return kmReembed(rest)
	case "stats":
		return kmStats(rest)
	case "help", "-h", "--help":
		kmUsage()
		return 0
	default:
		fmt.Fprintf(os.Stderr, "km: unknown subcommand %q\n\n", sub)
		kmUsage()
		return 2
	}
}

func kmUsage() {
	fmt.Fprint(os.Stderr, `agix-core km — the production provenance-gated KM store

usage:
  agix-core km put      --content "…" [--author A --verifier V --trust 0.9 --branch B --id X --ratified]
  agix-core km link     --src X --type depends-on --dst Y [--author A --verifier V --trust 0.9]
  agix-core km retrieve --query "…" [--k 5 --attested-only]
  agix-core km traverse --seed X --type depends-on [--hops 2 --attested-only]
  agix-core km cosign   --id X --verifier V [--trust 1.0]
  agix-core km reembed  [--dry-run --force]
  agix-core km stats

  all subcommands accept --db PATH (default ~/.agix/km.db)

provenance gate: a leaf is ATTESTED iff a verifier distinct from the author AND
on the attestation roster vouches with trust ≥ 0.35 (actor≠verifier).
--attested-only refuses un-attested knowledge. An attested leaf can only be
superseded by another attested write.

co-sign: a governed run whose verdict was LLM-judgment-only (no external oracle)
records its artifact UN-attested + pending_cosign; km cosign is the human
promotion into the corpus — the verifier V must be on the roster (AGIX_KM_VERIFIERS)
and distinct from the leaf's author, exactly like a write.

the roster is the allowlist of principals allowed to attest; seed it out of band
via AGIX_KM_VERIFIERS (comma-separated actor refs), e.g.
  AGIX_KM_VERIFIERS="agix/worker/verifier-1" agix-core km put --verifier agix/worker/verifier-1 ...
a --verifier NOT on the roster stores the write UN-attested (it cannot forge an
attestation), which is the governed-hive rule.

reembed: migrate EVERY stored vector (live + tombstoned leaves AND the
quarantine audit trail) to the env-selected embedder, in one transaction, with
provenance untouched. Run it when switching AGIX_EMBED (e.g. hash-64 →
nomic-768): a stored vector whose dimension differs from the query's is
silently invisible to retrieve, so the whole store must move together. If the
requested model degraded to the hash fallback, reembed refuses to proceed
unless --force. --dry-run reports row counts and dims without writing.
`)
}

func defaultDBPath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(".agix", "km.db")
	}
	return filepath.Join(home, ".agix", "km.db")
}

// openKM opens the store at the resolved --db path and seeds the attestation
// roster from AGIX_KM_VERIFIERS (comma-separated actor refs). Seeding the roster
// out of band from the write is what makes attestation non-forgeable: a bare
// `km put --verifier b` for an unlisted `b` stores UN-attested.
func openKM(path string) (*kmstore.KMStore, int) {
	st, err := kmstore.Open(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "km: open %s: %v\n", path, err)
		return nil, 1
	}
	if v := strings.TrimSpace(os.Getenv(verifierEnv)); v != "" {
		st.RegisterVerifier(strings.Split(v, ",")...)
	}
	return st, 0
}

func kmPut(args []string) int {
	fs := flag.NewFlagSet("km put", flag.ContinueOnError)
	db := fs.String("db", defaultDBPath(), "store file")
	content := fs.String("content", "", "leaf content (required)")
	id := fs.String("id", "", "leaf id (default: derived from content hash)")
	author := fs.String("author", "", "author actor")
	verifier := fs.String("verifier", "", "verifier actor (must differ from author to attest)")
	trust := fs.Float64("trust", 0, "verifier trust, 0..1")
	branch := fs.String("branch", "", "TOGAF branch")
	ratified := fs.Bool("ratified", false, "operator-ratified (Comb trunk bit)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *content == "" {
		fmt.Fprintln(os.Stderr, `km put: --content is required`)
		return 2
	}
	st, code := openKM(*db)
	if code != 0 {
		return code
	}
	defer st.Close()

	res, err := st.Put(kmstore.Leaf{
		ID: *id, Content: *content, Branch: *branch,
		Author: *author, Verifier: *verifier, TrustScore: *trust, Ratified: *ratified,
		Embedding: embedText(*content),
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "km put: %v\n", err)
		return 1
	}
	fmt.Printf("put: id=%s added=%t attested=%t quarantined=%t\n", res.ID, res.Added, res.Attested, res.Quarantined)
	fmt.Printf("     reason: %s\n", res.Reason)
	if res.Quarantined {
		return 3 // distinct non-zero so scripts can detect a shielded write
	}
	return 0
}

func kmLink(args []string) int {
	fs := flag.NewFlagSet("km link", flag.ContinueOnError)
	db := fs.String("db", defaultDBPath(), "store file")
	src := fs.String("src", "", "source leaf id (required)")
	typ := fs.String("type", "", "edge type, e.g. depends-on|cites|supersedes|refines (required)")
	dst := fs.String("dst", "", "destination leaf id (required)")
	author := fs.String("author", "", "author actor")
	verifier := fs.String("verifier", "", "verifier actor")
	trust := fs.Float64("trust", 0, "verifier trust, 0..1")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *src == "" || *typ == "" || *dst == "" {
		fmt.Fprintln(os.Stderr, `km link: --src, --type, and --dst are required`)
		return 2
	}
	st, code := openKM(*db)
	if code != 0 {
		return code
	}
	defer st.Close()

	if err := st.Link(*src, *typ, *dst, kmstore.Provenance{Author: *author, Verifier: *verifier, TrustScore: *trust}); err != nil {
		fmt.Fprintf(os.Stderr, "km link: %v\n", err)
		return 1
	}
	fmt.Printf("link: %s -[%s]-> %s\n", *src, *typ, *dst)
	return 0
}

func kmRetrieve(args []string) int {
	fs := flag.NewFlagSet("km retrieve", flag.ContinueOnError)
	db := fs.String("db", defaultDBPath(), "store file")
	query := fs.String("query", "", "query text (required)")
	k := fs.Int("k", 5, "number of hits")
	attestedOnly := fs.Bool("attested-only", false, "refuse un-attested knowledge")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *query == "" {
		fmt.Fprintln(os.Stderr, `km retrieve: --query is required`)
		return 2
	}
	st, code := openKM(*db)
	if code != 0 {
		return code
	}
	defer st.Close()

	hits, err := st.Retrieve(embedText(*query), *k, kmstore.RetrieveOpts{AttestedOnly: *attestedOnly})
	if err != nil {
		fmt.Fprintf(os.Stderr, "km retrieve: %v\n", err)
		return 1
	}
	fmt.Printf("retrieve: k=%d attested_only=%t  (%d hits)\n", *k, *attestedOnly, len(hits))
	for i, l := range hits {
		fmt.Printf("  %d. %s  branch=%s attested=%t  %q\n", i+1, l.ID, orDash(l.Branch), l.Attested, truncate(l.Content, 60))
	}
	return 0
}

func kmTraverse(args []string) int {
	fs := flag.NewFlagSet("km traverse", flag.ContinueOnError)
	db := fs.String("db", defaultDBPath(), "store file")
	seed := fs.String("seed", "", "seed leaf id (required)")
	typ := fs.String("type", "", "edge type to follow (required)")
	hops := fs.Int("hops", 1, "hops to follow")
	attestedOnly := fs.Bool("attested-only", false, "follow only attested edges + return only attested leaves")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *seed == "" || *typ == "" {
		fmt.Fprintln(os.Stderr, `km traverse: --seed and --type are required`)
		return 2
	}
	st, code := openKM(*db)
	if code != 0 {
		return code
	}
	defer st.Close()

	reached, err := st.Traverse(*seed, *typ, *hops, kmstore.TraverseOpts{AttestedOnly: *attestedOnly})
	if err != nil {
		fmt.Fprintf(os.Stderr, "km traverse: %v\n", err)
		return 1
	}
	fmt.Printf("traverse: %s -[%s]->  hops=%d attested_only=%t  (%d reached)\n", *seed, *typ, *hops, *attestedOnly, len(reached))
	for i, l := range reached {
		fmt.Printf("  %d. %s  attested=%t  %q\n", i+1, l.ID, l.Attested, truncate(l.Content, 60))
	}
	return 0
}

func kmStats(args []string) int {
	fs := flag.NewFlagSet("km stats", flag.ContinueOnError)
	db := fs.String("db", defaultDBPath(), "store file")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	st, code := openKM(*db)
	if code != 0 {
		return code
	}
	defer st.Close()

	s, err := st.Stats()
	if err != nil {
		fmt.Fprintf(os.Stderr, "km stats: %v\n", err)
		return 1
	}
	fmt.Printf("stats: %s\n", s.Path)
	fmt.Printf("  leaves=%d attested=%d ratified=%d pending_cosign=%d tombstoned=%d edges=%d quarantined=%d  trust_floor=%.2f\n",
		s.Leaves, s.Attested, s.Ratified, s.PendingCosign, s.Tombstoned, s.Edges, s.Quarantined, s.TrustFloor)
	return 0
}

// kmCosign is the human half of the attestation policy: promote a pending-cosign
// leaf (a governed run's judgment-only artifact, held out of the corpus) into the
// certified corpus by having a registered human verifier vouch for it. The
// verifier is honored only if on the roster (AGIX_KM_VERIFIERS) and distinct from
// the leaf's author — the same actor≠verifier gate a write passes, so a co-sign
// cannot forge attestation either.
func kmCosign(args []string) int {
	fs := flag.NewFlagSet("km cosign", flag.ContinueOnError)
	db := fs.String("db", defaultDBPath(), "store file")
	id := fs.String("id", "", "leaf id to co-sign (required)")
	verifier := fs.String("verifier", "", "human verifier actor (required; must be on the roster and ≠ author)")
	trust := fs.Float64("trust", 1.0, "co-signer trust, 0..1 (default 1.0 — a human vouch)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *id == "" || *verifier == "" {
		fmt.Fprintln(os.Stderr, `km cosign: --id and --verifier are required`)
		return 2
	}
	st, code := openKM(*db)
	if code != 0 {
		return code
	}
	defer st.Close()

	res, err := st.Cosign(*id, *verifier, *trust)
	if err != nil {
		fmt.Fprintf(os.Stderr, "km cosign: %v\n", err)
		return 1
	}
	fmt.Printf("cosign: id=%s attested=%t\n", res.ID, res.Attested)
	fmt.Printf("     reason: %s\n", res.Reason)
	if !res.Attested {
		return 3 // distinct non-zero so scripts can detect a refused co-sign
	}
	return 0
}

// kmReembed migrates every stored vector to the env-selected embedder
// (kmstore.ReembedAll): it re-derives each row's embedding from its OWN content
// and rewrites the BLOB in place — leaves (tombstoned included) and the
// quarantine audit trail together, one transaction, provenance untouched. This
// is the operator's move when the fleet's AGIX_EMBED changes: stored vectors
// whose dimension differs from a query's are silently skipped by retrieve, so
// after a switch (hash-64 → nomic-768) the entire history is invisible until
// re-embedded.
//
// SAFETY GATE: unlike put/retrieve, reembed does NOT silently accept the hash
// fallback when the operator asked for a real model. Migrating the whole corpus
// onto hash-64 because Ollama happened to be down would defeat the entire point
// of the migration — so a degraded embedder is a loud refusal unless --force.
// One embedder instance is held for the whole run (never the per-call degrading
// embedText), so a mid-run daemon hiccup is a rollback, not a mixed store.
func kmReembed(args []string) int {
	fs := flag.NewFlagSet("km reembed", flag.ContinueOnError)
	db := fs.String("db", defaultDBPath(), "store file")
	dryRun := fs.Bool("dry-run", false, "report what would change (row counts, dims) without writing")
	force := fs.Bool("force", false, "proceed even if the requested embedder degraded to the hash fallback")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	emb, engaged := kmstore.NewEmbedderFromEnv()
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("AGIX_EMBED")))
	fmt.Printf("reembed: embedder=%s engaged=%t (AGIX_EMBED=%q)\n", emb.Name(), engaged, mode)
	if requested := mode != "" && mode != "hash"; requested && !engaged {
		fmt.Fprintf(os.Stderr, "km reembed: WARNING — AGIX_EMBED=%q was requested but the embedder DEGRADED to %s.\n", mode, emb.Name())
		fmt.Fprintln(os.Stderr, "  Proceeding would migrate every stored vector onto the hash fallback, which is")
		fmt.Fprintln(os.Stderr, "  exactly what this migration exists to move away from.")
		if !*force {
			fmt.Fprintln(os.Stderr, "  Refusing to proceed. Fix the embedder (is `ollama serve` up with the model pulled?) or pass --force to migrate with the fallback anyway.")
			return 1
		}
		fmt.Fprintln(os.Stderr, "  --force passed: proceeding with the degraded embedder anyway.")
	}

	st, code := openKM(*db)
	if code != 0 {
		return code
	}
	defer st.Close()

	var (
		rep kmstore.ReembedReport
		err error
	)
	if *dryRun {
		rep, err = st.ReembedPlan(emb)
	} else {
		rep, err = st.ReembedAll(emb)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "km reembed: %v\n", err)
		return 1
	}
	if rep.DryRun {
		fmt.Printf("reembed (dry-run): would update leaves=%d quarantine=%d — nothing written\n", rep.LeavesUpdated, rep.QuarantineUpdated)
	} else {
		fmt.Printf("reembed: updated leaves=%d quarantine=%d\n", rep.LeavesUpdated, rep.QuarantineUpdated)
	}
	fmt.Printf("     dims: old %v -> new %d (embedder %s)\n", rep.OldDims, rep.NewDim, rep.Embedder)
	return 0
}

// ───────────────────────────── helpers ──────────────────────────────────────
//
// The text→vector embedder is now the shared kmstore.HashEmbed (frozen there),
// so `km put`/`km retrieve` and the swarm's Comb retriever produce byte-identical
// vectors — a fact written here is retrievable by a worker, and vice versa.

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
