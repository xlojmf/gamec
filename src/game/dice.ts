/**
 * Dice logic — pure & RNG-injected so boardgame.io can own rolls in M8+.
 *
 * The UI layer never rolls dice itself with hidden state: it calls rollDice
 * with an injected generator (Math.random today, boardgame.io random later)
 * and feeds the result to the animation layer.
 */

export interface DiceRoll {
  die1: number
  die2: number
  sum: number
}

/** Roll two d6. `rnd` must return floats in [0, 1). */
export function rollDice(rnd: () => number = Math.random): DiceRoll {
  const die1 = 1 + Math.floor(rnd() * 6)
  const die2 = 1 + Math.floor(rnd() * 6)
  return { die1, die2, sum: die1 + die2 }
}

/** Probability pips printed on number chits (sums 2–12 → 1–5 dots, no 7 chit). */
export function pipCount(sum: number): number {
  return 6 - Math.abs(7 - sum)
}

/** A 7 summons the robber: no production, discard-half + move + steal. */
export function isRobberRoll(sum: number): boolean {
  return sum === 7
}
