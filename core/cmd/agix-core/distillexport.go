// The distill-export verb: read the hive's verifier-certified record out of the
// Comb and write a local-model distillation corpus (mlx-lm chat JSONL, split by
// codebase). This is the runnable front door to core/distill — the flywheel's
// read side (packs/refactor/SPEC.md §4). The nightly LoRA shift calls this to
// train the nucleus on the hive's OWN certified work instead of a synthetic oracle.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/agix-ai/agix/core/comb"
	"github.com/agix-ai/agix/core/distill"
)

func cmdDistillExport(args []string) int {
	fs := flag.NewFlagSet("distill-export", flag.ContinueOnError)
	db := fs.String("db", defaultDBPath(), "Comb store file")
	branch := fs.String("branch", "software", "TOGAF branch to export (\"\" = all attested)")
	out := fs.String("out", "research/llm-training/lora/data-refactor", "output dir for {train,valid,test}.jsonl")
	minTrust := fs.Float64("min-trust", 0.9, "drop certified leaves below this verifier trust (0.9 = APPROVE tier)")
	fracValid := fs.Float64("frac-valid", 0.12, "fraction of codebases held out for validation")
	fracTest := fs.Float64("frac-test", 0.12, "fraction of codebases held out for test")
	seed := fs.Int64("seed", 7, "RNG seed for the deterministic by-codebase split")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	st, code := openKM(*db)
	if code != 0 {
		return code
	}
	defer st.Close()

	// CertifiedLeaves = attested-only enumeration (actor≠verifier, trust ≥ floor).
	// Attestation is the clean-corpus filter: only vouched knowledge trains the nucleus.
	leaves, err := comb.New(st).CertifiedLeaves(*branch)
	if err != nil {
		fmt.Fprintf(os.Stderr, "distill-export: read certified leaves: %v\n", err)
		return 1
	}

	stats, err := distill.Export(leaves, distill.Options{
		OutDir:    *out,
		MinTrust:  *minTrust,
		FracValid: *fracValid,
		FracTest:  *fracTest,
		Seed:      *seed,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "distill-export: %v\n", err)
		return 1
	}

	fmt.Printf("distill-export: branch=%q  certified_leaves=%d  examples=%d (skipped %d)  codebases=%d\n",
		*branch, stats.LeavesIn, stats.Examples, stats.Skipped, stats.Codebases)
	fmt.Printf("  split (whole-codebase holdout) -> train:%d  valid:%d  test:%d\n", stats.Train, stats.Valid, stats.Test)
	fmt.Printf("  wrote -> %s/{train,valid,test}.jsonl\n", *out)
	if stats.Examples == 0 {
		fmt.Fprintln(os.Stderr, "  note: no certified refactorings on this branch yet — run the refactor pack against a target first")
	}
	return 0
}
