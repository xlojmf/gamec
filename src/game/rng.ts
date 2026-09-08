/**
 * Deterministic PRNG utilities.
 *
 * All randomness in the game flows through seeded generators so that the
 * server (multiplayer, M12) and every client agree on the same world:
 * `generateBoard(seed)` is a pure function of its seed.
 */

/** Fast, decent-quality 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher–Yates shuffle driven by an injected RNG. */
export function shuffled<T>(items: readonly T[], rnd: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Random 32-bit-ish integer seed for "New board" buttons. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31) >>> 0
}
