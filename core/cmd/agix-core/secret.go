// secret — the guard-bee CLI surface. It exposes ONLY non-revealing operations:
//
//	agix secret check <ref>   presence probe → PRESENT (backend=…) | ABSENT
//	agix secret scan  <file>  run the egress scanner over a file, redacted
//
// There is deliberately no `secret get` that prints a raw value — the guard bee
// never casually exposes secrets. `check` resolves through the configured Vault
// (AGIX_SECRET_BACKEND) but prints only whether the value is present, never the
// value itself.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/agix-ai/agix/core/secrets"
)

func cmdSecret(args []string) int {
	if len(args) == 0 {
		secretUsage()
		return 2
	}
	switch sub, rest := args[0], args[1:]; sub {
	case "check":
		return secretCheck(rest)
	case "scan":
		return secretScan(rest)
	case "help", "-h", "--help":
		secretUsage()
		return 0
	default:
		fmt.Fprintf(os.Stderr, "secret: unknown subcommand %q\n\n", sub)
		secretUsage()
		return 2
	}
}

func secretUsage() {
	fmt.Fprint(os.Stderr, `agix secret — the guard bee (least-privilege secret access)

usage:
  agix secret check <ref>    presence probe (never prints the value)
  agix secret scan  <file>   egress-scan a file for secret shapes (redacted)

backend selection (env):
  AGIX_SECRET_BACKEND = keychain (default) | env
`)
}

// secretCheck resolves a ref through the Vault and reports PRESENT/ABSENT only.
func secretCheck(args []string) int {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "secret check: need a ref, e.g. agix secret check anthropic-api-key")
		return 2
	}
	vault, err := secrets.NewVault()
	if err != nil {
		fmt.Fprintf(os.Stderr, "secret check: %v\n", err)
		return 2
	}
	ref := secrets.Ref(args[0])
	val, err := vault.Resolve(context.Background(), ref)
	if err != nil {
		fmt.Printf("ABSENT (backend=%s)\n", vault.Source())
		return 1
	}
	present := val != ""
	if !present {
		fmt.Printf("ABSENT (backend=%s)\n", vault.Source())
		return 1
	}
	fmt.Printf("PRESENT (backend=%s)\n", vault.Source())
	return 0
}

// secretScan runs the egress scanner over a file and prints findings (kind +
// offsets) plus a redacted preview. It never prints a matched secret.
func secretScan(args []string) int {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "secret scan: need a file path")
		return 2
	}
	data, err := os.ReadFile(args[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "secret scan: %v\n", err)
		return 1
	}
	sc := secrets.NewEgressScanner()
	findings := sc.Scan(string(data))
	noun := "findings"
	if len(findings) == 1 {
		noun = "finding"
	}
	fmt.Printf("scan: %s  (%d %s)\n", args[0], len(findings), noun)
	for i, f := range findings {
		fmt.Printf("  %d. %-18s bytes %d-%d\n", i+1, f.Kind, f.Start, f.End)
	}
	if len(findings) > 0 {
		fmt.Println("redacted preview:")
		fmt.Println(sc.Redact(string(data)))
		return 3 // distinct non-zero so a pre-egress hook can block on findings
	}
	return 0
}
