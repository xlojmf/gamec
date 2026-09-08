/**
 * GameView — the ONLY place in the app that knows Three.js exists.
 *
 * React (via GameCanvas) feeds it plain state and receives events back:
 *   buildBoard(board)                 → rebuild the island
 *   setPlacements(placements)         → sync roads/settlements/cities
 *   setBuildMode({kind, player})      → show buildable ghost spots + picking
 *   onPick / onHover                  → callbacks to the UI layer
 *
 * Placeholder art is fully procedural; the GPT Astra art track (A2) will swap
 * materials/textures via a manifest without touching this architecture.
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Board, EdgeId, VertexId } from '../game/board'
import { TERRAIN_INFO, type Resource } from '../game/terrain'
import { mulberry32 } from '../game/rng'

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

export type BuildKind = 'settlement' | 'road' | null
export interface BuildMode {
  kind: BuildKind
  player: number
}

export interface HoverInfo {
  terrainLabel: string
  resourceLabel: Resource | null
  number: number | null
}

export interface PickTarget {
  kind: 'vertex' | 'edge' | 'tile'
  id: string
}

const TILE_HEIGHT = 0.3
const TILE_TOP = TILE_HEIGHT
const SKY = 0xc9e4ef
const hexColor = (n: number) => '#' + n.toString(16).padStart(6, '0')

// ---------------------------------------------------------------------------
// Shared module-level caches (live for the app lifetime; never disposed)
// ---------------------------------------------------------------------------

const tileGeometry = new THREE.CylinderGeometry(0.97, 0.97, TILE_HEIGHT, 6)

const terrainMaterials = new Map<string, THREE.MeshStandardMaterial>(
  Object.entries(TERRAIN_INFO).map(([terrain, info]) => [
    terrain,
    new THREE.MeshStandardMaterial({ color: info.color, roughness: 0.9, metalness: 0.02 }),
  ]),
)

interface BuildingMaterials {
  wall: THREE.MeshStandardMaterial
  roof: THREE.MeshStandardMaterial
  road: THREE.MeshStandardMaterial
}
const buildingMaterials = PLAYER_COLORS.map(
  (c) =>
    ({
      wall: new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }),
      roof: new THREE.MeshStandardMaterial({ color: new THREE.Color(c).multiplyScalar(0.62), roughness: 0.55 }),
      road: new THREE.MeshStandardMaterial({ color: new THREE.Color(c).multiplyScalar(0.85), roughness: 0.7 }),
    }) satisfies BuildingMaterials,
)

// --- prop geometry/material cache ------------------------------------------
const propGeo = {
  trunk: new THREE.CylinderGeometry(0.03, 0.045, 0.14, 5),
  foliage: new THREE.ConeGeometry(0.15, 0.44, 7),
  sheepBody: new THREE.SphereGeometry(0.1, 10, 8),
  sheepHead: new THREE.SphereGeometry(0.05, 8, 6),
  wheat: new THREE.ConeGeometry(0.075, 0.2, 6),
  clay: new THREE.SphereGeometry(0.13, 10, 8),
  peak: new THREE.ConeGeometry(0.2, 0.55, 6),
  snow: new THREE.ConeGeometry(0.08, 0.18, 6),
  dune: new THREE.SphereGeometry(0.17, 10, 8),
  robberBase: new THREE.CylinderGeometry(0.09, 0.13, 0.42, 10),
  robberHead: new THREE.SphereGeometry(0.1, 10, 8),
}
const propMat = {
  trunk: new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 1 }),
  foliage: new THREE.MeshStandardMaterial({ color: 0x1f5a36, roughness: 0.95 }),
  sheepBody: new THREE.MeshStandardMaterial({ color: 0xf1ede2, roughness: 1 }),
  sheepHead: new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 1 }),
  wheat: new THREE.MeshStandardMaterial({ color: 0xd9b64a, roughness: 0.9 }),
  clay: new THREE.MeshStandardMaterial({ color: 0xb35431, roughness: 0.95 }),
  peak: new THREE.MeshStandardMaterial({ color: 0x7f8590, roughness: 0.85 }),
  snow: new THREE.MeshStandardMaterial({ color: 0xf4f7fa, roughness: 0.6 }),
  dune: new THREE.MeshStandardMaterial({ color: 0xd8c58e, roughness: 1 }),
  robber: new THREE.MeshStandardMaterial({ color: 0x23252d, roughness: 0.5, metalness: 0.25 }),
}

// --- building geometry cache ------------------------------------------------
const buildingGeo = {
  settlementBase: new THREE.BoxGeometry(0.34, 0.2, 0.3),
  settlementRoof: new THREE.ConeGeometry(0.27, 0.22, 4),
  cityBase: new THREE.BoxGeometry(0.46, 0.2, 0.3),
  cityTower: new THREE.BoxGeometry(0.2, 0.34, 0.2),
  cityRoof: new THREE.ConeGeometry(0.17, 0.16, 4),
  cityTowerRoof: new THREE.ConeGeometry(0.15, 0.14, 4),
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
  ctx.fillStyle = red ? '#b3392f' : '#3d3833'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = 'bold 148px Georgia, "Times New Roman", serif'
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
      (v) => new THREE.MeshStandardMaterial({ map: dieFaceTexture(v), roughness: 0.35, metalness: 0.05 }),
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
  private clock = new THREE.Clock()

  // scene groups
  private boardGroup = new THREE.Group()
  private buildingsGroup = new THREE.Group()
  private ghostsGroup = new THREE.Group()
  private diceGroup = new THREE.Group()
  private robberTilesGroup = new THREE.Group()
  private waterMesh: THREE.Mesh | null = null

  // lookups
  private tileMeshes = new Map<string, THREE.Mesh>()
  private ghostVertexMeshes = new Map<string, THREE.Mesh>()
  private ghostEdgeMeshes = new Map<string, THREE.Mesh>()
  private board: Board | null = null
  private disposables: Array<THREE.Material | THREE.BufferGeometry> = []

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

  // public callbacks
  onPick: ((target: PickTarget) => void) | null = null
  onHover: ((info: HoverInfo | null) => void) | null = null
  onRollDone: (() => void) | null = null

  constructor(container: HTMLElement) {
    this.container = container

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.touchAction = 'none'
    container.appendChild(this.renderer.domElement)

    this.scene.background = new THREE.Color(SKY)
    this.scene.fog = new THREE.Fog(SKY, 20, 36)

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    this.camera.position.set(0, 8.2, 9.6)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 0.2, 0)
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
    this.tileMeshes.clear()

    for (const tile of board.tiles) {
      const mesh = new THREE.Mesh(tileGeometry, terrainMaterials.get(tile.terrain)!)
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
    this.rebuildGhosts()
    this.setPlacements(this.placements)

    // cinematic intro fly-in on every new island
    this.intro = {
      active: true,
      t: 0,
      from: new THREE.Vector3(6, 15, 14),
      to: new THREE.Vector3(0, 8.2, 9.6),
    }
    this.controls.enabled = false
  }

  setPlacements(placements: PlacementState) {
    this.placements = placements
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
    }

    for (const [vertexId, placement] of placements.vertices) {
      if (!this.board) break
      const v = this.board.vertexById.get(vertexId)
      if (!v) continue
      const group =
        placement.type === 'city' ? this.cityMesh(placement.player) : this.settlementMesh(placement.player)
      group.position.set(v.x, TILE_TOP, v.z)
      group.rotation.y = mulberry32(hashString(vertexId))() * Math.PI // deterministic variety
      this.buildingsGroup.add(group)
    }

    this.refreshGhosts()
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
    const targets = [new THREE.Vector3(-0.62, restY, 3.35), new THREE.Vector3(0.66, restY, 3.62)]
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
      this.robberHop = { t: 0, from: this.robber.position.clone(), to: new THREE.Vector3(tile.x, TILE_TOP, tile.z) }
    } else {
      this.robber.position.set(tile.x, TILE_TOP, tile.z)
    }
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
    this.renderer.dispose()
    el.remove()
  }

  // -- scene construction -------------------------------------------------------

  private setupLights() {
    this.scene.add(new THREE.HemisphereLight(0xdfeef7, 0x9a8f6f, 0.95))

    const sun = new THREE.DirectionalLight(0xfff2dd, 1.6)
    sun.position.set(6, 11, 4)
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
      new THREE.CylinderGeometry(0.32, 0.32, 0.06, 24),
      new THREE.MeshStandardMaterial({ color: 0xf5f1e6, roughness: 0.55 }),
    )
    disc.position.set(tile.x, TILE_TOP + 0.03, tile.z)
    disc.receiveShadow = true
    this.boardGroup.add(disc)
    this.disposables.push(disc.geometry, disc.material as THREE.Material)

    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.52, 0.52),
      new THREE.MeshBasicMaterial({ map: tokenTexture(n), transparent: true }),
    )
    label.rotation.x = -Math.PI / 2
    label.position.set(tile.x, TILE_TOP + 0.062, tile.z)
    this.boardGroup.add(label)
    this.disposables.push(label.geometry, label.material as THREE.Material)
  }

  private addTileProps(tile: { id: string; x: number; z: number; terrain: import('../game/terrain').Terrain }) {
    const rnd = mulberry32(hashString(tile.id))
    const spot = (min: number, max: number) => {
      const a = rnd() * Math.PI * 2
      const d = min + rnd() * (max - min)
      return { x: tile.x + Math.cos(a) * d, z: tile.z + Math.sin(a) * d }
    }
    const tree = (s: number) => {
      const g = new THREE.Group()
      const trunk = new THREE.Mesh(propGeo.trunk, propMat.trunk)
      trunk.position.y = 0.07
      const foliage = new THREE.Mesh(propGeo.foliage, propMat.foliage)
      foliage.position.y = 0.3
      foliage.castShadow = true
      g.add(trunk, foliage)
      g.scale.setScalar(s)
      return g
    }

    const count = { forest: 4, pasture: 3, fields: 5, hills: 3, mountains: 3, desert: 2 }[tile.terrain]
    for (let i = 0; i < count; i++) {
      const p = spot(0.34, 0.56)
      let prop: THREE.Object3D | null = null
      switch (tile.terrain) {
        case 'forest':
          prop = tree(0.8 + rnd() * 0.6)
          break
        case 'pasture': {
          prop = new THREE.Group()
          const body = new THREE.Mesh(propGeo.sheepBody, propMat.sheepBody)
          body.scale.set(1, 0.8, 1.25)
          body.castShadow = true
          const head = new THREE.Mesh(propGeo.sheepHead, propMat.sheepHead)
          head.position.set(0, 0.03, 0.11)
          prop.add(body, head)
          prop.rotation.y = rnd() * Math.PI * 2
          break
        }
        case 'fields': {
          prop = new THREE.Mesh(propGeo.wheat, propMat.wheat)
          prop.castShadow = true
          break
        }
        case 'hills': {
          prop = new THREE.Mesh(propGeo.clay, propMat.clay)
          prop.scale.set(1, 0.55, 1)
          prop.castShadow = true
          break
        }
        case 'mountains': {
          prop = new THREE.Group()
          const peak = new THREE.Mesh(propGeo.peak, propMat.peak)
          peak.castShadow = true
          const snow = new THREE.Mesh(propGeo.snow, propMat.snow)
          snow.position.y = 0.34
          prop.add(peak, snow)
          prop.rotation.y = rnd() * Math.PI * 2
          break
        }
        case 'desert': {
          prop = new THREE.Mesh(propGeo.dune, propMat.dune)
          prop.scale.set(1, 0.35, 1)
          break
        }
      }
      if (prop) {
        prop.position.set(p.x, TILE_TOP, p.z)
        this.boardGroup.add(prop)
      }
    }
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
      this.robber = g
    }
    this.robberTileId = board.desertTileId
    this.robber.position.set(desert.x, TILE_TOP, desert.z)
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

  private addOcean() {
    if (this.waterMesh) {
      this.boardGroup.add(this.waterMesh) // re-attach after group clear
      return
    }
    const deep = new THREE.Mesh(
      new THREE.CylinderGeometry(7.6, 7.6, 0.3, 72),
      new THREE.MeshStandardMaterial({ color: 0x2b6f9e, roughness: 0.25, metalness: 0.05 }),
    )
    deep.position.y = -0.17
    deep.receiveShadow = true
    const shallow = new THREE.Mesh(
      new THREE.CylinderGeometry(5.05, 5.1, 0.28, 72),
      new THREE.MeshStandardMaterial({ color: 0x4a94bd, roughness: 0.3 }),
    )
    shallow.position.y = -0.16
    shallow.receiveShadow = true
    this.waterMesh = deep
    this.disposables.push(deep.geometry, deep.material as THREE.Material, shallow.geometry, shallow.material as THREE.Material)
    this.boardGroup.add(deep, shallow)
  }

  private settlementMesh(player: number): THREE.Group {
    const mats = buildingMaterials[player]
    const g = new THREE.Group()
    const base = new THREE.Mesh(buildingGeo.settlementBase, mats.wall)
    base.position.y = 0.1
    base.castShadow = true
    const roof = new THREE.Mesh(buildingGeo.settlementRoof, mats.roof)
    roof.position.y = 0.31
    roof.rotation.y = Math.PI / 4
    roof.castShadow = true
    g.add(base, roof)
    return g
  }

  private cityMesh(player: number): THREE.Group {
    const mats = buildingMaterials[player]
    const g = new THREE.Group()
    const base = new THREE.Mesh(buildingGeo.cityBase, mats.wall)
    base.position.y = 0.1
    base.castShadow = true
    const roof = new THREE.Mesh(buildingGeo.cityRoof, mats.roof)
    roof.position.set(0, 0.28, 0.06)
    roof.rotation.y = Math.PI / 4
    const tower = new THREE.Mesh(buildingGeo.cityTower, mats.wall)
    tower.position.set(-0.12, 0.17, -0.04)
    tower.castShadow = true
    const towerRoof = new THREE.Mesh(buildingGeo.cityTowerRoof, mats.roof)
    towerRoof.position.set(-0.12, 0.41, -0.04)
    towerRoof.rotation.y = Math.PI / 4
    g.add(base, roof, tower, towerRoof)
    return g
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
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, depthWrite: false }),
      )
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
    const { kind, player } = this.mode
    const color = new THREE.Color(PLAYER_COLORS[player])
    for (const [id, mesh] of this.ghostVertexMeshes) {
      const active = kind === 'settlement' && !this.placements.vertices.has(id)
      mesh.visible = active
      if (active) (mesh.material as THREE.MeshBasicMaterial).color.copy(color)
    }
    for (const [id, mesh] of this.ghostEdgeMeshes) {
      const active = kind === 'road' && !this.placements.edges.has(id)
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
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
  }

  private animate = () => {
    this.raf = requestAnimationFrame(this.animate)
    const dt = this.clock.getDelta()
    const t = this.clock.elapsedTime

    if (this.intro.active) {
      this.intro.t = Math.min(1, this.intro.t + dt / 1.3)
      const e = 1 - Math.pow(1 - this.intro.t, 3) // ease-out cubic
      this.camera.position.lerpVectors(this.intro.from, this.intro.to, e)
      this.camera.lookAt(0, 0.2, 0)
      if (this.intro.t >= 1) {
        this.intro.active = false
        this.controls.enabled = true
        this.controls.update()
      }
    } else {
      this.controls.update()
    }

    if (this.waterMesh) this.waterMesh.position.y = -0.17 + Math.sin(t * 0.7) * 0.018

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
        if (mesh !== this.hoveredRobberTile) {
          ;(mesh.material as THREE.MeshBasicMaterial).opacity = base
        } else {
          ;(mesh.material as THREE.MeshBasicMaterial).opacity = 0.5
        }
      }
    }
  }

  private clearGroup(group: THREE.Group) {
    if (group === this.boardGroup) {
      // keep the ocean + robber meshes out of the disposables double-free path
      this.waterMesh?.removeFromParent()
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
