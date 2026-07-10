// html — the HTML-Comb artifact emitter. It renders a Comb subgraph (leaves +
// edges) and, optionally, provenance traces into a SINGLE self-contained HTML
// file: inline CSS, zero external assets (no CDNs, no web fonts, no remote
// images), so it satisfies "HTML = ratified artifact" and can be dropped into
// GCS / opened offline. This closes the gap where Comb artifacts were previously
// Node-only. First cut: a legible table + node/edge list + a provenance chain
// view — no force-directed graphics (flagged as a follow-up).
//
// Palette is Sumi & Kin (washi paper, sumi ink, kin gold), theme-aware via
// prefers-color-scheme. Every dynamic string is HTML-escaped; nothing in the
// document references http:// or https://.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package comb

import (
	"html"
	"io"
	"strconv"
	"strings"

	"github.com/agix-ai/agix/core/kmstore"
)

// RenderEdge is a typed edge to draw, with its attestation state.
type RenderEdge struct {
	Src      string
	Type     string
	Dst      string
	Attested bool
}

// RenderOpts is the input to the HTML emitter. All fields are optional; an empty
// opts still renders a valid (if sparse) document.
type RenderOpts struct {
	Title  string         // document title (default "Comb artifact")
	Leaves []kmstore.Leaf // nodes to render, with their provenance state
	Edges  []RenderEdge   // typed edges to render
	Traces []Trace        // provenance / bee-trace chains to render
	Stats  *kmstore.Stats // summary header; nil → auto-filled from the store when available
}

// RenderHTMLString renders the artifact to a string.
func (c *Comb) RenderHTMLString(opts RenderOpts) (string, error) {
	var b strings.Builder
	if err := c.RenderHTML(&b, opts); err != nil {
		return "", err
	}
	return b.String(), nil
}

// RenderHTML writes a single self-contained HTML document to w. It never fetches
// anything and never emits an external asset reference, so the output is a
// portable, ratifiable artifact.
func (c *Comb) RenderHTML(w io.Writer, opts RenderOpts) error {
	title := opts.Title
	if title == "" {
		title = "Comb artifact"
	}
	stats := opts.Stats
	if stats == nil && c != nil && c.store != nil {
		if s, err := c.Stats(); err == nil {
			stats = &s
		}
	}

	var b strings.Builder
	b.WriteString("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n")
	b.WriteString("<meta charset=\"utf-8\">\n")
	b.WriteString("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n")
	b.WriteString("<title>")
	b.WriteString(esc(title))
	b.WriteString("</title>\n<style>\n")
	b.WriteString(combCSS)
	b.WriteString("\n</style>\n</head>\n<body>\n<main class=\"comb\">\n")

	b.WriteString("<h1>")
	b.WriteString(esc(title))
	b.WriteString("</h1>\n")

	writeStats(&b, stats)
	writeLegend(&b)
	writeLeaves(&b, opts.Leaves)
	writeEdges(&b, opts.Edges)
	writeTraces(&b, opts.Traces)

	b.WriteString("</main>\n</body>\n</html>\n")
	_, err := io.WriteString(w, b.String())
	return err
}

func writeStats(b *strings.Builder, s *kmstore.Stats) {
	if s == nil {
		return
	}
	b.WriteString("<section class=\"stats\"><h2>Store</h2><dl>")
	stat(b, "Leaves (live)", s.Leaves)
	stat(b, "Attested", s.Attested)
	stat(b, "Ratified", s.Ratified)
	stat(b, "Tombstoned", s.Tombstoned)
	stat(b, "Edges", s.Edges)
	stat(b, "Quarantined", s.Quarantined)
	b.WriteString("<div><dt>Trust floor</dt><dd>")
	b.WriteString(esc(strconv.FormatFloat(s.TrustFloor, 'f', 2, 64)))
	b.WriteString("</dd></div></dl></section>\n")
}

func stat(b *strings.Builder, label string, v int) {
	b.WriteString("<div><dt>")
	b.WriteString(esc(label))
	b.WriteString("</dt><dd>")
	b.WriteString(strconv.Itoa(v))
	b.WriteString("</dd></div>")
}

func writeLegend(b *strings.Builder) {
	b.WriteString("<section class=\"legend\"><h2>Provenance states</h2><p>")
	b.WriteString(badge("attested", "attested") + " a second registered actor vouched (actor≠verifier). ")
	b.WriteString(badge("unattested", "unattested") + " stored but unvouched — refused by governed reads. ")
	b.WriteString(badge("quarantined", "quarantined") + " an un-attested write that contradicted attested knowledge; held in the audit trail, never in the live graph.")
	b.WriteString("</p></section>\n")
}

func writeLeaves(b *strings.Builder, leaves []kmstore.Leaf) {
	b.WriteString("<section class=\"leaves\"><h2>Leaves")
	b.WriteString(" <span class=\"count\">(" + strconv.Itoa(len(leaves)) + ")</span></h2>\n")
	if len(leaves) == 0 {
		b.WriteString("<p class=\"empty\">No leaves.</p></section>\n")
		return
	}
	b.WriteString("<div class=\"scroll\"><table>\n")
	b.WriteString("<thead><tr><th>State</th><th>ID</th><th>Content</th><th>Branch</th><th>Author</th><th>Verifier</th><th>Trust</th></tr></thead>\n<tbody>\n")
	for _, l := range leaves {
		state := "unattested"
		if l.Attested {
			state = "attested"
		}
		b.WriteString("<tr><td>")
		b.WriteString(badge(state, state))
		if l.Ratified {
			b.WriteString(" " + badge("ratified", "ratified"))
		}
		b.WriteString("</td><td class=\"mono\">")
		b.WriteString(esc(l.ID))
		b.WriteString("</td><td>")
		b.WriteString(esc(trunc(l.Content, 160)))
		b.WriteString("</td><td>")
		b.WriteString(esc(l.Branch))
		b.WriteString("</td><td class=\"mono\">")
		b.WriteString(esc(l.Author))
		b.WriteString("</td><td class=\"mono\">")
		b.WriteString(esc(l.Verifier))
		b.WriteString("</td><td>")
		b.WriteString(esc(strconv.FormatFloat(l.TrustScore, 'f', 2, 64)))
		b.WriteString("</td></tr>\n")
	}
	b.WriteString("</tbody></table></div></section>\n")
}

func writeEdges(b *strings.Builder, edges []RenderEdge) {
	if len(edges) == 0 {
		return
	}
	b.WriteString("<section class=\"edges\"><h2>Edges <span class=\"count\">(" + strconv.Itoa(len(edges)) + ")</span></h2>\n<ul>\n")
	for _, e := range edges {
		state := "unattested"
		if e.Attested {
			state = "attested"
		}
		b.WriteString("<li><span class=\"mono\">")
		b.WriteString(esc(e.Src))
		b.WriteString("</span> <span class=\"edge-type\">—")
		b.WriteString(esc(e.Type))
		b.WriteString("→</span> <span class=\"mono\">")
		b.WriteString(esc(e.Dst))
		b.WriteString("</span> ")
		b.WriteString(badge(state, state))
		b.WriteString("</li>\n")
	}
	b.WriteString("</ul></section>\n")
}

func writeTraces(b *strings.Builder, traces []Trace) {
	if len(traces) == 0 {
		return
	}
	b.WriteString("<section class=\"traces\"><h2>Provenance (bee-trace)</h2>\n")
	for _, tr := range traces {
		b.WriteString("<div class=\"trace\">")
		if tr.LeafID != "" {
			b.WriteString("<h3 class=\"mono\">" + esc(tr.LeafID) + "</h3>")
		}
		b.WriteString("<ol class=\"chain\">\n")
		for _, h := range tr.Hops {
			b.WriteString("<li>")
			b.WriteString("<span class=\"rel\">" + esc(string(h.Relation)) + "</span> ")
			actor := h.Actor
			if actor == "" {
				actor = "(unresolved)"
			}
			b.WriteString("<span class=\"mono actor\">" + esc(actor) + "</span> ")
			if h.Caste != "" {
				b.WriteString("<span class=\"caste\">" + esc(h.Caste))
				if h.Role != "" {
					b.WriteString("/" + esc(h.Role))
				}
				b.WriteString("</span> ")
			}
			ev := string(h.Evidence)
			evClass := "ev"
			if h.Gap {
				evClass = "ev gap"
				ev += " · gap"
			}
			b.WriteString("<span class=\"" + evClass + "\">" + esc(ev) + "</span>")
			if h.Attests != "" {
				b.WriteString(" <span class=\"attests\">" + esc(h.Attests) + "</span>")
			}
			if h.Note != "" {
				b.WriteString("<div class=\"note\">" + esc(h.Note) + "</div>")
			}
			b.WriteString("</li>\n")
		}
		b.WriteString("</ol>\n")
		if len(tr.Gaps) > 0 {
			b.WriteString("<div class=\"gaps\"><strong>Gaps</strong><ul>")
			for _, g := range tr.Gaps {
				b.WriteString("<li>" + esc(g) + "</li>")
			}
			b.WriteString("</ul></div>")
		}
		b.WriteString("</div>\n")
	}
	b.WriteString("</section>\n")
}

// badge renders an inline provenance-state pill.
func badge(class, label string) string {
	return "<span class=\"badge badge-" + esc(class) + "\">" + esc(label) + "</span>"
}

// esc HTML-escapes a dynamic string (the sole content sink — nothing reaches the
// document un-escaped).
func esc(s string) string { return html.EscapeString(s) }

// trunc shortens content for the table cell without breaking a rune.
func trunc(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// combCSS is the self-contained Sumi & Kin stylesheet. No url(), no @import, no
// web font — the document must reference no external asset.
const combCSS = `
:root {
  --washi: #f7f4ec; --sumi: #1c1a17; --kin: #b08d3f;
  --muted: #6f6a60; --line: #e0dace; --card: #fffdf8;
  --attested: #3f6f4f; --unattested: #8a8478; --quarantined: #9a4a3a; --ratified: #b08d3f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --washi: #16140f; --sumi: #ece7db; --kin: #d0aa55;
    --muted: #9a9384; --line: #2c2a22; --card: #1e1b15;
    --attested: #7fb992; --unattested: #9a9384; --quarantined: #d68a78; --ratified: #d0aa55;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--washi); color: var(--sumi);
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.5; }
.comb { max-width: 60rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
h1 { font-weight: 600; letter-spacing: -0.01em; margin: 0 0 1.5rem; }
h2 { font-size: 1.05rem; font-weight: 600; margin: 2rem 0 0.75rem; color: var(--muted); }
h3 { font-size: 0.9rem; font-weight: 600; margin: 1rem 0 0.5rem; }
section { border-top: 1px solid var(--line); padding-top: 0.5rem; }
.count { color: var(--muted); font-weight: 400; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; white-space: nowrap; }
dl { display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; margin: 0; }
dl div { min-width: 6rem; }
dt { color: var(--muted); font-size: 0.8rem; }
dd { margin: 0; font-size: 1.1rem; font-weight: 600; }
.badge { display: inline-block; padding: 0.05rem 0.5rem; border-radius: 0.35rem;
  font-size: 0.72rem; font-weight: 600; border: 1px solid currentColor; }
.badge-attested { color: var(--attested); }
.badge-unattested { color: var(--unattested); }
.badge-quarantined { color: var(--quarantined); }
.badge-ratified { color: var(--ratified); }
.edges ul, .chain { list-style: none; padding: 0; margin: 0; }
.edges li { padding: 0.3rem 0; }
.edge-type { color: var(--kin); font-size: 0.85em; }
.trace { border: 1px solid var(--line); border-radius: 0.5rem; padding: 0.75rem 1rem; margin: 0.75rem 0; background: var(--card); }
.chain li { padding: 0.4rem 0; border-bottom: 1px dashed var(--line); }
.chain li:last-child { border-bottom: none; }
.rel { display: inline-block; min-width: 5.5rem; color: var(--kin); font-weight: 600; font-size: 0.8rem; }
.caste { color: var(--muted); font-size: 0.8rem; }
.ev { font-size: 0.72rem; color: var(--muted); border: 1px solid var(--line); border-radius: 0.3rem; padding: 0 0.35rem; }
.ev.gap { color: var(--quarantined); border-color: var(--quarantined); }
.attests { font-size: 0.72rem; color: var(--muted); }
.note { font-size: 0.8rem; color: var(--muted); margin-top: 0.2rem; }
.gaps { margin-top: 0.5rem; font-size: 0.82rem; color: var(--quarantined); }
.gaps ul { margin: 0.3rem 0 0; padding-left: 1.1rem; }
.empty { color: var(--muted); }
`
