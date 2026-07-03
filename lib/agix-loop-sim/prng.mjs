// agix-loop-sim/prng — deterministic, seedable pseudo-random source.
//
// GUARDS: "reliability harness reads Math.random()" (loop-sim/RELIABILITY).
// The whole point of this harness is byte-for-byte reproducibility, so the
// simulation MUST NEVER touch Math.random() or any wall clock. Every draw
// comes from a mulberry32 stream keyed on a single integer seed: identical
// seed => identical stream, forever, across machines and Node versions.
//
// mulberry32 is a 32-bit generator with a full 2^32 period, excellent
// avalanche, and no external state — perfect for a CI-safe simulator.

/**
 * Raw mulberry32 core. Returns a function producing floats in [0, 1).
 * @param {number} seed  32-bit unsigned seed.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A small typed API over a mulberry32 stream. All helpers are pure draws
 * from the same stream, so a fixed call ORDER on a fixed seed is fully
 * deterministic. Never introduce a draw whose presence depends on
 * wall-clock or environment state.
 *
 * @param {number} seed
 */
export function makePrng(seed) {
  const next = mulberry32(seed);
  const api = {
    /** Uniform float in [0, 1). */
    float() {
      return next();
    },
    /** Uniform float in [min, max). */
    range(min, max) {
      return min + (max - min) * next();
    },
    /** Uniform integer in [min, max] inclusive. */
    int(min, max) {
      return Math.floor(min + (max - min + 1) * next());
    },
    /** Bernoulli: true with probability p. */
    bool(p) {
      return next() < p;
    },
    /** Uniform pick from a non-empty array. */
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    /**
     * Weighted pick. `items` is [{ value, weight }] (weights > 0).
     * Stable: iterates in array order, so equal seeds pick equally.
     */
    weighted(items) {
      const total = items.reduce((s, it) => s + (it.weight ?? 1), 0);
      let r = next() * total;
      for (const it of items) {
        r -= it.weight ?? 1;
        if (r < 0) return it.value;
      }
      return items[items.length - 1].value;
    },
    /**
     * Standard-normal draw via Box–Muller (uses two stream draws).
     * Deterministic given the stream.
     */
    gaussian(mean = 0, sd = 1) {
      let u1 = next();
      const u2 = next();
      if (u1 < 1e-12) u1 = 1e-12; // avoid log(0)
      const mag = Math.sqrt(-2 * Math.log(u1));
      return mean + sd * mag * Math.cos(2 * Math.PI * u2);
    },
    /** Gaussian clamped to [lo, hi]. */
    clampedGaussian(mean, sd, lo, hi) {
      const v = api.gaussian(mean, sd);
      return Math.min(hi, Math.max(lo, v));
    },
  };
  return api;
}
