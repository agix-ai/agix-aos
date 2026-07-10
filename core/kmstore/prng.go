// prng — deterministic, seedable pseudo-random source, ported byte-for-byte
// from lib/agix-loop-sim/prng.mjs (mulberry32). The whole point of a benchmark
// harness is reproducibility: identical seed => identical stream, forever,
// across machines and Go versions. This source NEVER touches math/rand or any
// wall clock, so corpus + query generation is fully deterministic.
//
// mulberry32 is a 32-bit generator with a full 2^32 period and excellent
// avalanche. The JS reference operates on int32/uint32 via `| 0`, `>>> n`, and
// Math.imul; the equivalent Go is plain uint32 arithmetic, which wraps mod 2^32
// with identical bit patterns — so this stream matches the Node premise test
// exactly for a given seed.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.
package kmstore

import "math"

// prng is a mulberry32 stream keyed on a single 32-bit seed.
type prng struct{ a uint32 }

// newPRNG returns a stream seeded with the given 32-bit value.
func newPRNG(seed uint32) *prng { return &prng{a: seed} }

// next returns a uniform float in [0, 1). Mirrors the JS mulberry32 core:
//
//	a = (a + 0x6d2b79f5) | 0;
//	let t = Math.imul(a ^ (a >>> 15), 1 | a);
//	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
//	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
func (p *prng) next() float64 {
	p.a += 0x6d2b79f5
	t := (p.a ^ (p.a >> 15)) * (1 | p.a)
	t = (t + (t^(t>>7))*(61|t)) ^ t
	return float64(t^(t>>14)) / 4294967296.0
}

// intRange returns a uniform integer in [min, max] inclusive.
// Mirrors JS: Math.floor(min + (max - min + 1) * next()).
func (p *prng) intRange(min, max int) int {
	return min + int(math.Floor(float64(max-min+1)*p.next()))
}

// gaussian returns a standard-normal draw via Box–Muller (two stream draws),
// mirroring the JS gaussian(mean, sd).
func (p *prng) gaussian(mean, sd float64) float64 {
	u1 := p.next()
	u2 := p.next()
	if u1 < 1e-12 {
		u1 = 1e-12 // avoid log(0)
	}
	mag := math.Sqrt(-2 * math.Log(u1))
	return mean + sd*mag*math.Cos(2*math.Pi*u2)
}
