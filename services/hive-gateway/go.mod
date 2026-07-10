module github.com/agix-ai/agix/services/hive-gateway

go 1.26.4

require (
	github.com/agix-ai/agix/core v0.0.0
	github.com/agix-ai/agix/services/go-common v0.0.0-00010101000000-000000000000
)

// go-common lives in this repo; the substrate is consumed by relative path
// (the no-duplication rule — hive-gateway carries no copies of the shared
// httpserve/auth/logging code, only this module has zero external deps).
replace github.com/agix-ai/agix/services/go-common => ../go-common

// The canonical cross-hive Envelope + Validate lives in core/apiary — the ONE
// source of truth both the sender (core) and this receiver import, so the wire
// shape can never drift. core/apiary is a stdlib-only leaf; the module-level
// require pulls core's go.mod into the graph but only the leaf package is
// compiled into this binary (no sqlite in the built gateway).
replace github.com/agix-ai/agix/core => ../../core
