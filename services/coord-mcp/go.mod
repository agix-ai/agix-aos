module github.com/agix-ai/agix/services/coord-mcp

go 1.26.4

require github.com/modelcontextprotocol/go-sdk v1.6.1

require (
	github.com/segmentio/asm v1.1.3 // indirect
	github.com/segmentio/encoding v0.5.4 // indirect
	github.com/yosida95/uritemplate/v3 v3.0.2 // indirect
	golang.org/x/oauth2 v0.35.0 // indirect
	golang.org/x/sys v0.41.0 // indirect
)

require (
	github.com/agix-ai/agix/services/go-common v0.0.0-00010101000000-000000000000
	github.com/google/jsonschema-go v0.4.3
)

// go-common lives in this repo; the substrate is consumed by relative path
// (the no-duplication rule: coord-mcp's own substrate copies were DELETED).
replace github.com/agix-ai/agix/services/go-common => ../go-common
