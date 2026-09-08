import { describe, expect, it } from 'vitest'
import { mulberry32 } from './rng'
import { isRobberRoll, pipCount, rollDice } from './dice'

describe('rollDice', () => {
  it('produces valid faces and a consistent sum', () => {
    for (let i = 0; i < 500; i++) {
      const { die1, die2, sum } = rollDice()
      expect(die1).toBeGreaterThanOrEqual(1)
      expect(die1).toBeLessThanOrEqual(6)
      expect(die2).toBeGreaterThanOrEqual(1)
      expect(die2).toBeLessThanOrEqual(6)
      expect(sum).toBe(die1 + die2)
    }
  })

  it('is deterministic for a seeded rng', () => {
    const a = rollDice(mulberry32(42))
    const b = rollDice(mulberry32(42))
    expect(a).toEqual(b)
  })

  it('different seeds can produce different rolls', () => {
    // not a hard guarantee, but across 50 seed pairs at least one should differ
    let anyDifferent = false
    for (let s = 0; s < 50; s++) {
      if (JSON.stringify(rollDice(mulberry32(s))) !== JSON.stringify(rollDice(mulberry32(s + 1000)))) {
        anyDifferent = true
        break
      }
    }
    expect(anyDifferent).toBe(true)
  })

  it('covers every face value and every sum over many seeded rolls', () => {
    const rnd = mulberry32(7)
    const faces = new Set<number>()
    const sums = new Map<number, number>()
    for (let i = 0; i < 2000; i++) {
      const r = rollDice(rnd)
      faces.add(r.die1)
      faces.add(r.die2)
      sums.set(r.sum, (sums.get(r.sum) ?? 0) + 1)
    }
    expect([...faces].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
    expect([...sums.keys()].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('7 is the most frequent sum and tails are rarest (distribution sanity)', () => {
    const rnd = mulberry32(1234)
    const counts = new Map<number, number>()
    const N = 30_000
    for (let i = 0; i < N; i++) {
      const { sum } = rollDice(rnd)
      counts.set(sum, (counts.get(sum) ?? 0) + 1)
    }
    // p(7)=6/36 vs p(6)=5/36 vs p(2)=1/36 — gaps are many σ apart at N=30k
    expect(counts.get(7)!).toBeGreaterThan(counts.get(6)!)
    expect(counts.get(7)!).toBeGreaterThan(counts.get(8)!)
    expect(counts.get(2)!).toBeLessThan(counts.get(6)!)
    expect(counts.get(12)!).toBeLessThan(counts.get(8)!)
    // relative frequency of 7 within a loose band around 6/36 ≈ 16.7%
    const frac7 = counts.get(7)! / N
    expect(frac7).toBeGreaterThan(0.14)
    expect(frac7).toBeLessThan(0.2)
  })
})

describe('chit helpers', () => {
  it('pipCount matches number-chit dots', () => {
    expect(pipCount(2)).toBe(1)
    expect(pipCount(3)).toBe(2)
    expect(pipCount(6)).toBe(5)
    expect(pipCount(8)).toBe(5)
    expect(pipCount(12)).toBe(1)
  })

  it('flags robber rolls', () => {
    expect(isRobberRoll(7)).toBe(true)
    expect(isRobberRoll(6)).toBe(false)
    expect(isRobberRoll(8)).toBe(false)
  })
})
