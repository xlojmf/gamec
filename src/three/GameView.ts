/**
 * GameView — the React-facing facade for the isolated Three.js renderer.
 *
 * React (via GameCanvas) feeds it plain state and receives events back:
 *   buildBoard(board)                 → rebuild the island
 *   setPlacements(placements)         → sync roads/settlements/cities
 *   setBuildMode({kind, player})      → show buildable ghost spots + picking
 *   onPick / onHover                  → callbacks to the UI layer
 *
 * Renderer modules under src/three own shared geometry; GameView bridges them to the board.
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Board, EdgeId, PortKind, VertexId } from '../game/board'
import { RESOURCE_LABELS, TERRAIN_INFO, type Resource } from '../game/terrain'
import { mulberry32 } from '../game/rng'
import { createCity, createSettlement, setPieceWoodTexture } from './pieces'
import { createForestScenery, createMountainScenery, createWheatScenery, setSceneryTextures } from './scenery'

export const PLAYER_COLORS = [0xd7443e, 0x3d7dd8, 0xe8963c, 0xefe6d5] as const
export const PLAYER_NAMES = ['Red', 'Blue', 'Orange', 'White'] as const
export const PLAYER_COUNT = 4

export interface VertexPlacement {
  player: number
  type: 'settlement' | 'city'
}
export interface EdgePlacement {
  player: number
}
export interface PlacementState {
  vertices: Map<VertexId, VertexPlacement>
  edges: Map<EdgeId, EdgePlacement>
}

export type BuildKind = 'settlement' | 'city' | 'road' | null
export interface BuildMode {
  kind: BuildKind
  player: number
  /** When set, ghosts show exactly these legal spots (engine-filtered). */
  allowedVertices?: Set<string> | null
  allowedEdges?: Set<string> | null
}

export interface HoverInfo {
  terrainLabel: string
  resourceLabel: Resource | null
  number: number | null
  /** Set when hovering a harbor dock: 'generic' (3:1) or the 2:1 resource. */
  portKind?: 'generic' | Resource
}

export interface PickTarget {
  kind: 'vertex' | 'edge' | 'tile'
  id: string
}

const TILE_HEIGHT = 0.3
const TILE_TOP = TILE_HEIGHT
const SKY = 0x173c42
const hexColor = (n: number) => '#' + n.toString(16).padStart(6, '0')

// ---------------------------------------------------------------------------
// Shared module-level caches (live for the app lifetime; never disposed)
// ---------------------------------------------------------------------------

const tileGeometry = new THREE.CylinderGeometry(0.97, 0.97, TILE_HEIGHT, 6)
const tileBorderGeometry = new THREE.CylinderGeometry(1, 1, 0.055, 6)
const borderMaterial = new THREE.MeshStandardMaterial({ color: 0xc8bd94, roughness: 0.88 })
const brassMaterial = new THREE.MeshStandardMaterial({ color: 0xb79b57, roughness: 0.42, metalness: 0.65 })

const terrainMaterials = new Map<string, THREE.MeshStandardMaterial>(
  Object.entries(TERRAIN_INFO).map(([terrain, info]) => [
    terrain,
    new THREE.MeshStandardMaterial({ color: info.color, roughness: 0.9, metalness: 0.02 }),
  ]),
)

const terrainSides = new Map(Object.entries(TERRAIN_INFO).map(([terrain, info]) => [terrain,
  new THREE.MeshStandardMaterial({ color: new THREE.Color(info.color).multiplyScalar(0.65), roughness: 0.95 }),
]))
const oceanMaterial = new THREE.MeshStandardMaterial({ color: 0x287a80, roughness: 0.7, metalness: 0.06 })
const frameMaterial = new THREE.MeshStandardMaterial({ color: 0x533926, roughness: 0.65 })
const tokenMaterial = new THREE.MeshStandardMaterial({ color: 0xf5ecd4, roughness: 0.65 })
let artLoading: Promise<void> | null = null
/** Shared materials load once, only in the browser. Failed slots retain their procedural colors. */
function loadArt() {
  if (artLoading) return artLoading
  artLoading = (async () => {
    const response = await fetch('/assets/astra/manifest.json')
    if (!response.ok) return
    const manifest = await response.json() as { terrains: Record<string, {top: string; side: string}>; water: string; frame: string; tokenPlate: string; details?: {rock?: string; needles?: string; wood?: string}; ui?: {dice?: string[]} }
    const loader = new THREE.TextureLoader()
    const apply = async (material: THREE.MeshStandardMaterial | undefined, url: string, repeat = 1) => {
      if (!material || !url) return
      try {
        const texture = await loader.loadAsync(url)
        texture.colorSpace = THREE.SRGBColorSpace
        texture.anisotropy = 4
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping
        texture.repeat.set(repeat, repeat)
        material.map = texture
        material.color.set(material === oceanMaterial ? 0x648f84 : 0xffffff)
        material.needsUpdate = true
      } catch { /* Art is optional; every slot has a usable procedural fallback. */ }
    }
    await Promise.all([
      ...Object.entries(manifest.terrains ?? {}).flatMap(([terrain, slot]) => [apply(terrainMaterials.get(terrain), slot.top), apply(terrainSides.get(terrain), slot.side)]),
      apply(oceanMaterial, manifest.water, 1), apply(frameMaterial, manifest.frame), apply(tokenMaterial, manifest.tokenPlate),
      ...([['rock', manifest.details?.rock, 2], ['needles', manifest.details?.needles, 1], ['wood', manifest.details?.wood, 2]] as const).map(async ([kind, url, repeat]) => {
        if (!url) return
        try {
          const texture = await loader.loadAsync(url)
          texture.colorSpace = THREE.SRGBColorSpace
          texture.anisotropy = 4
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping
          texture.repeat.set(repeat, repeat)
          if (kind === 'rock') setSceneryTextures({ rock: texture })
          else if (kind === 'needles') setSceneryTextures({ needles: texture })
          else setPieceWoodTexture(texture)
        } catch { /* Detail slots are optional and retain procedural fallbacks. */ }
      }),
    ])
  })().catch(() => { /* Missing manifest must never stop a match. */ })
  return artLoading
}

interface BuildingMaterials {
  road: THREE.MeshStandardMaterial
}
const buildingMaterials = PLAYER_COLORS.map(
  (c) =>
    ({
      road: new THREE.MeshStandardMaterial({ color: new THREE.Color(c).multiplyScalar(0.85), roughness: 0.7 }),
    }) satisfies BuildingMaterials,
)

// --- prop geometry/material cache ------------------------------------------
const propGeo = {
  leg: new THREE.CylinderGeometry(0.013, 0.018, 0.095, 5),
  sheepBody: new THREE.SphereGeometry(0.1, 10, 8),
  sheepHead: new THREE.SphereGeometry(0.05, 8, 6),
  clay: new THREE.DodecahedronGeometry(0.14, 0),
  dune: new THREE.SphereGeometry(0.17, 10, 8),
  robberBase: new THREE.CylinderGeometry(0.09, 0.13, 0.42, 10),
  robberHead: new THREE.SphereGeometry(0.1, 10, 8),
}
const propMat = {
  trunk: new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 1 }),
  sheepBody: new THREE.MeshStandardMaterial({ color: 0xf1ede2, roughness: 1 }),
  sheepHead: new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 1 }),
  clay: new THREE.MeshStandardMaterial({ color: 0xb35431, roughness: 0.95 }),
  rock: new THREE.MeshStandardMaterial({ color: 0xa0a18e, roughness: 0.98, flatShading: true }),
  dune: new THREE.MeshStandardMaterial({ color: 0xd8c58e, roughness: 1 }),
  robber: new THREE.MeshStandardMaterial({ color: 0x23252d, roughness: 0.5, metalness: 0.25 }),
}

// --- building geometry cache ------------------------------------------------
const buildingGeo = {
  road: new THREE.BoxGeometry(0.92, 0.13, 0.24),
  ghostVertex: new THREE.CircleGeometry(0.19, 24),
  ghostRoad: new THREE.BoxGeometry(0.92, 0.11, 0.24),
}

// --- number token textures ---------------------------------------------------
const tokenTextureCache = new Map<number, THREE.CanvasTexture>()
function tokenTexture(n: number): THREE.CanvasTexture {
  let tex = tokenTextureCache.get(n)
  if (tex) return tex
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const red = n === 6 || n === 8
  ctx.fillStyle = '#efe5ca'
  ctx.beginPath()
  ctx.arc(128, 128, 127, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#c0ab76'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(128, 128, 119, 0, Math.PI * 2)
  ctx.stroke()
  ctx.fillStyle = red ? '#b3392f' : '#3d3833'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold ${n >= 10 ? 124 : 148}px Georgia, "Times New Roman", serif`
  ctx.fillText(String(n), 128, 108)
  const pips = 6 - Math.abs(7 - n) // probability dots, as on real chits
  ctx.beginPath()
  for (let i = 0; i < pips; i++) {
    const x = 128 + (i - (pips - 1) / 2) * 22
    ctx.moveTo(x + 6, 216)
    ctx.arc(x, 216, 6.5, 0, Math.PI * 2)
  }
  ctx.fill()
  tex = new THREE.CanvasTexture(canvas)
  tex.anisotropy = 4
  tex.colorSpace = THREE.SRGBColorSpace
  tokenTextureCache.set(n, tex)
  return tex
}

// --- harbor / port markers ----------------------------------------------------
// Each port renders as a wooden dock with a sign: "2:1" + resource color/icon
// for special harbors, "3:1 ?" for generic ones. All textures/materials are
// cached per kind (6 variants total, shared by every board).

const portGeo = {
  dock: new THREE.BoxGeometry(0.85, 0.07, 0.34),
  mooring: new THREE.CylinderGeometry(0.035, 0.04, 0.22, 8),
  signPost: new THREE.CylinderGeometry(0.026, 0.032, 0.52, 8),
  sign: new THREE.CircleGeometry(0.24, 48),
  plank: new THREE.BoxGeometry(0.085, 0.025, 0.36),
  hull: new THREE.SphereGeometry(1, 12, 8),
}
const portMat = {
  wood: new THREE.MeshStandardMaterial({ color: 0x8a6a44, roughness: 0.85 }),
  woodDark: new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.9 }),
}

const portSignMaterialCache = new Map<PortKind, THREE.MeshStandardMaterial>()
function portSignMaterial(kind: PortKind): THREE.MeshStandardMaterial {
  let mat = portSignMaterialCache.get(kind)
  if (mat) return mat
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const bg = '#f3e3bc'
  // rounded background plate
  const r = 34
  ctx.beginPath()
  ctx.moveTo(r, 8)
  ctx.arcTo(248, 8, 248, 248, r)
  ctx.arcTo(248, 248, 8, 248, r)
  ctx.arcTo(8, 248, 8, 8, r)
  ctx.arcTo(8, 8, 248, 8, r)
  ctx.closePath()
  ctx.fillStyle = bg
  ctx.fill()
  ctx.lineWidth = 10
  ctx.strokeStyle = '#b18a4d'
  ctx.stroke()
  // ratio
  ctx.fillStyle = '#314b42'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = 'bold 92px Georgia, serif'
  ctx.fillText(kind === 'generic' ? '3:1' : '2:1', 128, 92)
  ctx.font = 'bold 30px Georgia, serif'
  ctx.fillText(kind === 'generic' ? 'ANY' : RESOURCE_LABELS[kind].toUpperCase(), 128, 178)
  const tex = new THREE.CanvasTexture(canvas)
  tex.anisotropy = 4
  tex.colorSpace = THREE.SRGBColorSpace
  mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 })
  portSignMaterialCache.set(kind, mat)
  return mat
}

function portHoverInfo(kind: PortKind): HoverInfo {
  return kind === 'generic'
    ? { terrainLabel: '3:1 Harbor', resourceLabel: null, number: null, portKind: kind }
    : { terrainLabel: `${RESOURCE_LABELS[kind]} Harbor · 2:1`, resourceLabel: kind, number: null, portKind: kind }
}

// --- dice ---------------------------------------------------------------------
// BoxGeometry material slot order is [+x, -x, +y, -y, +z, -z]; opposite faces
// sum to 7 (1/6, 2/5, 3/4) like a real die. Textures are built lazily because
// they need `document` (SSR-safe).

const DIE_SIZE = 0.34
const DIE_REST_Y = 0.15 // half die above the ocean surface (top ≈ -0.02)
const dieGeometry = new THREE.BoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE)
const dieSlotValues = [1, 6, 2, 5, 3, 4] as const // per material slot above
const DIE_NORMALS: Record<number, THREE.Vector3> = {
  1: new THREE.Vector3(1, 0, 0),
  6: new THREE.Vector3(-1, 0, 0),
  2: new THREE.Vector3(0, 1, 0),
  5: new THREE.Vector3(0, -1, 0),
  3: new THREE.Vector3(0, 0, 1),
  4: new THREE.Vector3(0, 0, -1),
}

/** 3×3 pip grid positions per face value (col, row), shared layout as the UI dice. */
const PIP_SPOTS: Record<number, [number, number][]> = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [2, 0], [0, 2], [2, 2]],
  5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
  6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
}

const dieFaceTextureCache = new Map<number, THREE.CanvasTexture>()
function dieFaceTexture(v: number): THREE.CanvasTexture {
  let tex = dieFaceTextureCache.get(v)
  if (tex) return tex
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#f6f1e2'
  ctx.fillRect(0, 0, 256, 256)
  ctx.strokeStyle = 'rgba(60, 48, 30, 0.18)'
  ctx.lineWidth = 12
  ctx.strokeRect(6, 6, 244, 244)
  ctx.fillStyle = '#2e2a33'
  for (const [c, r] of PIP_SPOTS[v]) {
    ctx.beginPath()
    ctx.arc(56 + c * 72, 56 + r * 72, 27, 0, Math.PI * 2)
    ctx.fill()
  }
  tex = new THREE.CanvasTexture(canvas)
  tex.anisotropy = 4
  tex.colorSpace = THREE.SRGBColorSpace
  dieFaceTextureCache.set(v, tex)
  return tex
}

let dieMaterials: THREE.MeshStandardMaterial[] | null = null
function getDieMaterials(): THREE.MeshStandardMaterial[] {
  if (!dieMaterials) {
    dieMaterials = dieSlotValues.map(
      (v) => new THREE.MeshStandardMaterial({ map: dieFaceTexture(v), color: 0xffffff, roughness: 0.5, metalness: 0, emissive: 0xf6ecd4, emissiveIntensity: 0.12 }),
    )
  }
  return dieMaterials
}

/** Quaternion that brings face `v` of an unrotated die to point up. */
function dieFaceUpQuaternion(v: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(DIE_NORMALS[v], new THREE.Vector3(0, 1, 0))
}

interface DieAnim {
  mesh: THREE.Mesh
  from: THREE.Vector3
  target: THREE.Vector3
  spinAxis: THREE.Vector3
  spinRate: number
  finalQuat: THREE.Quaternion
  settleFrom: THREE.Quaternion | null
  t: number // starts negative → per-die throw delay
  settled: boolean
}

const ROBBER_TILE_BASE_OPACITY = 0.14
const robberTileGeometry = new THREE.CylinderGeometry(0.97, 0.97, 0.035, 6)

// ---------------------------------------------------------------------------
// GameView
// ---------------------------------------------------------------------------

export class GameView {
  private container: HTMLElement
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private resizeObserver: ResizeObserver
  private raf = 0
  private lastFrame = performance.now()
  private elapsed = 0

  // scene groups
  private boardGroup = new THREE.Group()
  private buildingsGroup = new THREE.Group()
  private ghostsGroup = new THREE.Group()
  private diceGroup = new THREE.Group()
  private robberTilesGroup = new THREE.Group()
  private waterMesh: THREE.Mesh | null = null
  private oceanGroup = new THREE.Group()
  private sceneryGroup = new THREE.Group()
  private reducedMotion = false
  private placementAnimations: {object: THREE.Object3D; y: number; elapsed: number}[] = []

  // lookups
  private tileMeshes = new Map<string, THREE.Mesh>()
  private ghostVertexMeshes = new Map<string, THREE.Mesh>()
  private ghostEdgeMeshes = new Map<string, THREE.Mesh>()
  private board: Board | null = null
  private disposables: Array<{ dispose: () => void }> = []

  // interaction state
  private mode: BuildMode = { kind: null, player: 0 }
  private placements: PlacementState = { vertices: new Map(), edges: new Map() }
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private hoveredGhost: THREE.Mesh | null = null
  private hoverHex: THREE.Mesh
  private downAt = { x: 0, y: 0, t: 0 }

  // camera intro animation
  private intro = { active: false, t: 0, from: new THREE.Vector3(), to: new THREE.Vector3() }

  // dice
  private diceMeshes: THREE.Mesh[] = []
  private diceAnim: { dice: DieAnim[] } | null = null

  // robber
  private robber: THREE.Group | null = null
  private robberTileId: string | null = null
  private robberHop: { t: number; from: THREE.Vector3; to: THREE.Vector3 } | null = null
  private robberMode = false
  private robberTileMeshes = new Map<string, THREE.Mesh>()
  private hoveredRobberTile: THREE.Mesh | null = null
  private productionPulses: { mesh: THREE.Mesh; t: number }[] = []
  private portPickMeshes: THREE.Mesh[] = []

  // public callbacks
  onPick: ((target: PickTarget) => void) | null = null
  onHover: ((info: HoverInfo | null) => void) | null = null
  onRollDone: (() => void) | null = null

  constructor(container: HTMLElement) {
    this.container = container
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    void loadArt()

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.17
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.touchAction = 'none'
    container.appendChild(this.renderer.domElement)

    this.scene.background = null
    this.scene.fog = new THREE.Fog(SKY, 20, 36)

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    this.camera.position.set(0, 8.8, 10.0)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 0.2, 0.8)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.06
    this.controls.minDistance = 5
    this.controls.maxDistance = 18
    this.controls.maxPolarAngle = 1.38 // never dip below the horizon
    this.controls.minPolarAngle = 0.12
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    }

    this.setupLights()
    this.scene.add(this.boardGroup, this.buildingsGroup, this.ghostsGroup, this.diceGroup, this.robberTilesGroup)

    // translucent hover highlight overlay for tiles
    this.hoverHex = new THREE.Mesh(
      new THREE.CylinderGeometry(1.01, 1.01, 0.03, 6),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false }),
    )
    this.hoverHex.rotation.y = Math.PI / 6
    this.hoverHex.visible = false
    this.scene.add(this.hoverHex)

    const el = this.renderer.domElement
    el.addEventListener('pointermove', this.onPointerMove)
    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointerup', this.onPointerUp)
    el.addEventListener('pointerleave', this.onPointerLeave)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
    this.animate()
  }

  // -- public API -------------------------------------------------------------

  buildBoard(board: Board) {
    this.board = board
    this.clearGroup(this.boardGroup)
    this.clearGroup(this.sceneryGroup)
    this.clearGroup(this.oceanGroup)
    for (const item of this.disposables) item.dispose()
    this.disposables = []
    this.waterMesh = null
    for (const pulse of this.productionPulses) (pulse.mesh.material as THREE.Material).dispose()
    this.productionPulses = []
    this.tileMeshes.clear()

    for (const tile of board.tiles) {
      const border = new THREE.Mesh(tileBorderGeometry, borderMaterial)
      border.rotation.y = Math.PI / 6
      border.position.set(tile.x, TILE_TOP - 0.04, tile.z)
      border.receiveShadow = true
      this.boardGroup.add(border)
      const top = terrainMaterials.get(tile.terrain)!
      const side = terrainSides.get(tile.terrain)!
      const mesh = new THREE.Mesh(tileGeometry, [side, top, side])
      mesh.rotation.y = Math.PI / 6 // align cylinder corners to 60°·k (pointy-top)
      mesh.position.set(tile.x, TILE_HEIGHT / 2, tile.z)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.userData.tileId = tile.id
      this.boardGroup.add(mesh)
      this.tileMeshes.set(tile.id, mesh)

      this.addTileProps(tile)
      if (tile.numberToken !== null) this.addNumberToken(tile)
    }

    this.addRobber(board)
    this.buildRobberTiles(board)
    this.addOcean()
    this.addPorts(board)
    this.addCoast(board)
    this.batchScenery()
    this.rebuildGhosts()
    this.setPlacements(this.placements)

    // cinematic intro fly-in on every new island
    this.intro = {
      active: !this.reducedMotion,
      t: 0,
      from: new THREE.Vector3(6, 15, 14),
      to: new THREE.Vector3(0, 8.8, 10.0),
    }
    this.controls.enabled = this.reducedMotion
  }

  resetCamera() {
    this.intro.active = false
    this.controls.enabled = true
    this.controls.target.set(0, 0.2, 0.8)
    this.camera.position.set(0, 8.8, 10.0)
    this.controls.update()
  }

  zoom(direction: 'in' | 'out') {
    this.intro.active = false
    this.controls.enabled = true
    const offset = this.camera.position.clone().sub(this.controls.target)
    offset.setLength(THREE.MathUtils.clamp(offset.length() * (direction === 'in' ? 0.86 : 1.16), this.controls.minDistance, this.controls.maxDistance))
    this.camera.position.copy(this.controls.target).add(offset)
    this.controls.update()
  }

  setPlacements(placements: PlacementState) {
    const previous = this.placements
    this.placements = placements
    this.placementAnimations = []
    this.clearGroup(this.buildingsGroup)

    for (const [edgeId, placement] of placements.edges) {
      if (!this.board) break
      const edge = this.board.edgeById.get(edgeId)
      if (!edge) continue
      const [a, b] = edge.vertexIds.map((id) => this.board!.vertexById.get(id)!)
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }
      const angle = Math.atan2(b.z - a.z, b.x - a.x)
      const mesh = new THREE.Mesh(buildingGeo.road, buildingMaterials[placement.player].road)
      mesh.rotation.y = -angle
      mesh.position.set(mid.x, TILE_TOP + 0.065, mid.z)
      mesh.castShadow = true
      this.buildingsGroup.add(mesh)
      if (!previous.edges.has(edgeId)) this.animatePlacement(mesh)
    }

    for (const [vertexId, placement] of placements.vertices) {
      if (!this.board) break
      const v = this.board.vertexById.get(vertexId)
      if (!v) continue
      const group =
        placement.type === 'city' ? createCity(PLAYER_COLORS[placement.player]) : createSettlement(PLAYER_COLORS[placement.player])
      group.position.set(v.x, TILE_TOP, v.z)
      group.rotation.y = mulberry32(hashString(vertexId))() * Math.PI // deterministic variety
      this.buildingsGroup.add(group)
      if (previous.vertices.get(vertexId)?.type !== placement.type) this.animatePlacement(group)
    }

    this.refreshGhosts()
  }

  private animatePlacement(object: THREE.Object3D) {
    if (this.reducedMotion) return
    const y = object.position.y
    object.position.y += 0.45
    this.placementAnimations.push({ object, y, elapsed: 0 })
  }

  setBuildMode(mode: BuildMode) {
    this.mode = mode
    this.ghostsGroup.visible = mode.kind !== null
    this.refreshGhosts()
  }

  /** Throw two dice that tumble, bounce and settle showing die1/die2 face-up. */
  rollDice(die1: number, die2: number) {
    if (this.diceMeshes.length === 0) this.createDice()
    const restY = DIE_REST_Y
    const spawns = [new THREE.Vector3(-4.4, 2.9, 7.3), new THREE.Vector3(4.4, 3.2, 7.4)]
    const targets = [new THREE.Vector3(-0.48, restY, 4.75), new THREE.Vector3(0.48, restY, 4.75)]
    const values = [die1, die2]
    const dice: DieAnim[] = this.diceMeshes.map((mesh, i) => {
      const target = targets[i].clone()
      target.x += (Math.random() - 0.5) * 0.3
      target.z += (Math.random() - 0.5) * 0.2
      const spinAxis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
      const finalQuat = new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2)
        .multiply(dieFaceUpQuaternion(values[i]))
      mesh.visible = true
      mesh.scale.setScalar(1)
      mesh.position.copy(spawns[i])
      mesh.quaternion.identity()
      return {
        mesh,
        from: spawns[i].clone(),
        target,
        spinAxis,
        spinRate: 9 + Math.random() * 5,
        finalQuat,
        settleFrom: null,
        t: -0.09 * i,
        settled: false,
      }
    })
    this.diceAnim = { dice }
  }

  /** Move the robber to a tile (animated hop unless `animate` is false). */
  setRobberTile(tileId: string, animate = true) {
    if (!this.board || !this.robber || tileId === this.robberTileId) return
    const tile = this.board.tileById.get(tileId)
    if (!tile) return
    this.robberTileId = tileId
    this.refreshRobberTiles()
    if (animate) {
      this.robberHop = { t: 0, from: this.robber.position.clone(), to: this.robberAnchor(tile) }
    } else {
      this.robber.position.copy(this.robberAnchor(tile))
    }
  }

  /**
   * Robber stand point: beside the number chit, not under it. The numeral
   * sprite renders on top of everything (depthTest off), so a robber standing
   * at the tile centre is invisible — offset toward the tile's outer rim
   * (away from the island centre; centre tile falls back to camera side).
   */
  private robberAnchor(tile: { x: number; z: number }): THREE.Vector3 {
    const len = Math.hypot(tile.x, tile.z)
    const dirX = len > 0.001 ? tile.x / len : 0
    const dirZ = len > 0.001 ? tile.z / len : 1
    return new THREE.Vector3(tile.x + dirX * 0.42, TILE_TOP, tile.z + dirZ * 0.42)
  }

  /** Robber mode: highlight every tile the robber may move to and pick clicks. */
  setRobberMode(active: boolean) {
    this.robberMode = active
    this.robberTilesGroup.visible = active
    if (!active) {
      this.hoveredRobberTile = null
      this.container.style.cursor = 'default'
    }
    this.refreshRobberTiles()
  }

  /** Flash a green pulse over tiles that just produced. */
  showProduction(tileIds: string[]) {
    if (!this.board) return
    for (const id of tileIds) {
      const tile = this.board.tileById.get(id)
      if (!tile) continue
      const mesh = new THREE.Mesh(
        robberTileGeometry,
        new THREE.MeshBasicMaterial({ color: 0x8fd98f, transparent: true, opacity: 0, depthWrite: false }),
      )
      mesh.rotation.y = Math.PI / 6
      mesh.position.set(tile.x, TILE_TOP + 0.032, tile.z)
      this.boardGroup.add(mesh)
      this.productionPulses.push({ mesh, t: 0 })
    }
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.resizeObserver.disconnect()
    this.controls.dispose()
    const el = this.renderer.domElement
    el.removeEventListener('pointermove', this.onPointerMove)
    el.removeEventListener('pointerdown', this.onPointerDown)
    el.removeEventListener('pointerup', this.onPointerUp)
    el.removeEventListener('pointerleave', this.onPointerLeave)
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    this.hoverHex.geometry.dispose()
    ;(this.hoverHex.material as THREE.Material).dispose()
    this.renderer.dispose()
    el.remove()
  }

  // -- scene construction -------------------------------------------------------

  private setupLights() {
    this.scene.add(new THREE.HemisphereLight(0xd3e5da, 0x626551, 1.2))

    const sun = new THREE.DirectionalLight(0xffe2ad, 2.5)
    sun.position.set(-4, 8, 5)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -7
    sun.shadow.camera.right = 7
    sun.shadow.camera.top = 7
    sun.shadow.camera.bottom = -7
    sun.shadow.camera.near = 2
    sun.shadow.camera.far = 30
    sun.shadow.bias = -0.0004
    this.scene.add(sun)

    const fill = new THREE.DirectionalLight(0xbfd4e8, 0.35)
    fill.position.set(-6, 6, -6)
    this.scene.add(fill)
  }

  private addNumberToken(tile: { x: number; z: number; numberToken: number | null }) {
    const n = tile.numberToken!
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.325, 0.335, 0.065, 48),
      brassMaterial,
    )
    disc.position.set(tile.x, TILE_TOP + 0.03, tile.z)
    disc.receiveShadow = true
    this.boardGroup.add(disc)
    this.disposables.push(disc.geometry)

    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.62, 0.62),
      new THREE.MeshBasicMaterial({ map: tokenTexture(n), transparent: true, depthTest: false, depthWrite: false }),
    )
    label.rotation.x = -Math.PI / 2
    label.position.set(tile.x, TILE_TOP + 0.08, tile.z)
    label.renderOrder = 5 // Keep every numeral (including 12) readable through scenery.
    this.boardGroup.add(label)
    this.disposables.push(label.geometry, label.material as THREE.Material)
  }

  private addTileProps(tile: { id: string; x: number; z: number; terrain: import('../game/terrain').Terrain }) {
    const seed = hashString(tile.id)
    if (tile.terrain === 'mountains') {
      const mountain = createMountainScenery(seed)
      mountain.position.set(tile.x, TILE_TOP, tile.z)
      this.sceneryGroup.add(mountain)
      // This generated ridge is board-specific and must be released on rebuild.
      this.disposables.push(mountain.geometry)
      return
    }
    if (tile.terrain === 'forest' || tile.terrain === 'fields') {
      const scenery = tile.terrain === 'forest' ? createForestScenery(seed) : createWheatScenery(seed)
      scenery.position.set(tile.x, TILE_TOP, tile.z)
      this.sceneryGroup.add(scenery)
      return
    }
    const rnd = mulberry32(hashString(tile.id))
    const count = tile.terrain === 'pasture' ? 5 : tile.terrain === 'hills' ? 12 : 4
    for (let i = 0; i < count; i++) {
      const angle = i / count * Math.PI * 2 + rnd() * 0.28
      const radius = 0.5 + rnd() * 0.23
      const prop = new THREE.Group()
      prop.position.set(tile.x + Math.cos(angle) * radius, TILE_TOP, tile.z + Math.sin(angle) * radius)
      prop.rotation.y = rnd() * Math.PI * 2
      if (tile.terrain === 'pasture') {
        const body = new THREE.Mesh(propGeo.sheepBody, propMat.sheepBody)
        body.position.y = 0.13
        body.scale.set(0.8, 0.8, 1.25)
        const head = new THREE.Mesh(propGeo.sheepHead, propMat.sheepHead)
        head.position.set(0, 0.16, 0.13)
        prop.add(body, head)
        for (const x of [-0.045, 0.045]) for (const z of [-0.065, 0.065]) {
          const leg = new THREE.Mesh(propGeo.leg, propMat.sheepHead)
          leg.position.set(x, 0.05, z)
          prop.add(leg)
        }
      } else if (tile.terrain === 'hills') {
        const rock = new THREE.Mesh(propGeo.clay, i % 3 === 0 ? propMat.trunk : propMat.clay)
        rock.scale.set(1.2, 0.8 + rnd(), 1)
        rock.position.y = 0.08
        prop.add(rock)
      } else {
        const dune = new THREE.Mesh(propGeo.dune, propMat.dune)
        dune.scale.set(1.5, 0.25, 0.8)
        prop.add(dune)
      }
      this.sceneryGroup.add(prop)
    }
  }

  private addCoast(board: Board) {
    const rnd = mulberry32(board.seed)
    for (const edge of board.edges.filter(edge => edge.tileIds.length === 1 && !edge.portId)) {
      const [a, b] = edge.vertexIds.map(id => board.vertexById.get(id)!)
      const tile = board.tileById.get(edge.tileIds[0])!
      const mid = new THREE.Vector3((a.x + b.x) / 2, 0, (a.z + b.z) / 2)
      const out = mid.clone().sub(new THREE.Vector3(tile.x, 0, tile.z)).normalize()
      for (let stone = 0; stone < 3; stone++) {
        const rock = new THREE.Mesh(propGeo.clay, propMat.rock)
        rock.position.set(mid.x + out.x * 0.12 + (rnd() - 0.5) * 0.42, -0.015, mid.z + out.z * 0.12 + (rnd() - 0.5) * 0.42)
        rock.scale.set(0.6 + rnd() * 0.8, 0.5 + rnd() * 0.5, 0.7 + rnd() * 0.8)
        rock.rotation.y = rnd() * 6
        this.sceneryGroup.add(rock)
      }
    }
  }

  /** Batch repeated scenery so the richer island adds detail without hundreds of draw calls. */
  private batchScenery() {
    const batches = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; matrices: THREE.Matrix4[] }>()
    this.sceneryGroup.updateMatrixWorld(true)
    this.sceneryGroup.traverse(object => {
      if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return
      const key = object.geometry.uuid + object.material.uuid
      let batch = batches.get(key)
      if (!batch) { batch = { geometry: object.geometry, material: object.material, matrices: [] }; batches.set(key, batch) }
      batch.matrices.push(object.matrixWorld.clone())
    })
    for (const batch of batches.values()) {
      const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, batch.matrices.length)
      batch.matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix))
      mesh.castShadow = mesh.receiveShadow = true
      mesh.computeBoundingSphere()
      this.boardGroup.add(mesh)
      this.disposables.push(mesh)
    }
    this.sceneryGroup.clear()
  }

  private addRobber(board: Board) {
    const desert = board.tileById.get(board.desertTileId)!
    if (!this.robber) {
      const g = new THREE.Group()
      const base = new THREE.Mesh(propGeo.robberBase, propMat.robber)
      base.position.y = 0.21
      base.castShadow = true
      const head = new THREE.Mesh(propGeo.robberHead, propMat.robber)
      head.position.y = 0.48
      head.castShadow = true
      g.add(base, head)
      g.scale.setScalar(1.2) // city-sized pawn — readable even among scenery
      this.robber = g
    }
    this.robberTileId = board.desertTileId
    this.robber.position.copy(this.robberAnchor(desert))
    this.boardGroup.add(this.robber)
  }

  /** Translucent red overlays marking legal robber destinations. */
  private buildRobberTiles(board: Board) {
    this.clearGroup(this.robberTilesGroup)
    this.robberTileMeshes.clear()
    for (const tile of board.tiles) {
      const mesh = new THREE.Mesh(
        robberTileGeometry,
        new THREE.MeshBasicMaterial({
          color: 0xd7443e,
          transparent: true,
          opacity: ROBBER_TILE_BASE_OPACITY,
          depthWrite: false,
        }),
      )
      mesh.rotation.y = Math.PI / 6
      mesh.position.set(tile.x, TILE_TOP + 0.03, tile.z)
      mesh.userData.tileId = tile.id
      this.robberTilesGroup.add(mesh)
      this.robberTileMeshes.set(tile.id, mesh)
      this.disposables.push(mesh.material as THREE.Material)
    }
    this.robberTilesGroup.visible = this.robberMode
    this.refreshRobberTiles()
  }

  private refreshRobberTiles() {
    for (const [id, mesh] of this.robberTileMeshes) {
      mesh.visible = id !== this.robberTileId
      ;(mesh.material as THREE.MeshBasicMaterial).opacity = ROBBER_TILE_BASE_OPACITY
    }
  }

  private createDice() {
    for (let i = 0; i < 2; i++) {
      const mesh = new THREE.Mesh(dieGeometry, getDieMaterials())
      mesh.castShadow = true
      mesh.visible = false
      this.diceGroup.add(mesh)
      this.diceMeshes.push(mesh)
    }
  }

  /** Wooden docks + labeled signs for the 9 harbors, hoverable for trade info. */
  private addPorts(board: Board) {
    this.portPickMeshes = []
    for (const port of board.ports) {
      const edge = board.edgeById.get(port.edgeId)!
      const [a, b] = edge.vertexIds.map((id) => board.vertexById.get(id)!)
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }
      const tile = board.tileById.get(edge.tileIds[0])!
      const len = Math.hypot(mid.x - tile.x, mid.z - tile.z) || 1
      const out = { x: (mid.x - tile.x) / len, z: (mid.z - tile.z) / len } // outward normal
      const lat = { x: -out.z, z: out.x }
      const yaw = -Math.atan2(out.z, out.x)

      const g = new THREE.Group()

      // dock plank reaching from the shore into the water
      const dock = new THREE.Mesh(portGeo.dock, portMat.wood)
      dock.position.set(mid.x + out.x * 0.55, 0.02, mid.z + out.z * 0.55)
      dock.rotation.y = yaw
      dock.receiveShadow = true
      dock.userData.portKind = port.kind
      g.add(dock)

      // two mooring posts at the water end
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(portGeo.mooring, portMat.woodDark)
        post.position.set(mid.x + out.x * 0.85 + lat.x * side * 0.11, 0.1, mid.z + out.z * 0.85 + lat.z * side * 0.11)
        post.castShadow = true
        g.add(post)
      }

      // Low ivory trade medallion: legible from above without billboard signs.
      const face = new THREE.Mesh(portGeo.sign, portSignMaterial(port.kind))
      face.rotation.x = -Math.PI / 2
      face.position.set(mid.x + out.x * 0.34, 0.15, mid.z + out.z * 0.34)
      face.userData.portKind = port.kind
      g.add(face)
      this.portPickMeshes.push(face)
      // Separate narrow planks give the jetty a crafted edge.
      for (let plank = 0; plank < 8; plank++) {
        const board = new THREE.Mesh(portGeo.plank, portMat.woodDark)
        board.rotation.y = yaw
        board.position.set(mid.x + out.x * (0.2 + plank * 0.1), 0.068, mid.z + out.z * (0.2 + plank * 0.1))
        g.add(board)
      }
      const boat = new THREE.Group()
      boat.position.set(mid.x + out.x * 0.67 + lat.x * 0.33, 0.015, mid.z + out.z * 0.67 + lat.z * 0.33)
      boat.rotation.y = yaw
      const hull = new THREE.Mesh(portGeo.hull, portMat.woodDark)
      hull.scale.set(0.29, 0.075, 0.11)
      boat.add(hull)
      const mast = new THREE.Mesh(portGeo.signPost, portMat.wood)
      mast.position.y = 0.26
      boat.add(mast)
      const sailShape = new THREE.Shape()
      sailShape.moveTo(0, 0); sailShape.lineTo(0, 0.37); sailShape.quadraticCurveTo(0.22, 0.16, 0.21, 0); sailShape.closePath()
      const sail = new THREE.Mesh(new THREE.ShapeGeometry(sailShape), new THREE.MeshStandardMaterial({ color: 0xf5e4bc, roughness: 0.9, side: THREE.DoubleSide }))
      sail.position.set(0, 0.12, 0)
      this.disposables.push(sail.geometry, sail.material as THREE.Material)
      boat.add(sail)
      g.add(boat)
      this.portPickMeshes.push(dock)

      this.boardGroup.add(g)
    }
  }

  private addOcean() {
    const water = new THREE.Mesh(new THREE.CylinderGeometry(5.87, 5.87, 0.18, 6), oceanMaterial)
    water.rotation.y = Math.PI / 6
    water.position.y = -0.17
    water.receiveShadow = true

    const hexRing = (outer: number, inner: number, depth: number) => {
      const shape = new THREE.Shape()
      const hole = new THREE.Path()
      for (let i = 0; i <= 6; i++) {
        const angle = i * Math.PI / 3
        const x = Math.cos(angle), y = Math.sin(angle)
        if (i === 0) { shape.moveTo(x * outer, y * outer); hole.moveTo(x * inner, -y * inner) }
        else { shape.lineTo(x * outer, y * outer); hole.lineTo(x * inner, -y * inner) }
      }
      shape.holes.push(hole)
      const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: 0.025, bevelThickness: 0.025, bevelSegments: 2, steps: 1 })
      geometry.rotateX(-Math.PI / 2)
      return geometry
    }
    const frame = new THREE.Mesh(hexRing(6.14, 5.88, 0.27), frameMaterial)
    frame.position.y = -0.33
    frame.castShadow = frame.receiveShadow = true
    const inlay = new THREE.Mesh(hexRing(5.93, 5.895, 0.018), brassMaterial)
    inlay.position.y = -0.025
    const base = new THREE.Mesh(new THREE.CylinderGeometry(6.12, 6.18, 0.17, 6), frameMaterial)
    base.rotation.y = Math.PI / 6
    base.position.y = -0.38
    base.castShadow = true
    this.waterMesh = water
    this.disposables.push(water.geometry, frame.geometry, inlay.geometry, base.geometry)
    this.oceanGroup.add(base, frame, inlay, water)
    const nailGeometry = new THREE.SphereGeometry(0.048, 12, 8)
    this.disposables.push(nailGeometry)
    for (let corner = 0; corner < 6; corner++) {
      const nail = new THREE.Mesh(nailGeometry, brassMaterial)
      nail.scale.y = 0.45
      nail.position.set(Math.cos(corner * Math.PI / 3) * 5.99, -0.028, Math.sin(corner * Math.PI / 3) * 5.99)
      this.oceanGroup.add(nail)
    }
    this.boardGroup.add(this.oceanGroup)
  }

  // -- ghosts (build spot picking) ------------------------------------------------

  private rebuildGhosts() {
    this.clearGroup(this.ghostsGroup)
    this.ghostVertexMeshes.clear()
    this.ghostEdgeMeshes.clear()
    if (!this.board) return

    for (const v of this.board.vertices) {
      const mesh = new THREE.Mesh(
        buildingGeo.ghostVertex,
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.25, depthWrite: false }),
      )
      const outline = new THREE.Mesh(new THREE.RingGeometry(0.145, 0.17, 24), new THREE.MeshBasicMaterial({color:0xffe2a0, transparent:true, opacity:0.8, depthWrite:false}))
      outline.position.z = 0.002
      mesh.add(outline)
      this.disposables.push(outline.geometry, outline.material as THREE.Material)
      mesh.rotation.x = -Math.PI / 2
      mesh.position.set(v.x, TILE_TOP + 0.015, v.z)
      mesh.userData = { kind: 'vertex', id: v.id }
      this.ghostsGroup.add(mesh)
      this.ghostVertexMeshes.set(v.id, mesh)
      this.disposables.push(mesh.material as THREE.Material)
    }
    for (const e of this.board.edges) {
      const [a, b] = e.vertexIds.map((id) => this.board!.vertexById.get(id)!)
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }
      const mesh = new THREE.Mesh(
        buildingGeo.ghostRoad,
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false }),
      )
      mesh.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x)
      mesh.position.set(mid.x, TILE_TOP + 0.06, mid.z)
      mesh.userData = { kind: 'edge', id: e.id }
      this.ghostsGroup.add(mesh)
      this.ghostEdgeMeshes.set(e.id, mesh)
      this.disposables.push(mesh.material as THREE.Material)
    }
    this.refreshGhosts()
  }

  private refreshGhosts() {
    const { kind, player, allowedVertices, allowedEdges } = this.mode
    const color = new THREE.Color(PLAYER_COLORS[player])
    for (const [id, mesh] of this.ghostVertexMeshes) {
      // city ghosts float above the settlement they would upgrade
      mesh.position.y = TILE_TOP + (kind === 'city' ? 0.5 : 0.015)
      const building = this.placements.vertices.get(id)
      const active = allowedVertices
        ? allowedVertices.has(id)
        : kind === 'settlement'
          ? !building
          : kind === 'city'
            ? building?.type === 'settlement' && building.player === player
            : false
      mesh.visible = active
      if (active) (mesh.material as THREE.MeshBasicMaterial).color.copy(color)
    }
    for (const [id, mesh] of this.ghostEdgeMeshes) {
      const active = allowedEdges
        ? allowedEdges.has(id)
        : kind === 'road' && !this.placements.edges.has(id)
      mesh.visible = active
      if (active) (mesh.material as THREE.MeshBasicMaterial).color.copy(color)
    }
  }

  // -- events --------------------------------------------------------------------

  private onPointerMove = (ev: PointerEvent) => {
    if (!this.board) return
    this.setPointer(ev)

    // robber mode: highlight the hovered destination tile, suppress build ghosts
    if (this.robberMode) {
      const tileHits = this.raycaster.intersectObjects([...this.tileMeshes.values()], false)
      const tileMesh = tileHits[0]?.object as THREE.Mesh | undefined
      const overlay = tileMesh ? (this.robberTileMeshes.get(tileMesh.userData.tileId as string) ?? null) : null
      const target = overlay && overlay.visible ? overlay : null
      if (target !== this.hoveredRobberTile) {
        this.hoveredRobberTile = target
        this.container.style.cursor = target ? 'pointer' : 'default'
      }
      this.hoverHex.visible = false
      this.onHover?.(null)
      return
    }

    const ghosts = this.visibleGhosts()
    const ghostHits = this.raycaster.intersectObjects(ghosts, false)
    const ghost = (ghostHits[0]?.object as THREE.Mesh | undefined) ?? null

    if (ghost !== this.hoveredGhost) {
      if (this.hoveredGhost) this.setGhostHighlight(this.hoveredGhost, false)
      if (ghost) this.setGhostHighlight(ghost, true)
      this.hoveredGhost = ghost
      this.container.style.cursor = ghost ? 'pointer' : 'default'
    }

    if (!ghost) {
      const portHits = this.raycaster.intersectObjects(this.portPickMeshes, false)
      const portMesh = portHits[0]?.object as THREE.Mesh | undefined
      if (portMesh) {
        this.container.style.cursor = 'pointer'
        this.hoverHex.visible = false
        this.onHover?.(portHoverInfo(portMesh.userData.portKind as PortKind))
        return
      }
      this.container.style.cursor = 'default'
      const tileHits = this.raycaster.intersectObjects([...this.tileMeshes.values()], false)
      const tileMesh = tileHits[0]?.object as THREE.Mesh | undefined
      if (tileMesh) {
        const tile = this.board.tileById.get(tileMesh.userData.tileId as string)!
        const info = TERRAIN_INFO[tile.terrain]
        this.hoverHex.visible = true
        this.hoverHex.position.set(tile.x, TILE_TOP + 0.02, tile.z)
        this.onHover?.({
          terrainLabel: info.label,
          resourceLabel: info.resource ? info.resource : null,
          number: tile.numberToken,
        })
      } else {
        this.hoverHex.visible = false
        this.onHover?.(null)
      }
    } else {
      this.hoverHex.visible = false
    }
  }

  private onPointerDown = (ev: PointerEvent) => {
    this.downAt = { x: ev.clientX, y: ev.clientY, t: performance.now() }
  }

  private onPointerUp = (ev: PointerEvent) => {
    const moved = Math.hypot(ev.clientX - this.downAt.x, ev.clientY - this.downAt.y)
    const elapsed = performance.now() - this.downAt.t
    if (moved > 6 || elapsed > 600) return // it was a camera drag, not a click
    if (!this.board) return
    this.setPointer(ev)

    // robber mode: any highlighted tile click moves the robber
    if (this.robberMode) {
      const tileHits = this.raycaster.intersectObjects([...this.tileMeshes.values()], false)
      const tileMesh = tileHits[0]?.object as THREE.Mesh | undefined
      const tileId = tileMesh?.userData.tileId as string | undefined
      if (tileId && tileId !== this.robberTileId) this.onPick?.({ kind: 'tile', id: tileId })
      return
    }

    if (!this.mode.kind) return
    const hits = this.raycaster.intersectObjects(this.visibleGhosts(), false)
    const ghost = hits[0]?.object as THREE.Mesh | undefined
    if (ghost) {
      const { kind, id } = ghost.userData as { kind: 'vertex' | 'edge'; id: string }
      this.onPick?.({ kind, id })
    }
  }

  private onPointerLeave = () => {
    this.hoverHex.visible = false
    if (this.hoveredGhost) this.setGhostHighlight(this.hoveredGhost, false)
    this.hoveredGhost = null
    this.onHover?.(null)
  }

  private setPointer(ev: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.pointer, this.camera)
  }

  private visibleGhosts(): THREE.Mesh[] {
    return [...this.ghostVertexMeshes.values(), ...this.ghostEdgeMeshes.values()].filter((m) => m.visible)
  }

  private setGhostHighlight(mesh: THREE.Mesh, on: boolean) {
    const mat = mesh.material as THREE.MeshBasicMaterial
    mat.opacity = on ? 0.95 : mesh.userData.kind === 'vertex' ? 0.4 : 0.35
    mesh.scale.setScalar(on ? 1.18 : 1)
  }

  // -- loop ----------------------------------------------------------------------

  private resize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.camera.aspect = w / h
    this.camera.fov = this.camera.aspect >= 1.45 ? 40 : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(40 / 2)) * 1.45 / this.camera.aspect))
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
  }

  private animate = () => {
    this.raf = requestAnimationFrame(this.animate)
    const now = performance.now()
    const dt = Math.min((now - this.lastFrame) / 1000, 0.05)
    this.lastFrame = now
    const t = this.elapsed += dt
    this.placementAnimations = this.placementAnimations.filter(animation => {
      animation.elapsed = Math.min(1, animation.elapsed + dt / 0.32)
      animation.object.position.y = animation.y + 0.45 * Math.pow(1 - animation.elapsed, 3)
      return animation.elapsed < 1
    })

    if (this.intro.active) {
      this.intro.t = Math.min(1, this.intro.t + dt / 1.3)
      const e = 1 - Math.pow(1 - this.intro.t, 3) // ease-out cubic
      this.camera.position.lerpVectors(this.intro.from, this.intro.to, e)
      this.camera.lookAt(0, 0.2, 0.8)
      if (this.intro.t >= 1) {
        this.intro.active = false
        this.controls.enabled = true
        this.controls.update()
      }
    } else {
      this.controls.update()
    }

    if (this.waterMesh && !this.reducedMotion) this.waterMesh.position.y = -0.17 + Math.sin(t * 0.7) * 0.008

    this.updateDice(dt)
    this.updateRobber(dt, t)

    this.renderer.render(this.scene, this.camera)
  }

  private updateDice(dt: number) {
    if (!this.diceAnim) return
    const FLIGHT = 0.6
    const B1 = 0.26
    const B2 = 0.2
    const SETTLE = 0.34
    let allSettled = true

    for (const d of this.diceAnim.dice) {
      if (d.settled) continue
      d.t += dt
      if (d.t < 0) {
        allSettled = false
        continue
      }
      const t = d.t
      const restY = d.target.y
      const phase = t < FLIGHT ? 0 : t < FLIGHT + B1 ? 1 : t < FLIGHT + B1 + B2 ? 2 : 3

      if (phase === 0) {
        // throw: travel out, fall in, tumble fast
        const u = t / FLIGHT
        const horiz = 1 - (1 - u) * (1 - u)
        d.mesh.position.x = d.from.x + (d.target.x - d.from.x) * horiz
        d.mesh.position.z = d.from.z + (d.target.z - d.from.z) * horiz
        d.mesh.position.y = d.from.y + (restY - d.from.y) * u * u
        d.mesh.rotateOnWorldAxis(d.spinAxis, d.spinRate * dt)
        allSettled = false
      } else if (phase === 1 || phase === 2) {
        // bounces: vertical parabolas, tumbling decays per bounce
        const h = phase === 1 ? 0.55 : 0.18
        const dur = phase === 1 ? B1 : B2
        const u = (t - (phase === 1 ? FLIGHT : FLIGHT + B1)) / dur
        d.mesh.position.x = d.target.x
        d.mesh.position.z = d.target.z
        d.mesh.position.y = restY + h * 4 * u * (1 - u)
        d.mesh.rotateOnWorldAxis(d.spinAxis, d.spinRate * Math.pow(0.42, phase) * dt)
        allSettled = false
      } else {
        // settle: slerp to the exact face-up orientation with a little pop
        const u = Math.min(1, (t - FLIGHT - B1 - B2) / SETTLE)
        if (!d.settleFrom) d.settleFrom = d.mesh.quaternion.clone()
        const e = 1 - Math.pow(1 - u, 3)
        d.mesh.quaternion.slerpQuaternions(d.settleFrom, d.finalQuat, e)
        d.mesh.scale.setScalar(1 + 0.16 * Math.sin(Math.PI * u))
        d.mesh.position.y = restY
        if (u >= 1) {
          d.settled = true
          d.mesh.quaternion.copy(d.finalQuat)
          d.mesh.scale.setScalar(1)
        } else {
          allSettled = false
        }
      }
    }

    if (allSettled) {
      this.diceAnim = null
      this.onRollDone?.()
    }
  }

  private updateRobber(dt: number, t: number) {
    if (this.robberHop && this.robber) {
      const h = this.robberHop
      h.t += dt
      const u = Math.min(1, h.t / 0.55)
      this.robber.position.lerpVectors(h.from, h.to, u)
      this.robber.position.y += Math.sin(Math.PI * u) * 1.05
      this.robber.rotation.y += dt * 5
      if (u >= 1) {
        this.robberHop = null
        this.robber.rotation.y = 0
      }
    }
    if (this.robberTilesGroup.visible) {
      const base = ROBBER_TILE_BASE_OPACITY + 0.05 + 0.05 * Math.sin(t * 5)
      for (const mesh of this.robberTileMeshes.values()) {
        ;(mesh.material as THREE.MeshBasicMaterial).opacity = mesh === this.hoveredRobberTile ? 0.5 : base
      }
    }

    // production pulses: rise & fall once, then remove
    for (let i = this.productionPulses.length - 1; i >= 0; i--) {
      const p = this.productionPulses[i]
      p.t += dt
      const u = p.t / 1.4
      if (u >= 1) {
        p.mesh.removeFromParent()
        ;(p.mesh.material as THREE.Material).dispose()
        this.productionPulses.splice(i, 1)
      } else {
        ;(p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.sin(Math.PI * u) * 0.5
        p.mesh.scale.setScalar(1 + 0.06 * Math.sin(Math.PI * u))
      }
    }
  }

  private clearGroup(group: THREE.Group) {
    if (group === this.boardGroup) {
      // keep the ocean + robber meshes out of the disposables double-free path
      this.oceanGroup.removeFromParent()
      this.robber?.removeFromParent()
    }
    for (const child of [...group.children]) child.removeFromParent()
  }
}

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export { hexColor }
