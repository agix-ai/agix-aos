// agix-brief-items — extract per-item context from a brief Markdown
// document by item ID.
//
// Item IDs follow `YYYY-MM-DD.<section-letter><item-number>` and are
// emitted by the Research brief renderer at H3-heading level. In the
// SOURCE Markdown the ID isn't embedded — it's derived from the
// heading's position (the Nth H3 inside the Mth H2 gets composed as
// `<brief-date>.<letter-M><N>`). This helper recovers an item's
// (title, excerpt) by walking the same rule the renderer uses.

export function extractItemContext(briefMarkdown, itemId) {
  if (!briefMarkdown || !itemId) return { title: null, excerpt: '' };

  const lines = briefMarkdown.split(/\r?\n/);

  // Recover the brief's date from the first H1 line. Falls back to the
  // date prefix on the itemId if the brief's H1 doesn't carry one.
  let dateMatch = null;
  for (const line of lines) {
    const m = line.match(/^#\s.*?(\d{4}-\d{2}-\d{2})/);
    if (m) { dateMatch = m[1]; break; }
  }
  if (!dateMatch) {
    const m = itemId.match(/^(\d{4}-\d{2}-\d{2})\./);
    dateMatch = m ? m[1] : null;
  }
  if (!dateMatch) return { title: null, excerpt: '' };

  const sectionLetterFor = (idx) => String.fromCharCode('A'.charCodeAt(0) + idx);

  let sectionIdx = -1;
  let itemIdxInSection = 0;
  let matchedTitle = null;
  let matchedStart = -1;
  let matchedEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line) && !/^###/.test(line)) {
      sectionIdx += 1;
      itemIdxInSection = 0;
      continue;
    }
    if (/^###\s/.test(line)) {
      itemIdxInSection += 1;
      if (sectionIdx < 0) continue;
      const composedId = `${dateMatch}.${sectionLetterFor(sectionIdx)}${itemIdxInSection}`;
      if (composedId === itemId) {
        matchedTitle = line.replace(/^###\s+/, '').trim();
        matchedStart = i + 1;
        for (let j = i + 1; j < lines.length; j++) {
          if (/^###?\s/.test(lines[j])) { matchedEnd = j; break; }
        }
        break;
      }
    }
  }

  if (matchedTitle === null) return { title: null, excerpt: '' };
  const excerpt = lines.slice(matchedStart, matchedEnd).join('\n').trim();
  return { title: matchedTitle, excerpt };
}

// Extract all URLs cited in a brief excerpt as `[text](url)` markdown links.
// Used by EXPAND/APPROVE executors to attach references without re-asking
// Sonnet to remember them.
export function extractUrls(excerpt) {
  if (!excerpt) return [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  const out = [];
  let m;
  while ((m = re.exec(excerpt)) !== null) {
    out.push({ text: m[1], url: m[2] });
  }
  return out;
}

// Slugify a title for use in a filename. Lowercase, hyphenated, ASCII only.
export function slugifyTitle(title, fallback = 'item') {
  if (!title) return fallback;
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}
