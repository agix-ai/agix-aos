package ledger

import "testing"

// Fixture table for the coordination glob syntax: `**` any depth (with `**/`
// folding), `*` non-slash, `?` single non-slash char, bare dir prefix = whole
// subtree, regex metacharacters treated literally.
func TestFileMatchesGlob(t *testing.T) {
	tests := []struct {
		name string
		file string
		glob string
		want bool
	}{
		// bare directory prefix claims the whole subtree
		{"bare dir claims child", "apps/web/src/app.tsx", "apps/web", true},
		{"bare dir claims deep child", "apps/web/src/routes/post.tsx", "apps/web", true},
		{"bare dir matches itself", "apps/web", "apps/web", true},
		{"bare dir does not claim sibling prefix", "apps/webhooks/index.ts", "apps/web", false},
		{"trailing slash dir", "apps/web/src/app.tsx", "apps/web/", true},

		// `*` matches within one segment only
		{"star same dir", "apps/web/src/a.ts", "apps/web/src/*.ts", true},
		{"star not across dirs", "apps/web/src/sub/a.ts", "apps/web/src/*.ts", false},
		{"star respects extension", "apps/web/src/a.tsx", "apps/web/src/*.ts", false},
		{"star at root", "README.md", "*.md", true},
		{"root star not nested", "docs/a.md", "*.md", false},

		// `**` matches any depth
		{"doublestar deep", "apps/api/src/routes/mcp.ts", "apps/api/**", true},
		{"doublestar shallow", "apps/api/x.ts", "apps/api/**", true},
		{"doublestar not the bare dir itself", "apps", "apps/**", false},
		{"doublestar other tree", "packages/db/x.ts", "apps/api/**", false},

		// `**/` matches any depth INCLUDING none (the trailing slash folds in)
		{"leading doublestar zero depth", "foo.ts", "**/foo.ts", true},
		{"leading doublestar one deep", "a/foo.ts", "**/foo.ts", true},
		{"leading doublestar two deep", "a/b/foo.ts", "**/foo.ts", true},
		// `**/` compiles to `.*`, so a same-segment suffix also matches.
		{"leading doublestar suffix", "xfoo.ts", "**/foo.ts", true},

		// mid-pattern `**`
		{"mid doublestar", "services/coord-mcp/internal/ledger/store.go", "services/**/*.go", true},

		// literals + regex metacharacters escaped
		{"exact file", "docs/coordination/active-work.md", "docs/coordination/active-work.md", true},
		{"dot is literal", "apps/api/srcXfile.ts", "apps/api/src.file.ts", false},
		{"plus is literal", "a+b.ts", "a+b.ts", true},

		// `?` single non-slash char
		{"question one char", "abc.ts", "a?c.ts", true},
		{"question not slash", "a/c.ts", "a?c.ts", false},
		{"question exactly one", "abbc.ts", "a?c.ts", false},

		{"empty glob never matches", "a.ts", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := FileMatchesGlob(tt.file, tt.glob); got != tt.want {
				t.Errorf("FileMatchesGlob(%q, %q) = %v, want %v", tt.file, tt.glob, got, tt.want)
			}
		})
	}
}

// Two globs intersect if one's literal prefix (before the first wildcard) is a
// prefix of the other's.
func TestGlobsIntersect(t *testing.T) {
	tests := []struct {
		a, b string
		want bool
	}{
		{"apps/web/**", "apps/web/src/a.ts", true},
		{"apps/web/src/a.ts", "apps/web/**", true},
		{"apps/web/**", "apps/api/**", false},
		{"apps", "apps/web/x.ts", true},
		{"**", "anything/at/all.ts", true}, // empty literal prefix intersects everything
		{"packages/db/*.ts", "packages/db/migrations/0001.sql", true},
		{"services/coord-mcp/**", "scripts/deploy.sh", false},
		{"a?c.ts", "abc.ts", true}, // `?` starts the wildcard boundary
	}
	for _, tt := range tests {
		if got := globsIntersect(tt.a, tt.b); got != tt.want {
			t.Errorf("globsIntersect(%q, %q) = %v, want %v", tt.a, tt.b, got, tt.want)
		}
	}
}

// excludes subtract FIRST, exclusive beats shared-append.
func TestLeaseClaimMode(t *testing.T) {
	lease := &Lease{
		Claims: []Claim{
			{Path: "apps/api/**", Mode: ModeExclusive},
			{Path: "docs/coordination/active-work.md", Mode: ModeSharedAppend},
		},
		Excludes: []string{"apps/api/src/routes/mcp.ts"},
	}
	tests := []struct {
		file string
		want ClaimMode
	}{
		{"apps/api/src/index.ts", ModeExclusive},
		{"apps/api/src/routes/mcp.ts", ""}, // excluded — never claimed by this lease
		{"docs/coordination/active-work.md", ModeSharedAppend},
		{"apps/web/src/app.tsx", ""},
	}
	for _, tt := range tests {
		if got := leaseClaimMode(tt.file, lease); got != tt.want {
			t.Errorf("leaseClaimMode(%q) = %q, want %q", tt.file, got, tt.want)
		}
	}
}
