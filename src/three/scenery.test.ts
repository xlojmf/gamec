import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  createForestScenery,
  createMountainGeometry,
  createWheatScenery,
} from './scenery'
import { createCity, createSettlement } from './pieces'

function geometryValues(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute('position')
  const values = Array.from(position.array as ArrayLike<number>)
  return { position, values }
}

function finiteBounds(object: THREE.Object3D) {
  object.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(object)
  for (const value of [
    bounds.min.x,
    bounds.min.y,
    bounds.min.z,
    bounds.max.x,
    bounds.max.y,
    bounds.max.z,
  ]) expect(Number.isFinite(value)).toBe(true)
  return bounds
}

describe('mountain scenery geometry', () => {
  it('is deterministic, finite, connected, and stays within the tile envelope', () => {
    const first = createMountainGeometry(17)
    const second = createMountainGeometry(17)
    const firstValues = geometryValues(first).values
    const secondValues = geometryValues(second).values
    expect(firstValues).toEqual(secondValues)

    const position = first.getAttribute('position')
    const index = first.getIndex()
    expect(index).not.toBeNull()
    expect(position.count).toBeGreaterThan(3)
    expect(index!.count).toBeGreaterThan(3)
    for (const value of firstValues) expect(Number.isFinite(value)).toBe(true)

    const vertex = new THREE.Vector3()
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i)
      expect(vertex.y).toBeGreaterThanOrEqual(0)
      expect(vertex.y).toBeLessThanOrEqual(1.15)
      const radius = Math.hypot(vertex.x, vertex.z)
      const angle = Math.atan2(vertex.z, vertex.x)
      const sector = ((angle % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3)
      const hexLimit = 0.83 * Math.cos(Math.PI / 6) / Math.cos(sector - Math.PI / 6)
      expect(radius).toBeLessThanOrEqual(hexLimit + 1e-5)
      if (radius <= 0.34 + 1e-6) expect(vertex.y).toBeCloseTo(0.002, 5)
    }

    // Every indexed face must have measurable area and face upward in the tabletop frame.
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const c = new THREE.Vector3()
    const ab = new THREE.Vector3()
    const ac = new THREE.Vector3()
    for (let i = 0; i < index!.count; i += 3) {
      const ia = index!.getX(i)
      const ib = index!.getX(i + 1)
      const ic = index!.getX(i + 2)
      a.fromBufferAttribute(position, ia)
      b.fromBufferAttribute(position, ib)
      c.fromBufferAttribute(position, ic)
      const area = ab.subVectors(b, a).cross(ac.subVectors(c, a))
      expect(area.length()).toBeGreaterThan(1e-7)
      expect(area.y).toBeGreaterThan(0)
    }
  })
})

describe('production and building scenery', () => {
  it('creates finite, tile-local forest and wheat groups', () => {
    const forest = createForestScenery(31)
    const wheat = createWheatScenery(31)
    const forestBounds = finiteBounds(forest)
    const wheatBounds = finiteBounds(wheat)

    expect(forest.children.length).toBeGreaterThan(0)
    expect(wheat.children.length).toBeGreaterThan(0)
    for (const bounds of [forestBounds, wheatBounds]) {
      expect(bounds.min.y).toBeGreaterThanOrEqual(-1e-5)
      expect(bounds.max.y).toBeLessThanOrEqual(1)
      expect(Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x))).toBeLessThanOrEqual(1)
      expect(Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z))).toBeLessThanOrEqual(1)
    }
  })

  it('gives cities a taller, wider silhouette than settlements', () => {
    const settlement = createSettlement(0xe56b5d)
    const city = createCity(0xe56b5d)
    const settlementBounds = finiteBounds(settlement)
    const cityBounds = finiteBounds(city)

    expect(cityBounds.max.y - cityBounds.min.y).toBeGreaterThan(
      settlementBounds.max.y - settlementBounds.min.y,
    )
    expect(cityBounds.max.x - cityBounds.min.x).toBeGreaterThan(
      settlementBounds.max.x - settlementBounds.min.x,
    )
    expect(city.children.length).toBeGreaterThan(settlement.children.length)
  })
})
