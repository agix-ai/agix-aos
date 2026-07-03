// agix-gbrain — embedded local knowledge-fabric unit tests (AGIX.ONBOARD.1 DL.11).
// Runner: node --test test/agix-gbrain.test.mjs
//
// Covers:
//   - putPage → getPage round-trips (slug canonicalization, content, tags)
//   - [[wikilink]] extraction creates a backlink; getBacklinks returns the linker
//   - search ranks a relevant page above an irrelevant one (bounded [0,1] score)
//   - the store AUTO-PROVISIONS under a temp data dir (HOME/XDG redirected so it
//     never touches the real ~/.local/state)
//   - smoke stub mirrors the real API in-memory (no disk)
//   - runtime.getGbrain() is cached + smoke-aware
//   - mentor wiring: gatherMemory uses gbrain backlinked precedents for the gate

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import {
  Gbrain, createGbrainStub, getGbrain, extractWikilinks, slugify, tokenize, relevance,
} from '../lib/agix-gbrain.mjs';
import { LocalRuntime } from '../lib/agix-runtime.mjs';
import { gatherMemory, gatherPrecedentsFromGbrain } from '../lib/agix-mentor.mjs';

// Each test gets its own temp store dir — never the real data dir.
function tempStoreDir() {
  return mkdtempSync(join(tmpdir(), 'agix-gbrain-test-'));
}

test('putPage → getPage round-trips; slug canonicalizes from the title', () => {
  const dir = tempStoreDir();
  const g = new Gbrain({ dir });
  const rec = g.putPage({ title: 'Weekly Investor Update', content: 'the format we always use', tags: ['comms', 'recurring'] });
  assert.equal(rec.slug, 'weekly-investor-update');
  const got = g.getPage('weekly-investor-update');
  assert.equal(got.title, 'Weekly Investor Update');
  assert.match(got.content, /format we always use/);
  assert.deepEqual(got.tags, ['comms', 'recurring']);
  // Lookup by title (slugified) also resolves.
  assert.equal(g.getPage('Weekly Investor Update').slug, 'weekly-investor-update');
  rmSync(dir, { recursive: true, force: true });
});

test('[[wikilink]] in content creates a backlink; getBacklinks returns the linker', () => {
  const dir = tempStoreDir();
  const g = new Gbrain({ dir });
  g.putPage({ title: 'Discovery Call Offer', content: 'standard offer' });
  g.putPage({ title: 'Enterprise Lead Reply', content: 'reply with the [[Discovery Call Offer]] template' });

  const back = g.getBacklinks('discovery-call-offer');
  assert.equal(back.length, 1);
  assert.equal(back[0].slug, 'enterprise-lead-reply');

  // extractWikilinks handles display-text form too.
  assert.deepEqual(extractWikilinks('see [[Target Page|click here]] and [[Other]]'), ['target-page', 'other']);
  rmSync(dir, { recursive: true, force: true });
});

test('addLink creates a durable backlink even before the target page exists', () => {
  const dir = tempStoreDir();
  const g = new Gbrain({ dir });
  assert.equal(g.addLink('Source', 'Target'), true);
  assert.equal(g.addLink('Source', 'Target'), false, 'duplicate link is a no-op');
  assert.equal(g.addLink('Self', 'Self'), false, 'self-link rejected');
  const back = g.getBacklinks('target');
  assert.equal(back.length, 1);
  assert.equal(back[0].slug, 'source');
  rmSync(dir, { recursive: true, force: true });
});

test('search ranks a relevant page above an irrelevant one, score in [0,1]', () => {
  const dir = tempStoreDir();
  const g = new Gbrain({ dir });
  g.putPage({ title: 'Pricing Change Procedure', content: 'how we change pricing on the public site', tags: ['pricing'] });
  g.putPage({ title: 'Office Plant Care', content: 'water the ferns weekly', tags: ['facilities'] });

  const hits = g.search('change pricing on the site', { limit: 5 });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].slug, 'pricing-change-procedure');
  assert.ok(hits[0].score > 0 && hits[0].score <= 1, 'score bounded in (0,1]');
  // The irrelevant page either does not appear or ranks strictly below.
  const plant = hits.find((h) => h.slug === 'office-plant-care');
  if (plant) assert.ok(plant.score < hits[0].score);
  // Empty query returns [].
  assert.deepEqual(g.search(''), []);
  rmSync(dir, { recursive: true, force: true });
});

test('store auto-provisions under a temp data dir; nothing touches the real ~/.local/state', () => {
  const dir = tempStoreDir();
  const storePath = resolve(dir, 'store.json');
  const g = new Gbrain({ dir });
  // Fresh store: dir + file do NOT exist until the first write.
  assert.ok(!existsSync(storePath), 'no file before first write');
  // Reads on a fresh store are safe (auto-provision in memory, no throw).
  assert.equal(g.getPage('anything'), null);
  assert.deepEqual(g.listPages(), []);
  assert.deepEqual(g.getBacklinks('anything'), []);
  assert.equal(g.stats().pages, 0);
  // First write provisions the file on disk.
  g.putPage({ title: 'First Page', content: 'hello' });
  assert.ok(existsSync(storePath), 'file provisioned on first write');
  // A second Gbrain on the same dir reads the persisted page back.
  const g2 = new Gbrain({ dir });
  assert.equal(g2.getPage('first-page').title, 'First Page');
  rmSync(dir, { recursive: true, force: true });
});

test('getGbrain() factory + auto-provision honors AGIX_DATA_DIR (no real-home touch)', () => {
  const dir = tempStoreDir();
  const prev = process.env.AGIX_DATA_DIR;
  const prevSmoke = process.env.SMOKE;
  try {
    process.env.AGIX_DATA_DIR = dir;
    delete process.env.SMOKE;
    const g = getGbrain();
    g.putPage({ title: 'Routed Page', content: 'lands under AGIX_DATA_DIR' });
    assert.ok(existsSync(resolve(dir, 'gbrain', 'store.json')), 'store under AGIX_DATA_DIR/gbrain');
  } finally {
    if (prev === undefined) delete process.env.AGIX_DATA_DIR; else process.env.AGIX_DATA_DIR = prev;
    if (prevSmoke === undefined) delete process.env.SMOKE; else process.env.SMOKE = prevSmoke;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke stub mirrors the real API in-memory (no disk)', () => {
  const g = createGbrainStub();
  assert.equal(g.smoke, true);
  g.putPage({ title: 'Topic A', content: 'links to [[Topic B]]' });
  g.putPage({ title: 'Topic B', content: 'the target' });
  assert.equal(g.getPage('topic-a').title, 'Topic A');
  assert.equal(g.getBacklinks('topic-b')[0].slug, 'topic-a');
  const hits = g.search('topic target');
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].score > 0 && hits[0].score <= 1);
  assert.equal(g.stats().smoke, true);
});

test('runtime.getGbrain() is cached and smoke-aware', () => {
  const dir = tempStoreDir();
  const prev = process.env.AGIX_DATA_DIR;
  try {
    process.env.AGIX_DATA_DIR = dir;
    const rt = new LocalRuntime({ agentName: 'sensei' });
    assert.equal(rt.getGbrain(), rt.getGbrain(), 'cached per runtime');
    assert.ok(!rt.getGbrain().smoke);

    const smokeRt = new LocalRuntime({ agentName: 'sensei', smoke: true });
    assert.equal(smokeRt.getGbrain().smoke, true);
  } finally {
    if (prev === undefined) delete process.env.AGIX_DATA_DIR; else process.env.AGIX_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mentor gate: gatherMemory uses gbrain backlinked precedents (G1 holds)', async () => {
  const g = createGbrainStub();
  // 3 precedent pages for "weekly investor update", each backlinked by an index page
  // so they satisfy the backlinked-precedent criterion.
  for (let i = 1; i <= 3; i++) {
    g.putPage({ title: `Weekly Investor Update Send ${i}`, content: 'sent the weekly investor update in the usual format', tags: ['investor', 'update'] });
  }
  g.putPage({
    title: 'Investor Update Index',
    content: 'index of [[Weekly Investor Update Send 1]] [[Weekly Investor Update Send 2]] [[Weekly Investor Update Send 3]]',
  });

  // Direct precedent gather: 3 qualifying, similarity ≥ 0.7.
  const action = { title: 'Send the weekly investor update', reversible: true, riskTier: 'low' };
  const p = gatherPrecedentsFromGbrain(action, g);
  assert.ok(p.precedentCount >= 3, `expected ≥3 backlinked precedents, got ${p.precedentCount}`);
  assert.ok(p.precedentSimilarity >= 0.7, `expected similarity ≥0.7, got ${p.precedentSimilarity}`);

  // Full gate via gatherMemory with a gbrain dep: precedent gate holds.
  const res = await gatherMemory(action, { gbrain: g });
  assert.equal(res.evidence.precedentSource, 'gbrain');
  assert.equal(res.decision.gates.precedent, true, 'precedent gate holds from gbrain evidence');

  // A precedent page that is NOT backlinked must not qualify (link-graph criterion).
  const g2 = createGbrainStub();
  for (let i = 1; i <= 3; i++) {
    g2.putPage({ title: `Orphan Update ${i}`, content: 'sent the weekly investor update orphan', tags: ['update'] });
  }
  const p2 = gatherPrecedentsFromGbrain({ title: 'Send the weekly investor update orphan' }, g2);
  assert.equal(p2.precedentCount, 0, 'un-backlinked precedents do not qualify');
});

test('slugify + tokenize + relevance behave as documented', () => {
  assert.equal(slugify('  Hello, World! '), 'hello-world');
  assert.deepEqual(tokenize('The Dojo re-opened OK'), ['dojo', 're', 'opened', 'ok']);
  const page = { title: 'Pricing', content: 'change pricing', tags: ['pricing'] };
  assert.ok(relevance(tokenize('change pricing'), page) > relevance(tokenize('weather forecast'), page));
});
