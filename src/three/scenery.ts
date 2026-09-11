import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { mulberry32 } from '../game/rng'

// These reusable miniature parts remain in the renderer. The game state contains no meshes.
const TAU = Math.PI * 2
const stone = new THREE.MeshStandardMaterial({ color: 0xaeb5b9, roughness: 0.97, vertexColors: true })
// A little bounced green light keeps the fine branches readable in their own shadows.
const needles = new THREE.MeshStandardMaterial({ color: 0x466637, roughness: 1, vertexColors: true, emissive: 0x3a5125, emissiveIntensity: 0.55 })
const bark = new THREE.MeshStandardMaterial({ color: 0x62432b, roughness: 1 })
const straw = new THREE.MeshStandardMaterial({ color: 0xd5aa43, roughness: 1 })
const grain = new THREE.MeshStandardMaterial({ color: 0xf1cd68, roughness: 0.91 })
const trunkGeometry = new THREE.CylinderGeometry(0.019, 0.027, 0.22, 6).translate(0, 0.11, 0)

export function setSceneryTextures(textures: { rock?: THREE.Texture; needles?: THREE.Texture }) {
  if (textures.rock) {
    stone.map = stone.bumpMap = textures.rock
    stone.bumpScale = 0.022
    stone.color.set(0xe2e6e8)
    stone.needsUpdate = true
  }
  if (textures.needles) {
    needles.map = textures.needles
    needles.color.set(0xd5ddae)
    needles.needsUpdate = true
  }
}

function hexRadius(angle: number, radius: number) {
  const sector = ((angle % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3)
  return radius * Math.cos(Math.PI / 6) / Math.cos(sector - Math.PI / 6)
}

function insideHex(x: number, z: number, radius: number) {
  return Math.hypot(x, z) <= hexRadius(Math.atan2(z, x), radius)
}

/** A connected, triangulated slate ridge with an unobstructed central token clearing. */
export function createMountainGeometry(seed: number): THREE.BufferGeometry {
  const random = mulberry32(seed)
  const phase = random() * TAU
  const peaks = [
    { x: -0.29 + random() * 0.06, z: -0.43, h: 0.82 + random() * 0.15, wx: 0.48, wz: 0.36 },
    { x: 0.29, z: -0.38 + random() * 0.05, h: 0.68 + random() * 0.14, wx: 0.40, wz: 0.36 },
    { x: -0.55, z: 0.02, h: 0.42 + random() * 0.09, wx: 0.25, wz: 0.40 },
    { x: 0.52, z: 0.14, h: 0.29 + random() * 0.06, wx: 0.27, wz: 0.42 },
  ]
  const positions: number[] = [0, 0.002, 0]
  const colors: number[] = [0.85, 0.87, 0.9]
  const uvs: number[] = [0.5, 0.5]
  const indices: number[] = []
  const rings = 27
  const segments = 90
  for (let ring = 1; ring <= rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const angle = segment / segments * TAU
      const fraction = ring / rings
      const radius = hexRadius(angle, 0.83) * fraction
      const x = Math.cos(angle) * radius
      const z = Math.sin(angle) * radius
      let height = 0
      for (const peak of peaks) {
        const dx = (x - peak.x) / peak.wx
        const dz = (z - peak.z) / peak.wz
        // Angular folds give a sharp rock face, instead of round boulders or smooth cones.
        const folds = 1 + 0.13 * Math.sin(Math.atan2(dz, dx) * 7 + phase)
        height = Math.max(height, peak.h * Math.pow(Math.max(0, 1 - Math.hypot(dx, dz) * folds), 0.86))
      }
      const clearance = THREE.MathUtils.smoothstep(radius, 0.34, 0.43)
      const edge = 1 - THREE.MathUtils.smoothstep(fraction, 0.88, 1)
      const fissures = 0.018 * Math.sin(x * 71 + z * 27 + phase) * Math.sin(z * 43 - x * 11)
      height = Math.max(0, height + fissures) * clearance * edge + 0.002
      positions.push(x, height, z)
      uvs.push(x * 0.85 + height * 0.3 + 0.5, z * 0.85 + height * 0.48 + 0.5)
      const tone = 0.71 + Math.min(height, 1) * 0.25 + random() * 0.065
      colors.push(tone * 0.97, tone * 0.99, tone)
      const current = 1 + (ring - 1) * segments + segment
      const next = 1 + (ring - 1) * segments + (segment + 1) % segments
      if (ring === 1) indices.push(0, next, current)
      else {
        const inner = current - segments
        const innerNext = next - segments
        indices.push(inner, innerNext, current, innerNext, next, current)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

export function createMountainScenery(seed: number): THREE.Mesh {
  const mesh = new THREE.Mesh(createMountainGeometry(seed), stone)
  mesh.name = 'continuous slate ridges'
  mesh.castShadow = mesh.receiveShadow = true
  return mesh
}

/** Irregular, drooping branch whorls produce a fir silhouette at tabletop scale. */
function firGeometry(seed: number) {
  const random = mulberry32(seed)
  const positions: number[] = []
  const colors: number[] = []
  const uvs: number[] = []
  const triangle = (a: number[], b: number[], c: number[], tone: number) => {
    for (const p of [a, b, c]) {
      positions.push(...p)
      colors.push(tone * 0.94, tone, tone * 0.85)
      uvs.push(p[0] * 2.5 + 0.5, p[1] * 2)
    }
  }
  for (let tier = 0; tier < 8; tier++) {
    const y = 0.13 + tier * 0.063
    const radius = 0.17 * Math.pow(1 - tier / 9, 0.85)
    const segments = 24
    const outer: number[][] = []
    const inner: number[][] = []
    const angleOffset = tier * 0.61
    for (let j = 0; j < segments; j++) {
      const angle = j / segments * TAU + angleOffset
      const r = radius * (j % 2 ? 0.68 : 0.94 + random() * 0.13)
      outer.push([Math.cos(angle) * r, y + (j % 2 ? 0.023 : -random() * 0.025), Math.sin(angle) * r])
      inner.push([Math.cos(angle) * radius * 0.12, y + 0.16 - tier * 0.008, Math.sin(angle) * radius * 0.12])
    }
    for (let j = 0; j < segments; j++) {
      const k = (j + 1) % segments
      const tone = 0.71 + tier * 0.025 + random() * 0.20
      triangle(inner[j], outer[k], outer[j], tone)
      triangle(inner[j], inner[k], outer[k], tone)
      triangle([0, y + 0.016, 0], outer[j], outer[k], tone * 0.75)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.computeVertexNormals()
  return geometry
}
const firGeometries = [firGeometry(11), firGeometry(29), firGeometry(47)]

export function createForestScenery(seed: number): THREE.Group {
  const random = mulberry32(seed)
  const group = new THREE.Group()
  group.name = 'dense miniature fir forest'
  const planted: Array<{ x: number; z: number }> = []
  for (let attempt = 0; attempt < 500 && planted.length < 24; attempt++) {
    const x = random() * 1.5 - 0.75
    const z = random() * 1.5 - 0.75
    if (!insideHex(x, z, 0.75) || Math.hypot(x, z) < 0.47) continue
    if (planted.some(p => Math.hypot(x - p.x, z - p.z) < 0.19)) continue
    planted.push({ x, z })
    const tree = new THREE.Group()
    tree.name = 'fir tree'
    tree.position.set(x, 0, z)
    tree.rotation.y = random() * TAU
    const scale = 0.68 + random() * 0.34
    tree.scale.set(scale, scale * (0.9 + random() * 0.27), scale)
    tree.add(new THREE.Mesh(trunkGeometry, bark), new THREE.Mesh(firGeometries[planted.length % 3], needles))
    group.add(tree)
  }
  return group
}

// A sheaf has narrow curved stems, folded leaves, and paired kernels with fine awns.
function wheatGeometry() {
  const stems: THREE.BufferGeometry[] = []
  const ears: THREE.BufferGeometry[] = []
  const kernel = new THREE.SphereGeometry(1, 6, 4)
  const stem = new THREE.CylinderGeometry(0.0027, 0.0036, 1, 4)
  const awn = new THREE.CylinderGeometry(0.0007, 0.0011, 1, 3)
  for (let stalk = 0; stalk < 3; stalk++) {
    const x = (stalk - 1) * 0.023
    const z = stalk % 2 * 0.023
    const height = 0.20 + stalk * 0.023
    stems.push(stem.clone().scale(1, height, 1).rotateZ((stalk - 1) * 0.10).translate(x, height / 2, z))
    for (let leaf = 0; leaf < 2; leaf++) {
      const leafShape = new THREE.BufferGeometry()
      const side = leaf === 0 ? -1 : 1
      const y = height * (0.33 + leaf * 0.25)
      leafShape.setAttribute('position', new THREE.Float32BufferAttribute([
        x, y, z, x + side * 0.055, y + 0.068, z + 0.012, x + side * 0.01, y + 0.035, z + 0.015,
        x, y, z, x + side * 0.01, y + 0.035, z + 0.015, x + side * 0.055, y + 0.068, z + 0.012,
      ], 3))
      leafShape.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1], 2))
      leafShape.computeVertexNormals()
      // All merge inputs must have matching attributes and indexing.
      stems.push(leafShape)
    }
    for (let pair = 0; pair < 6; pair++) {
      for (const side of [-1, 1]) {
        const y = height + pair * 0.014
        ears.push(kernel.clone().scale(0.009, 0.019, 0.008).rotateZ(side * 0.53).translate(x + side * 0.006, y, z))
        stems.push(awn.clone().scale(1, 0.055, 1).rotateZ(side * 0.22).translate(x + side * 0.011, y + 0.028, z))
      }
    }
  }
  function merge(parts: THREE.BufferGeometry[]) {
    const plain = parts.map(part => part.index ? part.toNonIndexed() : part)
    const geometry = mergeGeometries(plain)!
    for (const part of new Set([...parts, ...plain])) part.dispose()
    return geometry
  }
  const result = { stems: merge(stems), ears: merge(ears) }
  kernel.dispose(); stem.dispose(); awn.dispose()
  return result
}
const wheat = wheatGeometry()

export function createWheatScenery(seed: number): THREE.Group {
  const random = mulberry32(seed)
  const group = new THREE.Group()
  group.name = 'golden rows of ripe wheat'
  for (let row = -6; row <= 6; row++) {
    for (let column = -7; column <= 7; column++) {
      const x = column * 0.098 + (random() - 0.5) * 0.03
      const z = row * 0.108 + (random() - 0.5) * 0.025
      if (!insideHex(x, z, 0.79) || Math.hypot(x, z) < 0.375) continue
      const sheaf = new THREE.Group()
      sheaf.name = 'wheat sheaf'
      sheaf.position.set(x, 0, z)
      sheaf.rotation.y = random() * 0.6 - 0.3
      sheaf.scale.setScalar(0.83 + random() * 0.23)
      sheaf.add(new THREE.Mesh(wheat.stems, straw), new THREE.Mesh(wheat.ears, grain))
      group.add(sheaf)
    }
  }
  return group
}
