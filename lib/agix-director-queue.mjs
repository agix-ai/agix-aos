// agix-director-queue — read + render the Director's living queue.
//
// Single source of truth: wiki/director/queue.md. Format is a YAML
// frontmatter block (the structured items) followed by an
// auto-rendered human-readable section. The Director writes both halves
// on every run; the brief renderer (Research, future Secretary digest)
// reads the frontmatter and produces a "Last cycle's status" section
// for the top of the outbound brief.
//
// Phase 2 of the Director: writes status=`proposed` items.
// Phase 6 of the Director (this module): reads the queue and renders.
// Phase 3 of the Director: executors transition status to in-progress /
// completed / deferred / dismissed via `upsertQueueItem()`.
//
// Item shape:
//   id:           '2026-05-12.B1'
//   title:        'Process Reward Models'
//   source_agent: 'research'
//   source_date:  '2026-05-12'
//   verb:         'approve' | 'dive' | 'defer' | 'skip' | 'expand' | 'proposed'
//   status:       'completed' | 'in-progress' | 'deferred' | 'dismissed' | 'proposed'
//   artifact:     'wiki/...' | null
//   note:         '<short string surfaced in the rendered status>'
//   updated_at:   ISO8601

import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import yaml from 'js-yaml';

const QUEUE_REL_PATH = 'wiki/director/queue.md';

export async function readQueue(runtime) {
  const path = runtime.resolveRepoPath(QUEUE_REL_PATH);
  if (!existsSync(path)) return { items: [] };
  const raw = await readFile(path, 'utf8');
  return parseQueue(raw);
}

export function parseQueue(raw) {
  // YAML frontmatter between leading --- and closing ---
  if (!raw.startsWith('---')) return { items: [] };
  const closing = raw.indexOf('\n---', 3);
  if (closing === -1) return { items: [] };
  const fm = raw.slice(3, closing).replace(/^\s*\n/, '');
  try {
    const parsed = yaml.load(fm) || {};
    return { items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return { items: [] };
  }
}

// Upsert a single item: read queue, patch (or insert) the entry with
// the given id, write back. `patch` is shallow-merged onto the existing
// record (or onto an empty {id, ...} record if it doesn't exist yet).
// `updated_at` is always stamped to now. Returns the merged record.
export async function upsertQueueItem(runtime, id, patch) {
  if (!id) throw new Error('upsertQueueItem: id required');
  const { items } = await readQueue(runtime);
  const idx = items.findIndex(it => it.id === id);
  const base = idx >= 0 ? items[idx] : { id };
  const merged = { ...base, ...patch, id, updated_at: new Date().toISOString() };
  if (idx >= 0) items[idx] = merged;
  else items.push(merged);
  await writeQueue(runtime, items);
  return merged;
}

export async function writeQueue(runtime, items) {
  const path = runtime.resolveRepoPath(QUEUE_REL_PATH);
  await mkdir(dirname(path), { recursive: true });
  const fm = yaml.dump({ items }, { lineWidth: 100, noRefs: true });
  const body = renderQueueBody(items);
  const out =
    `---\n` +
    `# Director queue — source of truth. Phase 6 brief renderer reads this block.\n` +
    `# Do not hand-edit unless you know what you're doing; the Director rewrites\n` +
    `# this file every run.\n` +
    fm +
    `---\n\n` +
    `# Director Queue\n\n` +
    `Living queue of items in flight from agent briefings. Status transitions:\n` +
    `proposed → in-progress → (completed | deferred | dismissed). Updated by\n` +
    `\`agix agent run director\` on each run.\n\n` +
    body +
    '\n';
  await writeFile(path, out);
  return path;
}

function renderQueueBody(items) {
  if (!items || items.length === 0) {
    return '_Queue is empty._\n';
  }
  const buckets = bucketize(items);
  const lines = [];
  for (const [label, bucket] of [
    ['Completed', buckets.completed],
    ['In progress', buckets.inProgress],
    ['Deferred', buckets.deferred],
    ['Dismissed', buckets.dismissed],
    ['Proposed (awaiting approval)', buckets.proposed],
  ]) {
    if (bucket.length === 0) continue;
    lines.push(`## ${label}`);
    lines.push('');
    for (const it of bucket) {
      lines.push(`- **${it.id}** ${it.title || ''}${it.note ? ' — ' + it.note : ''}${it.artifact ? ' (`' + it.artifact + '`)' : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function bucketize(items) {
  const out = { completed: [], inProgress: [], deferred: [], dismissed: [], proposed: [] };
  for (const it of items) {
    switch (it.status) {
      case 'completed': out.completed.push(it); break;
      case 'in-progress': out.inProgress.push(it); break;
      case 'deferred': out.deferred.push(it); break;
      case 'dismissed': out.dismissed.push(it); break;
      case 'proposed':
      default: out.proposed.push(it);
    }
  }
  return out;
}

// Returns a Markdown block to prepend to the next outbound brief, OR an
// empty string if there's nothing to surface. `forDate` lets the renderer
// avoid re-surfacing items whose source brief is from the same day.
export async function renderLastCycleStatus({ runtime, forDate, sourceAgent }) {
  let queue;
  try {
    queue = await readQueue(runtime);
  } catch {
    return '';
  }
  const items = (queue.items || []).filter(it => {
    if (sourceAgent && it.source_agent && it.source_agent !== sourceAgent) return false;
    if (forDate && it.source_date === forDate) return false;
    return true;
  });
  if (items.length === 0) return '';

  const buckets = bucketize(items);

  const lines = [];
  lines.push(`## Last cycle's status`);
  lines.push('');

  if (buckets.completed.length > 0) {
    lines.push('### Completed');
    lines.push('');
    for (const it of buckets.completed) {
      lines.push(`- ✓ **${it.id}** ${it.title || ''}${formatTail(it)}`);
    }
    lines.push('');
  }
  if (buckets.inProgress.length > 0) {
    lines.push('### In progress');
    lines.push('');
    for (const it of buckets.inProgress) {
      lines.push(`- ⊙ **${it.id}** ${it.title || ''}${formatTail(it)}`);
    }
    lines.push('');
  }
  if (buckets.deferred.length > 0) {
    lines.push('### Deferred');
    lines.push('');
    for (const it of buckets.deferred) {
      lines.push(`- ⊙ **${it.id}** ${it.title || ''}${formatTail(it)}`);
    }
    lines.push('');
  }
  if (buckets.dismissed.length > 0) {
    lines.push('### Dismissed (no action needed)');
    lines.push('');
    for (const it of buckets.dismissed) {
      lines.push(`- ✗ **${it.id}** ${it.title || ''}`);
    }
    lines.push('');
  }
  if (buckets.proposed.length > 0) {
    lines.push('### Proposed (awaiting your approval)');
    lines.push('');
    for (const it of buckets.proposed) {
      lines.push(`- ☐ **${it.id}** ${it.title || ''}${formatTail(it)}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function formatTail(it) {
  const parts = [];
  if (it.note) parts.push(it.note);
  if (it.artifact) parts.push(`\`${it.artifact}\``);
  return parts.length ? ' — ' + parts.join(' · ') : '';
}

export const QUEUE_PATH = QUEUE_REL_PATH;
