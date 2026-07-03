// agix — lazy heavy-dependency tests (lean-pack slimming).
//   node --test test/agix-lazy-heavy-deps.test.mjs
//
// googleapis + google-auth-library (~194MB) and puppeteer-core (~30MB) are
// declared as OPTIONAL deps and are NOT bundled in the lean public pack. They
// MUST be imported lazily (dynamic `await import()` inside the function that
// uses them) so the core runtime hot path doesn't pull ~224MB at startup. These
// tests pin that contract:
//   (1) the modules that wrap those deps do not statically import them
//       (source-level assertion — survives even when the dep IS installed);
//   (2) `sanitizeGoogleEnv` (called by the runtime constructor on every run)
//       needs no heavy dep and runs clean.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const lib = (f) => resolve(here, '..', 'lib', f);

// A static (top-level) ESM import looks like `import ... from 'pkg'`. A lazy one
// is `await import('pkg')`. We assert the heavy packages only appear in the lazy
// form on the runtime hot-path modules.
function topLevelStaticImports(source) {
  // Matches `import ... from '<spec>'` / `import '<spec>'` at line start.
  const re = /^\s*import\b[^\n]*?from\s*['"]([^'"]+)['"]/gm;
  const bare = /^\s*import\s*['"]([^'"]+)['"]/gm;
  const specs = new Set();
  let m;
  while ((m = re.exec(source))) specs.add(m[1]);
  while ((m = bare.exec(source))) specs.add(m[1]);
  return specs;
}

const HEAVY = ['googleapis', 'google-auth-library', 'puppeteer-core'];

test('agix-google-auth.mjs does NOT statically import googleapis / google-auth-library', () => {
  const src = readFileSync(lib('agix-google-auth.mjs'), 'utf8');
  const statics = topLevelStaticImports(src);
  for (const h of ['googleapis', 'google-auth-library']) {
    assert.equal(statics.has(h), false, `${h} must be a lazy import, not a top-level one`);
  }
  // And it MUST still reference them lazily.
  assert.match(src, /await import\(['"]google-auth-library['"]\)/);
  assert.match(src, /await import\(['"]googleapis['"]\)/);
});

test('agix-send.mjs does NOT statically import puppeteer-core', () => {
  const src = readFileSync(lib('agix-send.mjs'), 'utf8');
  const statics = topLevelStaticImports(src);
  assert.equal(statics.has('puppeteer-core'), false, 'puppeteer-core must be a lazy import');
  assert.match(src, /await import\(['"]puppeteer-core['"]\)/);
});

test('agix-runtime.mjs (the hot path) does NOT statically import any heavy dep', () => {
  const src = readFileSync(lib('agix-runtime.mjs'), 'utf8');
  const statics = topLevelStaticImports(src);
  for (const h of HEAVY) {
    assert.equal(statics.has(h), false, `${h} must not be a top-level import in the runtime`);
  }
});

test('the lazy loaders throw a CLEAR install hint (not a raw module-not-found stack)', () => {
  // Pin the error-message contract at the source level so the graceful-
  // degradation text never silently regresses to a raw stack.
  const auth = readFileSync(lib('agix-google-auth.mjs'), 'utf8');
  assert.match(auth, /not bundled in the lean Agix pack/);
  assert.match(auth, /npm i -g/);
  const send = readFileSync(lib('agix-send.mjs'), 'utf8');
  assert.match(send, /not bundled in the lean Agix pack/);
  assert.match(send, /Sending without a rendered signature image/);
});

test('sanitizeGoogleEnv runs with no heavy dependency', async () => {
  const { sanitizeGoogleEnv } = await import('../lib/agix-google-auth.mjs');
  process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/stray-key.json';
  sanitizeGoogleEnv();
  assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
});
