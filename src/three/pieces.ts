import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

/** Shared, deliberately low-poly building pieces used by the board renderer. */

const geometries = {
  foundation: new RoundedBoxGeometry(0.36, 0.045, 0.32, 2, 0.018),
  wall: new RoundedBoxGeometry(0.30, 0.21, 0.25, 2, 0.018),
  wallWide: new RoundedBoxGeometry(0.43, 0.25, 0.30, 2, 0.02),
  tower: new RoundedBoxGeometry(0.145, 0.42, 0.22, 2, 0.014),
  lip: new RoundedBoxGeometry(0.34, 0.025, 0.30, 2, 0.009),
  lipWide: new RoundedBoxGeometry(0.47, 0.028, 0.34, 2, 0.01),
  opening: new RoundedBoxGeometry(0.072, 0.092, 0.012, 2, 0.006),
  window: new RoundedBoxGeometry(0.055, 0.053, 0.012, 2, 0.005),
  doorCity: new RoundedBoxGeometry(0.078, 0.125, 0.012, 2, 0.006),
}

function gableGeometry(width: number, height: number, depth: number) {
  const shape = new THREE.Shape()
  shape.moveTo(-width / 2, 0)
  shape.lineTo(width / 2, 0)
  shape.lineTo(0, height)
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: 0.009,
    bevelThickness: 0.008,
    curveSegments: 1,
  })
  geometry.translate(0, 0, -depth / 2)
  return geometry
}

const settlementRoof = gableGeometry(0.35, 0.14, 0.30)
const cityRoof = gableGeometry(0.23, 0.115, 0.32)
const towerRoof = gableGeometry(0.17, 0.10, 0.25)
const seamGeometry = new THREE.BoxGeometry(0.008, 0.16, 0.004)
const ridgeGeometry = new THREE.CylinderGeometry(0.012, 0.012, 0.31, 6)
const towerRidgeGeometry = new THREE.CylinderGeometry(0.012, 0.012, 0.25, 6)
const eaveGeometry = new THREE.BoxGeometry(0.38, 0.014, 0.022)
const eaveWideGeometry = new THREE.BoxGeometry(0.26, 0.014, 0.022)

const materials = new Map<number, {
  wall: THREE.MeshStandardMaterial
  roof: THREE.MeshStandardMaterial
  wood: THREE.MeshStandardMaterial
  dark: THREE.MeshStandardMaterial
  trim: THREE.MeshStandardMaterial
}>()
let woodTexture: THREE.Texture | null = null

function pieceMaterials(playerColor: number) {
  const key = playerColor >>> 0
  const existing = materials.get(key)
  if (existing) return existing
  const base = new THREE.Color(key)
  // Roof and walls stay clearly player-colored, while the wall is slightly softer.
  const result = {
    wall: new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(0.82), roughness: 0.82 }),
    roof: new THREE.MeshStandardMaterial({ color: base, roughness: 0.76 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x7e4f2f, roughness: 0.9 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x241c19, roughness: 0.95 }),
    trim: new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(0.60), roughness: 0.84 }),
  }
  if (woodTexture) {
    result.wall.map = woodTexture
    result.roof.map = woodTexture
  }
  materials.set(key, result)
  return result
}

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, name: string) {
  const value = new THREE.Mesh(geometry, material)
  value.name = name
  value.castShadow = true
  value.receiveShadow = true
  return value
}

function opening(material: THREE.Material, x: number, y: number, z: number, width: number, height: number, name: string) {
  const value = mesh(geometries.opening, material, name)
  value.scale.set(width / 0.072, height / 0.092, 1)
  value.position.set(x, y, z)
  return value
}

function roofDetails(group: THREE.Group, material: THREE.MeshStandardMaterial, eaveY: number, ridgeY: number, ridgeZ: number, tower = false) {
  const eave = mesh(tower ? eaveWideGeometry : eaveGeometry, material, 'roof eaves')
  eave.position.y = eaveY
  group.add(eave)
  const ridge = mesh(tower ? towerRidgeGeometry : ridgeGeometry, material, 'roof ridge')
  // Extruded gables run through Z, so the ridge follows that same depth axis.
  ridge.rotation.x = Math.PI / 2
  ridge.position.set(0, ridgeY, ridgeZ)
  group.add(ridge)
}

function addPlankSeam(group: THREE.Group, material: THREE.MeshStandardMaterial, x: number, y: number, z: number) {
  const seam = mesh(seamGeometry, material, 'subtle plank seam')
  seam.position.set(x, y, z)
  group.add(seam)
}

export function createSettlement(playerColor: number): THREE.Group {
  const mat = pieceMaterials(playerColor)
  const group = new THREE.Group()
  group.name = 'settlement'

  group.add(mesh(geometries.foundation, mat.wood, 'stone wood foundation'))
  const lip = mesh(geometries.lip, mat.trim, 'foundation lip')
  lip.position.y = 0.033
  group.add(lip)
  const wall = mesh(geometries.wall, mat.wall, 'painted house walls')
  wall.position.y = 0.145
  group.add(wall)

  const roof = mesh(settlementRoof, mat.roof, 'solid triangular gable roof')
  roof.position.y = 0.25
  group.add(roof)
  roofDetails(group, mat.roof, 0.255, 0.39, 0)

  // Inset openings sit just inside the front facade and are visibly recessed by their trim.
  group.add(opening(mat.dark, 0, 0.135, -0.133, 0.067, 0.088, 'recessed front door'))
  group.add(opening(mat.dark, 0, 0.135, 0.133, 0.067, 0.088, 'recessed visible door'))
  const window = mesh(geometries.window, mat.dark, 'recessed side window')
  window.rotation.y = Math.PI / 2
  window.position.set(0.153, 0.17, 0.015)
  group.add(window)
  addPlankSeam(group, mat.trim, -0.075, 0.15, -0.132)
  return group
}

export function createCity(playerColor: number): THREE.Group {
  const mat = pieceMaterials(playerColor)
  const group = new THREE.Group()
  group.name = 'city'

  group.add(mesh(geometries.foundation, mat.wood, 'city foundation'))
  const lip = mesh(geometries.lipWide, mat.trim, 'city foundation lip')
  lip.position.y = 0.034
  group.add(lip)
  const wall = mesh(geometries.wallWide, mat.wall, 'city main walls')
  wall.position.y = 0.17
  group.add(wall)

  // Two compact gabled wings read as a town hall, with a taller central watch tower.
  for (const x of [-0.115, 0.115]) {
    const roof = mesh(cityRoof, mat.roof, 'city wing triangular roof')
    roof.position.set(x, 0.285, 0)
    group.add(roof)
    const eave = mesh(eaveWideGeometry, mat.roof, 'city wing eave')
    eave.position.set(x, 0.29, 0)
    group.add(eave)
  }
  const tower = mesh(geometries.tower, mat.wall, 'tall city tower')
  tower.position.set(0, 0.285, 0.045)
  group.add(tower)
  const towerRoofMesh = mesh(towerRoof, mat.roof, 'tower triangular roof')
  towerRoofMesh.position.set(0, 0.495, 0.045)
  group.add(towerRoofMesh)
  roofDetails(group, mat.roof, 0.505, 0.595, 0.045, true)

  group.add(opening(mat.dark, 0, 0.145, -0.157, 0.074, 0.12, 'recessed city door'))
  group.add(opening(mat.dark, 0, 0.145, 0.157, 0.074, 0.12, 'recessed visible city door'))
  for (const x of [-0.105, 0.105]) {
    const window = mesh(geometries.window, mat.dark, 'recessed city window')
    window.position.set(x, 0.21, -0.157)
    group.add(window)
  }
  const towerWindow = mesh(geometries.window, mat.dark, 'recessed tower window')
  towerWindow.position.set(0, 0.36, -0.073)
  group.add(towerWindow)
  addPlankSeam(group, mat.trim, -0.105, 0.18, -0.157)
  addPlankSeam(group, mat.trim, 0.105, 0.18, -0.157)
  return group
}

/** Apply an optional wood grain to future and existing piece wall materials. */
export function setPieceWoodTexture(texture: THREE.Texture): void {
  woodTexture = texture
  for (const material of materials.values()) {
    material.wall.map = texture
    material.wall.needsUpdate = true
    material.roof.map = texture
    material.roof.needsUpdate = true
  }
}
