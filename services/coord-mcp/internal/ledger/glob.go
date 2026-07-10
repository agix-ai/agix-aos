package ledger

import (
	"regexp"
	"strings"
	"sync"
)

// Glob semantics for coordination claims — the syntax an agent uses to claim a
// slice of the tree:
//
//   - `**`  matches any number of characters including `/` (any depth); a
//     trailing `/` after `**` is folded in, so `**/foo` matches `foo`,
//     `a/foo`, `a/b/foo`.
//   - `*`   matches any run of non-`/` characters.
//   - `?`   matches exactly one non-`/` character.
//   - a bare directory prefix (no wildcard) claims the whole subtree:
//     `apps/web` matches `apps/web` and everything under `apps/web/`.
//   - everything else is literal.

var (
	globCacheMu sync.Mutex
	globCache   = map[string]*regexp.Regexp{}
)

// globToRegex compiles a coordination glob to an anchored regexp (cached).
func globToRegex(glob string) *regexp.Regexp {
	globCacheMu.Lock()
	defer globCacheMu.Unlock()
	if re, ok := globCache[glob]; ok {
		return re
	}
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(glob); i++ {
		c := glob[i]
		switch {
		case c == '*':
			if i+1 < len(glob) && glob[i+1] == '*' {
				b.WriteString(".*")
				i++
				if i+1 < len(glob) && glob[i+1] == '/' {
					i++ // `**/` matches any depth incl. none
				}
			} else {
				b.WriteString("[^/]*")
			}
		case c == '?':
			b.WriteString("[^/]")
		case strings.ContainsRune(`.+^${}()|[]\`, rune(c)):
			b.WriteByte('\\')
			b.WriteByte(c)
		default:
			b.WriteByte(c)
		}
	}
	b.WriteString("$")
	re := regexp.MustCompile(b.String())
	globCache[glob] = re
	return re
}

// FileMatchesGlob reports whether file falls under a single claim glob.
func FileMatchesGlob(file, glob string) bool {
	g := strings.TrimSpace(glob)
	if g == "" {
		return false
	}
	// A bare directory prefix claims everything under it.
	prefix := g
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	if file == g || strings.HasPrefix(file, prefix) {
		return true
	}
	return globToRegex(g).MatchString(file)
}

// FileMatchesAnyGlob reports whether file falls under any of the globs.
func FileMatchesAnyGlob(file string, globs []string) bool {
	for _, g := range globs {
		if FileMatchesGlob(file, g) {
			return true
		}
	}
	return false
}

// leaseClaimMode returns how (if at all) a lease claims a file:
// ModeExclusive, ModeSharedAppend, or "" for not claimed. The lease's own
// excludes subtract FIRST — an excluded path is never claimed by this lease.
func leaseClaimMode(file string, l *Lease) ClaimMode {
	if len(l.Excludes) > 0 && FileMatchesAnyGlob(file, l.Excludes) {
		return ""
	}
	var shared bool
	for _, c := range l.Claims {
		if !FileMatchesGlob(file, c.Path) {
			continue
		}
		if c.Mode == ModeExclusive {
			return ModeExclusive // exclusive wins
		}
		shared = true
	}
	if shared {
		return ModeSharedAppend
	}
	return ""
}

// globsIntersect reports whether two claim GLOBS could cover a common file:
// compare the literal prefixes before the first wildcard — the globs intersect
// if one prefix is a prefix of the other. (A conservative approximation at
// claim time; the file-level checks are segment-exact.)
func globsIntersect(a, b string) bool {
	la := literalPrefix(a)
	lb := literalPrefix(b)
	return strings.HasPrefix(la, lb) || strings.HasPrefix(lb, la)
}

func literalPrefix(glob string) string {
	if i := strings.IndexAny(glob, "*?"); i >= 0 {
		return glob[:i]
	}
	return glob
}
