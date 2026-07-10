// Command agix-kmbench measures the EFFICIENCY of candidate Agix knowledge-
// management data-store architectures on a synthetic, deterministic KM workload
// — at $0 (no model API; embeddings are model-free concept vectors). It is the
// efficiency companion to the [LOCAL] premise test that proved graph-traversal
// retrieval beats flat vector on relational/multi-hop queries.
//
//	agix-kmbench -n 10000 -k 10
//	agix-kmbench -scales 1000,10000,100000 -k 10 -out kmbench.json
//	agix-kmbench -n 10000 -json          # full JSON to stdout
//
// Two backends run behind one Store interface: a modernc.org/sqlite graph store
// (CGo-free, the recommended local primary) and an in-memory flat-vector
// baseline (the "typical flat vector RAG" control). Everything is CGo-free and
// builds with CGO_ENABLED=0.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/agix-ai/agix/core/kmstore"
)

// runRealistic runs the HONEST front-door retrieval comparison: hash-64 (the
// shipped $0 embedder) and hash-768 (a dimension control that isolates "is the
// problem just too-few dims?" from "is the problem no semantics?") always, plus
// the AGIX_EMBED-selected LOCAL embedder (nomic-embed-text via Ollama) when it is
// available. It answers the report's §3a question: does swapping the embedder
// make realistic KM retrieval actually work?
func runRealistic(realN int, seed uint32, k int, jsonOut bool, out string) {
	opt := kmstore.DefaultRealisticOptions()
	opt.N = realN
	opt.Seed = seed
	if k > 0 {
		opt.K = k
	}

	embs := []kmstore.Embedder{kmstore.NewHashEmbedder(64), kmstore.NewHashEmbedder(768)}
	envEmb, engaged := kmstore.NewEmbedderFromEnv()
	if engaged {
		fmt.Fprintf(os.Stderr, "agix-kmbench: local embedder engaged: %s (dim %d)\n", envEmb.Name(), envEmb.Dim())
		embs = append(embs, envEmb)
	} else {
		fmt.Fprintln(os.Stderr, "agix-kmbench: no local embedder engaged (AGIX_EMBED unset or nomic unavailable).")
		fmt.Fprintln(os.Stderr, "  to run the real arm at $0:  ollama pull nomic-embed-text && AGIX_EMBED=nomic agix-kmbench -realistic")
	}

	fmt.Fprintf(os.Stderr, "agix-kmbench: realistic front-door test  N=%d k=%d seed=%d  arms=%d\n", opt.N, opt.K, opt.Seed, len(embs))
	rep := kmstore.RunRealisticCompare(opt, embs...)

	outPath := out
	if outPath == "" {
		outPath = fmt.Sprintf("kmbench-realistic-%d.json", opt.N)
	}
	if f, err := os.Create(outPath); err == nil {
		_ = rep.WriteJSON(f)
		f.Close()
		fmt.Fprintf(os.Stderr, "wrote %s\n", outPath)
	}
	if jsonOut {
		_ = rep.WriteJSON(os.Stdout)
	}
	rep.WriteSummary(os.Stdout)
}

func main() {
	var (
		n           = flag.Int("n", 10000, "corpus size (single scale; ignored if -scales set)")
		scales      = flag.String("scales", "", "comma-separated scales to sweep, e.g. 1000,10000,100000")
		k           = flag.Int("k", 10, "retrieval cutoff (recall@k / top-k)")
		seed        = flag.Uint("seed", 1, "primary seed for efficiency metrics")
		recallSeeds = flag.String("recall-seeds", "1,2,3", "comma-separated seeds averaged for the recall headline")
		concLevels  = flag.String("conc-levels", "1,4,8,16", "writer=reader concurrency levels")
		concItems   = flag.Int("conc-items", 1000, "writer leaves added during the concurrency test")
		out         = flag.String("out", "", "write full JSON report to this file (default kmbench-<scales>.json)")
		jsonOut     = flag.Bool("json", false, "also print the full JSON report to stdout")
		realistic   = flag.Bool("realistic", false, "run the HONEST front-door retrieval test (fuzzy NL queries) comparing hash vs the AGIX_EMBED-selected local embedder")
		realN       = flag.Int("real-n", 320, "corpus size for -realistic (capped at the 320-combo vocabulary)")
	)
	flag.Parse()

	if *realistic {
		runRealistic(*realN, uint32(*seed), *k, *jsonOut, *out)
		return
	}

	opt := kmstore.DefaultOptions()
	opt.K = *k
	opt.PrimarySeed = uint32(*seed)
	opt.ConcItems = *concItems
	if s, err := parseInts(*scales); err != nil {
		fatal("bad -scales: %v", err)
	} else if len(s) > 0 {
		opt.Scales = s
	} else {
		opt.Scales = []int{*n}
	}
	if rs, err := parseUints(*recallSeeds); err != nil {
		fatal("bad -recall-seeds: %v", err)
	} else if len(rs) > 0 {
		opt.RecallSeeds = rs
	}
	if cl, err := parseInts(*concLevels); err != nil {
		fatal("bad -conc-levels: %v", err)
	} else if len(cl) > 0 {
		opt.ConcLevels = cl
	}

	fmt.Fprintf(os.Stderr, "agix-kmbench: scales=%v k=%d seed=%d … (this is [LOCAL] evidence)\n",
		opt.Scales, opt.K, opt.PrimarySeed)

	rep, err := kmstore.Run(opt)
	if err != nil {
		fatal("run: %v", err)
	}

	// Structured JSON to a file (always) and optionally to stdout.
	outPath := *out
	if outPath == "" {
		outPath = fmt.Sprintf("kmbench-%s.json", joinInts(opt.Scales, "_"))
	}
	f, err := os.Create(outPath)
	if err != nil {
		fatal("create %s: %v", outPath, err)
	}
	if err := rep.WriteJSON(f); err != nil {
		f.Close()
		fatal("write json: %v", err)
	}
	f.Close()
	fmt.Fprintf(os.Stderr, "wrote %s\n", outPath)

	if *jsonOut {
		_ = rep.WriteJSON(os.Stdout)
	}
	rep.WriteSummary(os.Stdout)
}

func parseInts(s string) ([]int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	var out []int
	for _, p := range strings.Split(s, ",") {
		v, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func parseUints(s string) ([]uint32, error) {
	ints, err := parseInts(s)
	if err != nil {
		return nil, err
	}
	out := make([]uint32, len(ints))
	for i, v := range ints {
		out[i] = uint32(v)
	}
	return out, nil
}

func joinInts(xs []int, sep string) string {
	parts := make([]string, len(xs))
	for i, x := range xs {
		parts[i] = strconv.Itoa(x)
	}
	return strings.Join(parts, sep)
}

func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "agix-kmbench: "+format+"\n", a...)
	os.Exit(1)
}
