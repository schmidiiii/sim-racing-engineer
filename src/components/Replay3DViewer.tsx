import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, parseLapKey, getLapColor } from '@/store/session'
import { useT } from '@/lib/i18n'
import LoadingIndicator from '@/components/LoadingIndicator'
import { speedFromMps, speedUnit, tempFromC, tempUnit, fuelFromL, fuelUnit, speedFromKph, type UnitSystem } from '@/lib/units'
import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'

const MAX_TRACK_PTS = 1500
// Scene dimensions are metres, converted with tf.unitsPerMetre. They used to be
// fixed world units, which only worked while every track had a similar footprint:
// the world is always 400 units across, so the Nordschleife (6 km wide, 3x Spa)
// got a 152 m wide road and a 21 m long car, and neighbouring sections simply
// overlapped. Deliberately about twice life size, so the track still reads
// clearly from the chase camera.
const ROAD_WIDTH_M = 24    // visible road surface
const LINE_WIDTH_M = 0.5   // per-lap driving line
const CURB_W_M = 2.2       // kerb width
const CURB_STRIPE_M = 5    // length of one red/white block
const RUNOFF_W_M = 30      // gravel trap width
const TREE_CLEAR_M = 45    // trees start this far beyond the road edge
const CAR_WIDTH_M = 4      // car models are fitted to this
const TREE_MIN_M = 9, TREE_MAX_M = 22
const SPEEDS = [0.25, 0.5, 1, 2, 4]
const TRACE_SAMPLES = 220 // rolling telemetry history length (frames)

// iRacing open-wheel car name patterns
const OPEN_WHEEL_RE = /formula|f1\b|f2\b|f3\b|f4\b|ir18|indycar|dallara|fr2\.0|ray|superformula/i

const GT_MODEL_URL = '/carmodels/55z27frcahz4-P911GT/Porsche_911_GT2.obj'
const F1_MODEL_URL = '/carmodels/98-f1-low-poly/F1.obj'

interface LapChannelData {
  lap_number: number
  channel: string
  samples: number[]
  timestamps: number[]
  lap_dist_pct: number[]
}

interface LapReplayData {
  lapKey: string
  lapNumber: number
  colorIndex: number
  lat: number[]
  lon: number[]
  alt: number[]
  speed: number[]    // m/s
  gear: number[]
  throttle: number[] // 0-1
  brake: number[]    // 0-1
  steering: number[] // radians
  fuel: number[]     // litres — empty when the session didn't log FuelLevel
  distPct: number[]  // progress along the track, 0–1
  // Measured attitude. Signs verified against the data: Pitch correlates -0.99
  // with the uphill gradient (so positive = nose down) and Roll is positive in a
  // right-hand corner (left side down). Yaw needs a per-session offset, see
  // calibrateYaw. Empty when the session didn't log them.
  yaw: number[]
  pitch: number[]
  roll: number[]
  // Per corner, indexed LF/RF/LR/RR. Wheel speed in m/s, tyre temp in °C,
  // tread remaining in % across the three bands (inner / middle / outer).
  wheelSpeed: Record<Corner, number[]>
  tyreTemp: Record<Corner, number[]>
  // Same three bands as the wear: inner / middle / outer surface temperature
  tyreTempBands: Record<Corner, { l: number[]; m: number[]; r: number[] }>
  tyreWear: Record<Corner, { l: number[]; m: number[]; r: number[] }>
  absActive: number[]   // 1 while the ABS is reducing brake pressure
  timestamps: number[]
}

export type Corner = 'LF' | 'RF' | 'LR' | 'RR'


// HUD cards on the right share one width
const CARD_W = 128

// Base sky colours — weather tints these toward grey
const SKY_LIGHT = 0x9ec8e8
const SKY_DARK  = 0x1a1e2a

// ── Track / weather conditions ───────────────────────────────────────────────
const SKIES_KEYS  = ['skyClear', 'skyPartly', 'skyMostly', 'skyOvercast'] as const
const WETNESS_KEYS = ['wetDry', 'wetDry', 'wetMostlyDry', 'wetVeryLight', 'wetLight',
                      'wetModerate', 'wetVery', 'wetExtreme'] as const
const COMPASS     = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

interface TrackConditions {
  trackTemp: number | null   // °C
  airTemp: number | null     // °C
  humidity: number | null    // %
  windVel: number | null     // m/s
  windDir: number | null     // rad
  skies: number | null       // enum index
  precip: number | null      // %
  fog: number | null         // %
  wetness: number | null     // enum index
  weatherType: string | null
  timeOfDay: string | null
  rubber: string | null
}

const yamlNum = (yaml: string, key: string): number | null => {
  const m = yaml.match(new RegExp(`^\\s*${key}:\\s*(-?[\\d.]+)`, 'm'))
  return m ? parseFloat(m[1]) : null
}
const yamlStr = (yaml: string, key: string): string | null => {
  const m = yaml.match(new RegExp(`^\\s*${key}:\\s*(\\S.*?)\\s*$`, 'm'))
  return m ? m[1] : null
}
const meanOf = (a?: number[]): number | null =>
  a && a.length ? a.reduce((s, v) => s + v, 0) / a.length : null

interface WorldTF {
  centerLat: number
  centerLon: number
  minAlt: number
  scale: number
  lonScale: number        // cos(centerLat) — a degree of longitude is shorter than one of latitude
  unitsPerMetre: number   // everything sized in metres multiplies by this
}

// Floor search: largest index where arr[i] <= target — guarantees frac ∈ [0,1) for interpolation
function bsearchFloor(arr: number[], target: number): number {
  if (target <= arr[0]) return 0
  let lo = 0, hi = arr.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (arr[mid] <= target) lo = mid; else hi = mid - 1
  }
  return lo
}

// Nearest search — kept for crosshair sync (non-playback lookups)
function bsearchNearest(arr: number[], target: number): number {
  let lo = 0, hi = arr.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < target) lo = mid + 1; else hi = mid
  }
  if (lo > 0 && Math.abs(arr[lo - 1] - target) < Math.abs(arr[lo] - target)) lo--
  return lo
}

function buildWorldTF(lats: number[], lons: number[], alts: number[]): WorldTF {
  let minLat = Infinity, maxLat = -Infinity
  let minLon = Infinity, maxLon = -Infinity
  let minAlt = Infinity
  for (let i = 0; i < lats.length; i++) {
    if (lats[i] < minLat) minLat = lats[i]
    if (lats[i] > maxLat) maxLat = lats[i]
    if (lons[i] < minLon) minLon = lons[i]
    if (lons[i] > maxLon) maxLon = lons[i]
    if (alts[i] < minAlt) minAlt = alts[i]
  }
  const latR = maxLat - minLat || 1e-9
  const lonR = maxLon - minLon || 1e-9
  const centerLat = (minLat + maxLat) / 2
  // Without this the track comes out stretched east-west by 1/cos(lat) — 1.57x at
  // Spa, 1.40x at Imola. That distorts the shape, the corner radii the geometry
  // is built from, and the heading, which is what made the measured Yaw disagree
  // with the driven path by ~10°.
  const lonScale = Math.cos(centerLat * Math.PI / 180)
  const scale = 400 / Math.max(latR, lonR * lonScale)
  return {
    centerLat,
    centerLon: (minLon + maxLon) / 2,
    minAlt,
    scale,
    lonScale,
    // A degree of latitude is 111_320 m anywhere, so this converts the
    // degrees-based scale into units per metre
    unitsPerMetre: scale / 111320,
  }
}

function toWorld(lat: number, lon: number, alt: number, tf: WorldTF): THREE.Vector3 {
  return new THREE.Vector3(
    (lon - tf.centerLon) * tf.scale * tf.lonScale,
    // Same scale as the ground: a fixed vertical factor exaggerated relief
    // threefold on a track as large as the Nordschleife
    (alt - tf.minAlt) * tf.unitsPerMetre,
    -(lat - tf.centerLat) * tf.scale,
  )
}

// Tangent at point i of a polyline. Repeated GPS samples give a zero-length
// difference — those keep the previous tangent instead of collapsing to (0,0,0),
// which would put the offset point right on the centreline.
function pathTangent(pts: THREE.Vector3[], i: number, lastTan: THREE.Vector3): THREE.Vector3 {
  const prev = pts[Math.max(0, i - 1)]
  const next = pts[Math.min(pts.length - 1, i + 1)]
  const tan = new THREE.Vector3().subVectors(next, prev)
  if (tan.lengthSq() < 1e-8) return lastTan.clone()
  tan.normalize()
  lastTan.copy(tan)
  return tan
}

// Stretch a thinned series back onto the full sample count, so callers can keep
// indexing it with the same idx they use for the core channels
function resample(src: number[], length: number): number[] {
  if (src.length === 0 || src.length === length) return src
  const out = new Array<number>(length)
  const ratio = (src.length - 1) / Math.max(1, length - 1)
  for (let i = 0; i < length; i++) out[i] = src[Math.round(i * ratio)] ?? 0
  return out
}

// Sample a lap into a track centreline. Walking the samples in time order turns
// a spin into a real loop in the geometry — no amount of smoothing removes that.
// LapDistPct is the car's progress along the track and doesn't care which way
// the car is pointing, so stepping through it monotonically simply skips every
// section where the car went backwards or stood still. `back` reports how much
// of the lap ran backwards, which identifies the cleanest lap for the track shape.
function sampleCentreline(lap: LapReplayData, tf: WorldTF): { pts: THREE.Vector3[]; back: number } {
  const n = lap.lat.length
  const pct = lap.distPct
  // Ground covered, so partial laps still get the full point budget spread over
  // the piece of track they actually cover
  let travelled = 0
  if (pct.length === n) {
    for (let i = 1; i < n; i++) {
      let d = pct[i] - pct[i - 1]
      if (d < -0.5) d += 1                  // start/finish wrap
      if (d > 0) travelled += d
    }
  }

  // No usable progress channel → plain time sampling
  if (pct.length !== n || travelled < 1e-3) {
    const pts: THREE.Vector3[] = []
    const step = Math.max(1, Math.floor(n / MAX_TRACK_PTS))
    for (let i = 0; i < n; i += step) pts.push(toWorld(lap.lat[i], lap.lon[i], lap.alt[i], tf))
    return { pts, back: 0 }
  }

  // Point count follows the lap length instead of being fixed: 1500 points is
  // 2 m apart at Winton but 14 m on the Nordschleife, where the road turns into
  // visible facets. Capped, because the terrain build is O(vertices x points).
  let spanUnits = 0
  for (let i = 1; i < n; i++) {
    const a = toWorld(lap.lat[i - 1], lap.lon[i - 1], 0, tf)
    const b = toWorld(lap.lat[i], lap.lon[i], 0, tf)
    spanUnits += Math.hypot(b.x - a.x, b.z - a.z)
  }
  const lengthM = spanUnits / Math.max(tf.unitsPerMetre, 1e-9)
  const target = Math.max(900, Math.min(2200, Math.round(lengthM / 5)))
  const stepPct = travelled / target
  const pts: THREE.Vector3[] = []
  let mark = -Infinity, back = 0
  for (let i = 0; i < n; i++) {
    const p = pct[i]
    if (i > 0) {
      const d = p - pct[i - 1]
      if (d < 0 && d > -0.5) back++           // moved backwards (a jump of −1 is the start/finish wrap)
    }
    if (p < mark - 0.5) mark = -Infinity      // crossed start/finish — start a new run
    if (p < mark + stepPct) continue          // backwards, stationary, or not far enough along yet
    mark = p
    pts.push(toWorld(lap.lat[i], lap.lon[i], lap.alt[i], tf))
  }
  return { pts, back: back / n }
}

// Light moving average over a centreline. Raw GPS jitter reads as phantom
// micro-corners: it makes every offset strip zig-zag and produces bogus corner
// radii for the limiter below.
//
// The window is a distance, not a sample count. As a fixed count it covered
// ±57 m on the Nordschleife (1500 points spread over 20 km) versus ±9 m at
// Winton, which cut whole corners off the generated track — the road ended up
// tens of metres away from the line the car actually drove.
function smoothPath(pts: THREE.Vector3[], windowMetres: number, unitsPerMetre: number): THREE.Vector3[] {
  const n = pts.length
  if (n < 3) return pts.map(p => p.clone())
  let span = 0
  for (let i = 1; i < n; i++) span += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
  const spacingM = span / (n - 1) / Math.max(unitsPerMetre, 1e-9)
  const w = Math.max(1, Math.min(8, Math.round(windowMetres / Math.max(spacingM, 0.01))))
  return pts.map((p, i) => {
    let sx = 0, sz = 0, c = 0
    for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) { sx += pts[k].x; sz += pts[k].z; c++ }
    return new THREE.Vector3(sx / c, p.y, sz / c)
  })
}

// Local corner radius per vertex, measured over a fixed arc length either side
// (three adjacent samples are far too short a baseline to be meaningful).
// posR/negR hold the radius for the side the path bends toward; the other side
// is Infinity since offsetting away from a corner never folds.
function lateralLimits(pts: THREE.Vector3[]): { perp: THREE.Vector3[]; posR: Float64Array; negR: Float64Array } {
  const n = pts.length
  const perp: THREE.Vector3[] = new Array(n)
  const posR = new Float64Array(n).fill(Infinity)
  const negR = new Float64Array(n).fill(Infinity)
  const lastTan = new THREE.Vector3(0, 0, 1)

  const cum = new Float64Array(n)
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
  // Baseline for the radius, taken from the line's own sample spacing so it
  // scales with the track instead of assuming a fixed world size
  const RADIUS_ARC = Math.max((cum[n - 1] / Math.max(1, n - 1)) * 4, 1e-6)
  const atArc = (i: number, d: number) => {
    const t = cum[i] + d
    let lo = 0, hi = n - 1
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < t) lo = m + 1; else hi = m }
    return lo
  }

  for (let i = 0; i < n; i++) {
    const tan = pathTangent(pts, i, lastTan)
    perp[i] = new THREE.Vector3(-tan.z, 0, tan.x)
    const ia = atArc(i, -RADIUS_ARC), ic = atArc(i, RADIUS_ARC)
    if (ia === i || ic === i) continue           // too close to either end
    const a = pts[ia], b = pts[i], c = pts[ic]
    const abx = b.x - a.x, abz = b.z - a.z
    const bcx = c.x - b.x, bcz = c.z - b.z
    const area2 = Math.abs(abx * bcz - abz * bcx)
    if (area2 < 1e-9) continue                   // straight — no limit
    // Circumradius of the three points = local corner radius
    const R = (Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(c.x - a.x, c.z - a.z)) / (2 * area2)
    // Second difference points toward the inside of the bend
    if ((bcx - abx) * perp[i].x + (bcz - abz) * perp[i].z > 0) posR[i] = R
    else                                                        negR[i] = R
  }

  // Min-filter so the taper eases in over a few vertices instead of denting one
  const spread = (r: Float64Array) => {
    const out = Float64Array.from(r)
    for (let i = 0; i < n; i++)
      for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++)
        if (r[k] < out[i]) out[i] = r[k]
    return out
  }
  return { perp, posR: spread(posR), negR: spread(negR) }
}

// Soft limit: equals `d` on straights, approaches the corner radius asymptotically
// in tight corners. Never reaches it, so the offset can't fold through the centre,
// and unlike a hard clamp it tapers instead of kinking.
const softOffset = (d: number, R: number) => Number.isFinite(R) ? d / (1 + d / R) : d

// How far a strip may reach sideways before it runs into a *different* part of
// the track. Corner radius alone isn't enough: the Nordschleife folds back on
// itself constantly, and sections that are minutes apart along the lap pass
// within 26 m of each other — with up to 24 m of height between them. A 140 m
// apron then cuts clean through the tarmac of its neighbour. Each point gets
// half the distance to the nearest section that is far away along the lap, so
// two neighbours meet at the midpoint instead of overlapping.
function selfClearance(pts: THREE.Vector3[], perp: THREE.Vector3[], minArcSep: number) {
  const n = pts.length
  const pos = new Float64Array(n).fill(Infinity)
  const neg = new Float64Array(n).fill(Infinity)
  const cum = new Float64Array(n)
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
  const total = cum[n - 1]

  for (let i = 0; i < n; i++) {
    const pi = pts[i], pe = perp[i]
    for (let j = 0; j < n; j++) {
      // Arc distance the short way round, so the start/finish join isn't
      // mistaken for two separate sections
      let along = Math.abs(cum[i] - cum[j])
      along = Math.min(along, total - along)
      if (along < minArcSep) continue                 // same stretch of road
      const dx = pts[j].x - pi.x, dz = pts[j].z - pi.z
      const d = Math.hypot(dx, dz)
      if (dx * pe.x + dz * pe.z > 0) { if (d < pos[i]) pos[i] = d }
      else                           { if (d < neg[i]) neg[i] = d }
    }
  }
  for (let i = 0; i < n; i++) { pos[i] *= 0.5; neg[i] *= 0.5 }
  return { pos, neg }
}

// Offset a centreline sideways by a signed distance, limited so it can never
// fold through a corner (see lateralLimits).
function offsetPath(pts: THREE.Vector3[], dist: number, yOff = 0): THREE.Vector3[] {
  const { perp, posR, negR } = lateralLimits(pts)
  const mag = Math.abs(dist), sign = Math.sign(dist)
  return pts.map((p, i) => {
    const d = sign * softOffset(mag, sign >= 0 ? posR[i] : negR[i])
    return p.clone().addScaledVector(perp[i], d).setY(p.y + yOff)
  })
}

// Build a flat road ribbon (no colour attribute — colour set via Material).
// close=true connects the last vertex pair back to the first, sealing the loop at start/finish.
// In corners tighter than half the width the ribbon narrows instead of folding.
function buildRibbon(pts: THREE.Vector3[], width: number, close = false): THREE.BufferGeometry {
  const n = pts.length
  const positions = new Float32Array(n * 2 * 3)
  const indices: number[] = []
  const { perp, posR, negR } = lateralLimits(pts)
  const half = width / 2

  for (let i = 0; i < n; i++) {
    const L = pts[i].clone().addScaledVector(perp[i],  softOffset(half, posR[i]))
    const R = pts[i].clone().addScaledVector(perp[i], -softOffset(half, negR[i]))

    const o = i * 6
    positions[o]     = L.x; positions[o + 1] = L.y; positions[o + 2] = L.z
    positions[o + 3] = R.x; positions[o + 4] = R.y; positions[o + 5] = R.z

    if (i < n - 1) {
      const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3
      indices.push(a, b, d, a, d, c)
    }
  }
  // Close the loop: connect last vertex pair back to first, sealing the start/finish gap
  if (close && n > 1) {
    const a = (n - 1) * 2, b = (n - 1) * 2 + 1
    indices.push(a, b, 1, a, 1, 0)
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setIndex(indices)
  return geom
}

// Tint every mesh in a loaded model with the lap colour, wheels excluded — they
// stay black so the car reads as a car rather than a monochrome blob
function applyLapColor(model: THREE.Object3D, hexColor: string) {
  const color = new THREE.Color(hexColor)
  model.traverse(child => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh || mesh.userData.isWheel) return
    // Dispose any existing material(s) to avoid leaks
    if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose())
    else if (mesh.material) mesh.material.dispose()
    // vertexColors carries the wing/glass darkening — see shadeDarkParts
    mesh.material = new THREE.MeshLambertMaterial({ color, vertexColors: true })
  })
}

export interface CarWheel {
  pivot: THREE.Object3D  // carries the steering angle (front wheels only)
  mesh: THREE.Mesh       // spins about its own axle
  front: boolean
  corner: Corner         // which of the four wheels this is
  radius: number         // world units — sets the rolling speed
  axis: 'x' | 'z'        // axle direction in model space
  spinSign: 1 | -1       // rotation direction that rolls the car forwards
  mat: THREE.MeshLambertMaterial   // per car and wheel, so tyre temp can tint it
}

// The car models name their parts "part 007" / "default3", so wheels have to be
// found by shape: roughly circular in side profile, small relative to the car,
// set off to one side, and low. Verified against both models — it picks exactly
// the four wheels on the Porsche (axle along X) and the F1 (axle along Z).
// Run once on the shared base model: it re-homes each wheel on its own axle and
// tags it, so every per-lap clone inherits ready-to-spin wheels.
//
// This runs *after* the model's rotation.y correction, and Box3 measures world
// space, so both cars arrive here in the same frame regardless of how their OBJ
// was authored: nose at +Z, axles along X. Taking the models' native orientation
// here instead is what previously mislabelled the corners.
function prepareWheels(model: THREE.Object3D) {
  const box  = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const mid  = box.getCenter(new THREE.Vector3())
  const lon = 'z' as const                              // longitudinal axis
  const lat = 'x' as const                              // axle axis
  const lonLen = size[lon]

  // Two frames are in play. The corners above are read off the world-space box,
  // where both cars sit nose at +Z. The spin, though, is written to
  // mesh.rotation, which lives in the model's *own* frame — so the axle has to
  // be named there. Expressing the world X axis (the axle) in that frame gives
  // both the axis and its direction:
  const c = Math.cos(model.rotation.y), s = Math.sin(model.rotation.y)
  const axis: 'x' | 'z' = Math.abs(c) >= Math.abs(s) ? 'x' : 'z'
  // Rolling forwards carries the top of the wheel toward the nose, which about
  // world +X is a positive rotation — negated when the model's axle runs the
  // other way, as it does on both of these cars
  const spinSign: 1 | -1 = ((axis === 'x' ? c : s) > 0 ? 1 : -1)

  const meshes: THREE.Mesh[] = []
  model.traverse(c => { const m = c as THREE.Mesh; if (m.isMesh) meshes.push(m) })

  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x141414 })
  for (const mesh of meshes) {
    const mb = new THREE.Box3().setFromObject(mesh)
    const ms = mb.getSize(new THREE.Vector3())
    const mc = mb.getCenter(new THREE.Vector3())
    const dia   = Math.max(ms.y, ms[lon])
    const round = Math.min(ms.y, ms[lon]) / Math.max(dia, 1e-6)
    const offLat = Math.abs(mc[lat] - mid[lat]) / Math.max(size[lat] / 2, 1e-6)
    const low    = (mc.y - box.min.y) / Math.max(size.y, 1e-6)
    if (!(round > 0.70 && dia > lonLen * 0.08 && dia < lonLen * 0.40 && offLat > 0.20 && low < 0.50)) continue

    const parent = mesh.parent
    if (!parent) continue
    // Re-home the mesh on its own centre so it spins about the axle, not the car
    mesh.updateWorldMatrix(true, false)
    const inMesh = mesh.worldToLocal(mc.clone())
    mesh.geometry.translate(-inMesh.x, -inMesh.y, -inMesh.z)
    mesh.position.set(0, 0, 0)
    const pivot = new THREE.Group()
    pivot.position.copy(parent.worldToLocal(mc.clone()))
    parent.add(pivot)
    pivot.add(mesh)

    if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose())
    else if (mesh.material) mesh.material.dispose()
    mesh.material = wheelMat
    // userData survives clone(), so each lap's copy is recognisable again
    mesh.userData.isWheel = true
    const isFront = mc[lon] > mid[lon]
    // Turning left raises rotation.y, which swings the nose from +z toward +x,
    // so +x is the driver's left
    const isLeft = mc[lat] > mid[lat]
    mesh.userData.wheelFront = isFront
    mesh.userData.wheelCorner = (isFront ? (isLeft ? 'LF' : 'RF') : (isLeft ? 'LR' : 'RR'))
    mesh.userData.wheelRadius = dia / 2
    mesh.userData.wheelAxis = axis
    mesh.userData.wheelSpin = spinSign
  }
}

// Neither model carries separate lamp parts, so the lights are built here and
// added to the car group, whose local frame always has the nose at +Z.
// Unlit materials — a brake light has to glow, not catch the scene lighting.
// Unlit off-state is still a visible red lens, otherwise the lamp vanishes on a
// light car body and you can't tell where it sits until the driver brakes
const BRAKE_OFF = 0x7d1c1c
const BRAKE_ON  = 0xff2b2b
export interface CarLights { mat: THREE.MeshBasicMaterial; braking: boolean }

export interface LampSpot { pos: THREE.Vector3; normal: THREE.Vector3; front: boolean; width: number }

// Where the lamps actually belong on the bodywork. Anchoring them to the
// bounding box put them in mid-air: the box's front edge is the low splitter and
// its rear edge the wing, not the panel at lamp height. So a ray is fired at the
// car from the front/back and the lamp is seated on the first surface it hits.
// Heights come off the wheel radius — a percentage of car height would be thrown
// off by the rear wing.
// openWheel: single centred rain light at the back, no headlights — that's how a
// formula car is lit. Closed-wheel cars get a pair at each end.
function computeLampSpots(model: THREE.Object3D, box: THREE.Box3, openWheel: boolean): LampSpot[] {
  const size = box.getSize(new THREE.Vector3())
  const bodies: THREE.Mesh[] = []
  model.traverse(c => { const m = c as THREE.Mesh; if (m.isMesh && !m.userData.isWheel) bodies.push(m) })
  const ray = new THREE.Raycaster()
  const dirF = new THREE.Vector3(0, 0, -1), dirR = new THREE.Vector3(0, 0, 1)
  // Narrow the offset until the ray finds bodywork — an open wheeler is far
  // narrower at the tail than a GT car, so one fixed offset can't serve both
  const normalMat = new THREE.Matrix3()
  // Panels vary a lot across a few centimetres, so several seats are tried:
  // first the wanted spot, then slightly lower and further inboard, where the
  // bodywork faces forwards/backwards more squarely
  const seat = (xWanted: number, yWanted: number, front: boolean, centred = false): LampSpot | null => {
    const candidates: [number, number][] = []
    for (const dy of [0, -0.04, 0.04, -0.08])
      for (const f of [1, 0.8, 0.6]) candidates.push([xWanted * f, yWanted + size.y * dy])
    for (const [x, y] of candidates) {
      const dir = front ? dirF : dirR
      ray.set(new THREE.Vector3(x, y, front ? box.max.z + 1 : box.min.z - 1), dir)
      const hit = ray.intersectObjects(bodies, true)[0]
      if (!hit?.face) continue
      const normal = hit.face.normal.clone()
        .applyNormalMatrix(normalMat.getNormalMatrix(hit.object.matrixWorld))
        .normalize()
      if (normal.dot(dir) > 0) normal.negate()   // point it outwards
      // Skip panels that face sideways — on the 911's rear haunch the normal
      // swings to (0.83, 0.11, -0.55) and a lamp aligned to it ends up standing
      // on edge against the flank instead of lying across the tail. The limit is
      // loose because the sideways part of the normal gets dropped below anyway,
      // and the tail lights belong on the rounded corner, not the flat middle.
      if (Math.abs(normal.z) < 0.40) continue
      // Follow the panel's rake but not its sideways curve, so the lamp stays
      // square to the car and only tips up or down
      normal.x = 0
      normal.normalize()
      const pos = hit.point.clone()
      if (centred) pos.x = 0

      // How far the same panel carries on either side, so the lamp can be sized
      // to fit instead of hanging off the corner into thin air
      const reach = (step: number) => {
        let out = 0
        for (let k = 1; k <= 14; k++) {
          const px = pos.x + step * k
          ray.set(new THREE.Vector3(px, pos.y, front ? box.max.z + 1 : box.min.z - 1), dir)
          const h2 = ray.intersectObjects(bodies, true)[0]
          if (!h2?.face) break
          const n2 = h2.face.normal.clone()
            .applyNormalMatrix(normalMat.getNormalMatrix(h2.object.matrixWorld)).normalize()
          if (n2.dot(dir) > 0) n2.negate()
          // panel turned away, or the surface fell back — the corner ends here
          // Tolerance is generous: a tail light wraps around the corner, so the
          // panel is expected to fall away somewhat across the lamp's width
          if (Math.abs(n2.z) < 0.40 || Math.abs(h2.point.z - pos.z) > size.z * 0.045) break
          out = Math.abs(px - pos.x)
        }
        return out
      }
      const stepX = size.x * 0.015
      const outward = reach(x >= 0 ? stepX : -stepX)
      const inward  = reach(x >= 0 ? -stepX : stepX)
      // Re-centre in the space that's actually there, then fit the lamp into it
      if (!centred) pos.x += (outward - inward) / 2 * (x >= 0 ? 1 : -1)
      return { pos, normal, front, width: outward + inward }
    }
    return null
  }

  // Grid-mapped off both models: on the GT car the tail lights belong on the
  // corner where the bootlid meets the wing (50% height, 66% of half-width) and
  // the headlights up on the front wing (47%). Lower down they end up in the
  // bumper, further in they slide onto the bonnet. The formula car's light goes
  // at 45% — any lower and it disappears between the rear tyres.
  const xOff = size.x * 0.34   // 68% of half-width — out toward the rear corners
  // Formula car: 40% is the highest point where the tail is still dead vertical
  // (normal 0,0,-1) and the bodywork reaches its rearmost z. Above that the
  // engine cover rakes away and the lamp reads as sitting on top of the car.
  const yRear = box.min.y + size.y * (openWheel ? 0.40 : 0.50)
  // Only brake lights are built as geometry — the headlights are painted onto
  // the model's own lenses in shadeDarkParts, which sits far better than a lamp
  // stuck onto the bodywork
  const spots: LampSpot[] = []
  for (const sx of openWheel ? [0] : [-1, 1]) {
    const rear = seat(sx * xOff, yRear, false, openWheel)
    if (!rear) continue
    if (openWheel) {
      // The engine cover already rakes away 31° at this height, so following the
      // panel would lay the lamp flat on top of the car — a rain light stands
      // upright facing back. It keeps the seat the ray found: anchoring it to
      // box.min.z instead put it behind the rear wing, floating clear of the car.
      rear.normal.set(0, 0, -1)
    }
    spots.push(rear)
  }
  return spots
}

function addCarLights(
  parent: THREE.Object3D, spots: LampSpot[], box: THREE.Box3, openWheel: boolean,
  tailGeo: THREE.BufferGeometry | null,
): CarLights {
  const size = box.getSize(new THREE.Vector3())
  // DoubleSide: the band's winding follows the panel it was probed from, so it
  // must not depend on facing the camera the 'right' way round
  const mat = new THREE.MeshBasicMaterial({ color: BRAKE_OFF, side: THREE.DoubleSide })
  // Lenses built onto the bodywork beat anything stuck on top of it
  if (tailGeo) {
    parent.add(new THREE.Mesh(tailGeo, mat))
    return { mat, braking: false }
  }
  const FWD = new THREE.Vector3(0, 0, 1)
  for (const s of spots) {
    // Width is capped by however much panel the seat actually offers, so a lamp
    // can't stick out past the corner of the car
    const wanted = size.x * (openWheel ? 0.11 : 0.13)
    const w = Math.max(Math.min(wanted, s.width), size.x * 0.05)
    // Formula rain light is a square panel; a GT car's tail light is a strip
    const h = openWheel ? w : Math.max(size.y * 0.07, 0.035)
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), mat)
    // Sit just proud of the panel so it doesn't z-fight with the bodywork
    lamp.position.copy(s.pos).addScaledVector(s.normal, 0.022)
    // Local quaternion, not lookAt — the parent group is already positioned and
    // rotated on track, so a world-space aim would come out wrong
    lamp.quaternion.setFromUnitVectors(FWD, s.normal)
    parent.add(lamp)
  }
  return { mat, braking: false }
}

// Wing and glass are unnamed too, so they're classified by shape. Rather than
// swapping materials (which clone() shares between laps) the darkening rides in
// a vertex colour attribute: white everywhere, near-black on wing and glass.
// three multiplies it with the material colour, so the same shared attribute
// works for every lap colour. Not fully black — a flat 0 loses all the edges.
const DARK_TINT = 0.08
function shadeDarkParts(model: THREE.Object3D, box: THREE.Box3): Set<THREE.Mesh> {
  const size = box.getSize(new THREE.Vector3())
  const meshes: THREE.Mesh[] = []
  model.traverse(c => { const m = c as THREE.Mesh; if (m.isMesh && !m.userData.isWheel) meshes.push(m) })

  // Measured in car space, same as the bounding boxes it gets compared against —
  // the model carries its scale on the root, so raw geometry area would be off
  // by that factor squared and no shell would ever look thin enough
  const triArea = (m: THREE.Mesh) => {
    m.updateWorldMatrix(true, false)
    const pos = m.geometry.attributes.position as THREE.BufferAttribute
    const index = m.geometry.index
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const ab = new THREE.Vector3(), ac = new THREE.Vector3()
    const count = index ? index.count : pos.count
    let area = 0
    for (let i = 0; i < count; i += 3) {
      const i0 = index ? index.getX(i) : i, i1 = index ? index.getX(i + 1) : i + 1, i2 = index ? index.getX(i + 2) : i + 2
      a.fromBufferAttribute(pos, i0).applyMatrix4(m.matrixWorld)
      b.fromBufferAttribute(pos, i1).applyMatrix4(m.matrixWorld)
      c.fromBufferAttribute(pos, i2).applyMatrix4(m.matrixWorld)
      area += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2
    }
    return area
  }

  const wingZ = box.min.z + size.z * 0.15   // rear 15% of the car
  const wingY = box.min.y + size.y * 0.55
  let wingMesh = false
  const dark = new Set<THREE.Mesh>()
  for (const mesh of meshes) {
    const mb = new THREE.Box3().setFromObject(mesh)
    const ms = mb.getSize(new THREE.Vector3())
    const mc = mb.getCenter(new THREE.Vector3())
    // A shell (glass) covers far less area than its bounding box; solid
    // bodywork of the same extent covers two to three times as much
    const shell = 2 * (ms.x * ms.y + ms.x * ms.z + ms.y * ms.z)
    const ratio = shell > 1e-6 ? triArea(mesh) / shell : 1
    const yTop = (mb.max.y - box.min.y) / size.y
    if (yTop > 0.85 && ratio < 0.35 && mc.y > box.min.y + size.y * 0.5) dark.add(mesh)   // glazing
    if (mc.z < wingZ && mc.y > wingY) { dark.add(mesh); wingMesh = true }                // rear wing
  }

  // The glazing mesh holds the headlight lenses too — a ray at the headlight
  // hits the same part as the windscreen. Those vertices get lit instead of
  // darkened: >1 multiplied with any lap colour clamps to white, so the lens
  // reads as a lamp rather than as body paint.
  const HEAD_TINT = 5
  const headZ = box.min.z + size.z * 0.80        // front fifth of the car
  const headXmin = size.x * 0.18                 // off-centre, not the nose
  const headYmin = box.min.y + size.y * 0.35
  const headYmax = box.min.y + size.y * 0.70

  const v = new THREE.Vector3()
  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute
    const col = new Float32Array(pos.count * 3).fill(1)
    const wholeMesh = dark.has(mesh)
    mesh.updateWorldMatrix(true, false)
    for (let i = 0; i < pos.count; i++) {
      // Where the wing is welded into the body mesh (the formula car), fall back
      // to shading the vertices that sit in the wing's corner of the car
      let isDark = wholeMesh
      if (!isDark && !wingMesh) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
        isDark = v.y > wingY && v.z < wingZ
      }
      if (!isDark) continue
      // Only glass can become a headlight, so body panels can't light up by mistake
      let tint = DARK_TINT
      if (wholeMesh) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
        if (v.z > headZ && Math.abs(v.x) > headXmin && v.y > headYmin && v.y < headYmax) tint = HEAD_TINT
      }
      col[i * 3] = tint; col[i * 3 + 1] = tint; col[i * 3 + 2] = tint
    }
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3))
  }
  return dark
}

// A real 911 tail light is a clean narrow band across the tail, so that is what
// gets built: the bodywork is probed at even steps across the width and the hits
// become a smooth strip lying on the panel. Cutting the car's own triangles out
// instead followed the shape but left ragged, blotchy edges wherever the zone
// sliced through them. The band ends by itself where the panel turns into the
// flank, so its width needs no hand-tuning.
function buildTailLightBand(model: THREE.Object3D, box: THREE.Box3, skip: Set<THREE.Mesh>): THREE.BufferGeometry | null {
  const size = box.getSize(new THREE.Vector3())
  const yMid = box.min.y + size.y * 0.46
  const xReach = size.x * 0.48
  const STEPS = 72
  // Like the real car: chunky lamp units out on the corners, joined by a much
  // thinner strip across the middle, with a smooth transition between the two
  const H_OUTER = size.y * 0.024
  const H_INNER = size.y * 0.008
  const halfHAt = (x: number) => {
    const t = Math.min(1, Math.max(0, (Math.abs(x) / xReach - 0.42) / 0.28))
    return H_INNER + (H_OUTER - H_INNER) * (t * t * (3 - 2 * t))
  }

  const bodies: THREE.Mesh[] = []
  model.traverse(o => {
    const m = o as THREE.Mesh
    if (m.isMesh && !m.userData.isWheel && !skip.has(m)) bodies.push(m)
  })
  if (!bodies.length) return null

  const ray = new THREE.Raycaster()
  const back = new THREE.Vector3(0, 0, 1)
  const normalMat = new THREE.Matrix3()
  // One probe: where does the panel sit at this x/y, and which way does it face?
  const probe = (x: number, y: number) => {
    ray.set(new THREE.Vector3(x, y, box.min.z - 1), back)
    const hit = ray.intersectObjects(bodies, true)[0]
    if (!hit?.face) return null
    const n = hit.face.normal.clone()
      .applyNormalMatrix(normalMat.getNormalMatrix(hit.object.matrixWorld)).normalize()
    if (n.dot(back) > 0) n.negate()
    if (-n.z < 0.45) return null           // panel has turned into the flank
    return hit.point.clone().addScaledVector(n, 0.012)
  }

  const out: number[] = []
  let prev: { top: THREE.Vector3; bot: THREE.Vector3 } | null = null
  for (let i = 0; i <= STEPS; i++) {
    const x = -xReach + (2 * xReach * i) / STEPS
    const halfH = halfHAt(x)
    const top = probe(x, yMid + halfH)
    const bot = probe(x, yMid - halfH)
    // One hit is enough: a crease can swallow the upper or lower probe, and
    // dropping the whole column there would tear a hole in the middle of the band
    let cur: { top: THREE.Vector3; bot: THREE.Vector3 } | null = null
    if (top && bot) cur = { top, bot }
    else if (top) cur = { top, bot: new THREE.Vector3(x, yMid - halfH, top.z) }
    else if (bot) cur = { top: new THREE.Vector3(x, yMid + halfH, bot.z), bot }
    if (prev && cur) {
      // Two triangles bridging this column and the previous one. Wound so the
      // face normal points back out of the car — the other way round the strip
      // is culled and simply doesn't show from behind.
      out.push(prev.top.x, prev.top.y, prev.top.z, cur.bot.x, cur.bot.y, cur.bot.z, prev.bot.x, prev.bot.y, prev.bot.z)
      out.push(prev.top.x, prev.top.y, prev.top.z, cur.top.x, cur.top.y, cur.top.z, cur.bot.x, cur.bot.y, cur.bot.z)
    }
    prev = cur
  }
  if (out.length < 9) return null
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3))
  geo.computeVertexNormals()
  return geo
}

// Gather the tagged wheels out of a cloned car model
function collectWheels(model: THREE.Object3D): CarWheel[] {
  const out: CarWheel[] = []
  model.traverse(c => {
    const mesh = c as THREE.Mesh
    if (!mesh.isMesh || !mesh.userData.isWheel || !mesh.parent) return
    // clone() shares materials — each wheel needs its own to show its own temperature
    const mat = new THREE.MeshLambertMaterial({ color: TYRE_BASE })
    mesh.material = mat
    out.push({
      pivot: mesh.parent,
      mesh,
      front: mesh.userData.wheelFront,
      corner: mesh.userData.wheelCorner,
      radius: mesh.userData.wheelRadius,
      axis: mesh.userData.wheelAxis,
      spinSign: mesh.userData.wheelSpin,
      mat,
    })
  })
  return out
}

// Scale an OBJ model so the car WIDTH (shorter horizontal axis) = targetWidth, sit it on y = 0
function fitToWorldUnits(model: THREE.Object3D, targetWidth = 2.5) {
  const box  = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  // Use the shorter of X and Z — that's the car width, not the length
  const carWidth = Math.min(size.x, size.z)
  const scale = targetWidth / Math.max(carWidth, 0.001)
  model.scale.setScalar(scale)
  // Re-compute box after scaling and centre + ground the model
  const box2   = new THREE.Box3().setFromObject(model)
  const center = box2.getCenter(new THREE.Vector3())
  model.position.set(-center.x, -box2.min.y, -center.z)
}

// Fallback box-car used while the OBJ is loading
function buildPlaceholderCar(scale = 1): THREE.Group {
  const group = new THREE.Group()
  // Yaw first, pitch about the already-turned lateral axis — with the default
  // XYZ order the pitch would tilt about the world X axis and roll the car
  group.rotation.order = 'YXZ'
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.4 * scale, 0.55 * scale, 3.5 * scale), new THREE.MeshLambertMaterial({ color: 0x555555 }))
  body.position.y = 0.35 * scale
  group.add(body)
  return group
}


// ── Tyre temperature colouring ───────────────────────────────────────────────
// Measured range in a Cup car stint: ~30 °C cold, 100 °C hot. Blue → green →
// red across that, kept dark so the wheels still read as tyres rather than sweets.
const TYRE_BASE = 0x141414
const TYRE_COLD = 55, TYRE_HOT = 110   // dead black up to 55 °C, then into the red
const tyreColor = (() => {
  // Black when cold, glowing toward red as the tyre heats up — a tyre should look
  // like a tyre at rest, so the colour only creeps in with temperature
  const cold = new THREE.Color(TYRE_BASE)
  const warm = new THREE.Color(0x6b1512)   // dark red
  const hot  = new THREE.Color(0xe8442c)   // bright red
  const out  = new THREE.Color()
  return (c: number) => {
    const t = Math.max(0, Math.min(1, (c - TYRE_COLD) / (TYRE_HOT - TYRE_COLD)))
    if (t < 0.5) out.copy(cold).lerp(warm, t * 2)
    else out.copy(warm).lerp(hot, (t - 0.5) * 2)
    return out
  }
})()

// iRacing's Yaw is in its own frame, so it needs a per-session offset to line up
// with the viewer's world. Averaged over the lap the car points where it is
// going, so the mean difference between GPS heading and Yaw is that offset —
// measured at 1.5° residual scatter, and the leftover is the slip angle itself.
function calibrateYaw(lap: LapReplayData, tf: WorldTF): number | null {
  if (lap.yaw.length !== lap.lat.length || lap.lat.length < 60) return null
  let sumS = 0, sumC = 0, n = 0
  for (let i = 10; i < lap.lat.length - 10; i += 3) {
    // Fast samples only: at low speed the GPS heading is noisy and the car is
    // often sideways anyway, both of which drag the offset off. Measured scatter
    // over fast samples is 1.5°, which is the slip angle itself.
    if ((lap.speed[i] ?? 0) < 15) continue
    const a = toWorld(lap.lat[i - 10], lap.lon[i - 10], 0, tf)
    const b = toWorld(lap.lat[i + 10], lap.lon[i + 10], 0, tf)
    const dx = b.x - a.x, dz = b.z - a.z
    if (dx * dx + dz * dz < 0.04) continue        // barely moving, heading is noise
    const d = Math.atan2(dx, dz) - lap.yaw[i]
    sumS += Math.sin(d); sumC += Math.cos(d); n++
  }
  return n > 30 ? Math.atan2(sumS / n, sumC / n) : null
}

// Line-art weather glyph for the conditions card
function WeatherIcon({ kind, color }: { kind: 'sun' | 'partly' | 'cloud' | 'rain'; color: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {kind === 'sun' && (<>
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.3 5.3l1.5 1.5M17.2 17.2l1.5 1.5M18.7 5.3l-1.5 1.5M6.8 17.2l-1.5 1.5" />
      </>)}
      {kind === 'partly' && (<>
        <circle cx="8.6" cy="8.2" r="2.9" />
        <path d="M8.6 2.8v1.5M3.2 8.2h1.5M4.7 4.3l1.1 1.1M12.5 4.3l-1.1 1.1" />
        <path d="M7.4 19.4h9.1a3.4 3.4 0 0 0 .3-6.8 4.9 4.9 0 0 0-9.4 1.2 2.9 2.9 0 0 0 0 5.6Z" />
      </>)}
      {kind === 'cloud' && (
        <path d="M6.9 18.4h9.6a3.6 3.6 0 0 0 .3-7.2 5.2 5.2 0 0 0-9.9 1.3 3.1 3.1 0 0 0 0 5.9Z" />
      )}
      {kind === 'rain' && (<>
        <path d="M6.9 15.2h9.6a3.6 3.6 0 0 0 .3-7.2 5.2 5.2 0 0 0-9.9 1.3 3.1 3.1 0 0 0 0 5.9Z" />
        <path d="M9.2 18.1l-.9 2.4M13 18.1l-.9 2.4M16.8 18.1l-.9 2.4" />
      </>)}
    </svg>
  )
}

export default function Replay3DViewer() {
  const t = useT()
  const { sessions, selectedLapKeys, crosshairTime, setCrosshairTime, units } = useSessionStore()
  const mountRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef(0)
  const carMeshesRef = useRef<THREE.Mesh[]>([])  // holds THREE.Group[] at runtime
  const carWheelsRef = useRef<CarWheel[][]>([])  // per lap, once the model has loaded
  const carLightsRef = useRef<CarLights[]>([])
  const cameraPosRef = useRef(new THREE.Vector3())
  const cameraTargetRef = useRef(new THREE.Vector3())
  const cloudGroupsRef = useRef<Array<{group: THREE.Group; vx: number; vz: number}>>([]);

  // Scene handles the weather effect needs to mutate after the scene was built
  const sceneRef   = useRef<THREE.Scene | null>(null)
  const sunRef     = useRef<THREE.DirectionalLight | null>(null)
  const ambientRef = useRef<THREE.AmbientLight | null>(null)
  const roadMatRef = useRef<THREE.MeshBasicMaterial | null>(null)
  const rainRef    = useRef<{
    mesh: THREE.LineSegments
    local: Float32Array      // drop offsets relative to the camera
    world: Float32Array      // segment endpoints written each frame
    count: number
    fall: number             // units/s
    streak: number           // streak length
    dx: number; dz: number   // wind drift
    box: number; height: number
  } | null>(null)
  // Bumped after each scene rebuild so the weather effect can re-apply itself
  const [sceneEpoch, setSceneEpoch] = useState(0)

  // Detect open-wheel car for model selection
  const openWheelCar = useMemo(() => {
    if (!selectedLapKeys.length) return false
    const { sessionId } = parseLapKey(selectedLapKeys[0])
    const carName = sessions.find(s => s.id === sessionId)?.car ?? ''
    return OPEN_WHEEL_RE.test(carName)
  }, [sessions, selectedLapKeys])

  // Refs that the animation loop reads (avoids stale closures with useEffect deps)
  const playingRef = useRef(false)
  const speedRef = useRef(1)
  const currentTimeRef = useRef(0)
  const crosshairRef = useRef<number | null>(null)
  const cameraModeRef = useRef<'chase' | 'cockpit' | 'front' | 'tv'>('chase')
  const zoomRef = useRef(1)   // mouse wheel: >1 pulls back, <1 moves in
  const followIdxRef = useRef(0)
  const unitsRef = useRef<UnitSystem>('metric')   // read by the animation loop

  const [laps, setLaps] = useState<LapReplayData[]>([])
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  // currentT drives the slider — updated every 9 frames (~7fps), all other HUD values
  // are written directly to DOM refs to avoid React re-renders during playback
  const [currentT, setCurrentT] = useState(0)
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'))
  const [cameraMode, setCameraMode] = useState<'chase' | 'cockpit' | 'front' | 'tv'>('chase')
  const [hudScale, setHudScale] = useState(1)
  const [conditions, setConditions] = useState<TrackConditions | null>(null)
  const [weatherOpen, setWeatherOpen] = useState(true)
  // Which lap the camera follows — index into `laps`, 0 (the fastest) by default
  const [followIdx, setFollowIdx] = useState(0)

  const hudSpeedRefs  = useRef<(HTMLSpanElement  | null)[]>([])
  const hudGearRefs   = useRef<(HTMLSpanElement  | null)[]>([])
  const hudThrRefs    = useRef<(HTMLDivElement   | null)[]>([])
  const hudBrkRefs    = useRef<(HTMLDivElement   | null)[]>([])
  const hudWheelRefs  = useRef<(HTMLImageElement  | null)[]>([])
  const hudDegRefs    = useRef<(HTMLSpanElement  | null)[]>([])
  const hudFuelRefs   = useRef<(HTMLSpanElement  | null)[]>([])
  const hudDeltaRefs  = useRef<(HTMLSpanElement  | null)[]>([])
  // Tyre card: one entry per corner, three bands each, plus the wear readout
  const tyreBandRefs  = useRef<Record<string, (HTMLDivElement | null)[]>>({ LF: [], RF: [], LR: [], RR: [] })
  const tyreWearRefs  = useRef<Record<string, HTMLSpanElement | null>>({ LF: null, RF: null, LR: null, RR: null })
  const absLampRef    = useRef<HTMLSpanElement | null>(null)
  const spinLampRef   = useRef<HTMLSpanElement | null>(null)
  const [tyresOpen, setTyresOpen] = useState(true)
  const mapDotRefs       = useRef<(SVGCircleElement | null)[]>([])
  const hudTraceRefs     = useRef<(HTMLCanvasElement | null)[]>([])
  const trackMapDataRef  = useRef<{ d: string; startXY: [number, number]; toMapXY: (lat: number, lon: number) => [number, number] } | null>(null)

  const lapTimes = useMemo(() =>
    laps.map(lap => {
      const { sessionId, lapNumber } = parseLapKey(lap.lapKey)
      return sessions.find(s => s.id === sessionId)?.laps.find(l => l.lap_number === lapNumber)?.lap_time ?? null
    }),
    [laps, sessions]
  )

  const trackMapData = useMemo(() => {
    if (laps.length === 0 || laps[0].lat.length === 0) return null
    const lap = laps[0]
    const minLat = Math.min(...lap.lat), maxLat = Math.max(...lap.lat)
    const minLon = Math.min(...lap.lon), maxLon = Math.max(...lap.lon)
    const latR = maxLat - minLat || 0.001
    const lonR = maxLon - minLon || 0.001
    // Same longitude correction as the world transform, or the minimap shows a
    // differently distorted track than the 3D scene next to it
    const lonScale = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180)
    const scale = 90 / Math.max(latR, lonR * lonScale)
    const toMapXY = (lat: number, lon: number): [number, number] => [
      5 + (lon - minLon) * scale * lonScale,
      95 - (lat - minLat) * scale,
    ]
    const step = Math.max(1, Math.floor(lap.lat.length / 400))
    let d = ''
    for (let i = 0; i < lap.lat.length; i += step) {
      const [x, y] = toMapXY(lap.lat[i], lap.lon[i])
      d += `${d === '' ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `
    }
    d += 'Z'
    return { d, startXY: toMapXY(lap.lat[0], lap.lon[0]), toMapXY }
  }, [laps])

  useEffect(() => { trackMapDataRef.current = trackMapData }, [trackMapData])

  // Reset to start on new file load
  useEffect(() => {
    if (laps.length === 0) return
    const t0 = laps[0].timestamps[0]
    currentTimeRef.current = t0
    crosshairRef.current = null
    setCurrentT(t0)
    setPlaying(false)
  }, [laps])

  useEffect(() => { cameraModeRef.current = cameraMode }, [cameraMode])
  useEffect(() => { followIdxRef.current = followIdx }, [followIdx])
  useEffect(() => { unitsRef.current = units }, [units])
  // A new lap selection resets the camera to the first (fastest) lap
  useEffect(() => { setFollowIdx(0); followIdxRef.current = 0 }, [laps])
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setIsDark(document.documentElement.classList.contains('dark'))
    )
    obs.observe(document.documentElement, { attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  useEffect(() => { playingRef.current = playing }, [playing])
  useEffect(() => { speedRef.current = playbackSpeed }, [playbackSpeed])
  useEffect(() => { crosshairRef.current = crosshairTime }, [crosshairTime])

  // ── Data fetch ─────────────────────────────────────────────────────────────
  useEffect(() => {
    // setLoading(false) matters here: bailing out while an earlier fetch was still
    // running used to leave `loading` stuck on, and the loading branch renders
    // before the empty-selection one — so the viewer sat on "Loading 3D data…"
    if (selectedLapKeys.length === 0 || sessions.length === 0) { setLaps([]); setLoading(false); return }
    setLoading(true)
    // Only what the scene needs to appear. The rest arrives afterwards — a
    // Nordschleife lap is 26k samples, so all 33 channels at once means ~6.6 MB
    // per lap over the IPC bridge, and parsing that blocks the UI outright.
    const CHANNELS = ['Lat', 'Lon', 'Alt', 'Speed', 'Gear', 'Throttle', 'Brake', 'SteeringWheelAngle', 'FuelLevel'] as const
    // Toggling laps quickly leaves several fetches in flight — without this an
    // older one can land last and overwrite the current selection's data
    let cancelled = false

    ;(async () => {
      const out: LapReplayData[] = []
      for (let ci = 0; ci < selectedLapKeys.length && !cancelled; ci++) {
        const key = selectedLapKeys[ci]
        const { sessionId, lapNumber } = parseLapKey(key)
        const sess = sessions.find(s => s.id === sessionId)
        if (!sess) continue
        const avail = new Set(sess.available_channels.map(c => c.name))
        if (!avail.has('Lat') || !avail.has('Lon')) continue
        try {
          const results = await Promise.all(
            CHANNELS.map(ch =>
              avail.has(ch)
                ? invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNumber], channel: ch })
                    .then(r => r[0] ?? null)
                : Promise.resolve(null)
            )
          )
          const [latD, lonD, altD, speedD, gearD, throttleD, brakeD, steeringD, fuelD] = results
          if (!latD || !lonD) continue
          const n = latD.samples.length
          const fill = (d: LapChannelData | null, def = 0) => d ? d.samples : new Array<number>(n).fill(def)
          out.push({
            lapKey: key, lapNumber, colorIndex: ci,
            lat: latD.samples, lon: lonD.samples,
            alt: fill(altD),
            speed: fill(speedD),
            gear: fill(gearD, 1),
            throttle: fill(throttleD),
            brake: fill(brakeD),
            steering: fill(steeringD),
            fuel: fuelD ? fuelD.samples : [],
            distPct: latD.lap_dist_pct ?? [],
            // Filled in by the second pass — see the extras effect below
            yaw: [], pitch: [], roll: [],
            wheelSpeed: { LF: [], RF: [], LR: [], RR: [] },
            tyreTemp: { LF: [], RF: [], LR: [], RR: [] },
            tyreTempBands: {
              LF: { l: [], m: [], r: [] }, RF: { l: [], m: [], r: [] },
              LR: { l: [], m: [], r: [] }, RR: { l: [], m: [], r: [] },
            },
            tyreWear: {
              LF: { l: [], m: [], r: [] }, RF: { l: [], m: [], r: [] },
              LR: { l: [], m: [], r: [] }, RR: { l: [], m: [], r: [] },
            },
            absActive: [],
            timestamps: latD.timestamps,
          })
        } catch { /* no GPS */ }
      }
      if (cancelled) return   // a newer selection is already fetching
      setLaps(out)
      setLoading(false)
    })().catch(() => {
      // Anything unexpected must still clear the flag, or the viewer is stuck
      if (!cancelled) { setLaps([]); setLoading(false) }
    })
    return () => { cancelled = true }
  }, [selectedLapKeys.join(','), sessions.length])


  // ── Extra channels, loaded after the scene is up ───────────────────────────
  // Attitude, wheel speeds, tyre temperatures, wear and ABS are 24 more channels.
  // Fetching them with the core data pushed a Nordschleife lap to ~6.6 MB over
  // the IPC bridge and locked the window. They arrive afterwards, one at a time,
  // and are written into the existing lap objects: the scene reads these arrays
  // every frame, so filling them in takes effect without rebuilding anything.
  useEffect(() => {
    if (!laps.length) return
    let cancelled = false
    const wire: [string, (lap: LapReplayData, v: number[]) => void][] = [
      ['Yaw',   (l, v) => { l.yaw = v }],
      ['Pitch', (l, v) => { l.pitch = v }],
      ['Roll',  (l, v) => { l.roll = v }],
      ['BrakeABSactive', (l, v) => { l.absActive = v }],
    ]
    for (const c of ['LF', 'RF', 'LR', 'RR'] as Corner[]) {
      wire.push([`${c}speed`, (l, v) => { l.wheelSpeed[c] = v }])
      wire.push([`${c}tempL`, (l, v) => { l.tyreTempBands[c].l = v }])
      wire.push([`${c}tempM`, (l, v) => { l.tyreTempBands[c].m = v; l.tyreTemp[c] = v }])
      wire.push([`${c}tempR`, (l, v) => { l.tyreTempBands[c].r = v }])
      wire.push([`${c}wearL`, (l, v) => { l.tyreWear[c].l = v }])
      wire.push([`${c}wearM`, (l, v) => { l.tyreWear[c].m = v }])
      wire.push([`${c}wearR`, (l, v) => { l.tyreWear[c].r = v }])
    }

    ;(async () => {
      for (const lap of laps) {
        const { sessionId, lapNumber } = parseLapKey(lap.lapKey)
        const sess = sessions.find(s => s.id === sessionId)
        if (!sess) continue
        const avail = new Set(sess.available_channels.map(c => c.name))
        // Thin these out: they drive colours and flags, not motion, so one value
        // every ~0.1 s is plenty. A 26k-sample lap becomes 4k values per channel.
        const stride = Math.max(1, Math.round(lap.timestamps.length / 4000))
        for (const [channel, assign] of wire) {
          if (cancelled) return
          if (!avail.has(channel)) continue
          try {
            const r = await invoke<LapChannelData[]>('get_lap_channel_data',
              { sessionId, lapNumbers: [lapNumber], channel, stride })
            if (cancelled) return
            // Stretch back to the core series' length so the same index works
            if (r[0]) assign(lap, resample(r[0].samples, lap.timestamps.length))
          } catch { /* channel missing or unreadable — feature stays off */ }
          // Yield between channels so the UI keeps breathing on long laps
          await new Promise(res => setTimeout(res, 0))
        }
      }
    })()
    return () => { cancelled = true }
  }, [laps, sessions])

  // ── Track / weather conditions ─────────────────────────────────────────────
  // Live channel values (averaged over the primary lap) with the session YAML
  // snapshot as fallback for older files that don't log the weather channels
  useEffect(() => {
    if (selectedLapKeys.length === 0 || sessions.length === 0) { setConditions(null); return }
    const { sessionId, lapNumber } = parseLapKey(selectedLapKeys[0])
    const sess = sessions.find(s => s.id === sessionId)
    if (!sess) { setConditions(null); return }
    const avail = new Set(sess.available_channels.map(c => c.name))
    const W_CHANNELS = ['TrackTempCrew', 'AirTemp', 'RelativeHumidity', 'WindVel', 'WindDir',
                        'Skies', 'Precipitation', 'FogLevel', 'TrackWetness'] as const
    let cancelled = false

    ;(async () => {
      const yaml = await invoke<string>('get_session_yaml', { sessionId }).catch(() => '')
      const chans = await Promise.all(W_CHANNELS.map(ch =>
        avail.has(ch)
          ? invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNumber], channel: ch })
              .then(r => meanOf(r[0]?.samples)).catch(() => null)
          : Promise.resolve(null)
      ))
      if (cancelled) return
      const [trackTemp, airTemp, humidity, windVel, windDir, skies, precip, fog, wetness] = chans
      setConditions({
        trackTemp:   trackTemp ?? yamlNum(yaml, 'TrackSurfaceTemp'),
        airTemp:     airTemp   ?? yamlNum(yaml, 'TrackAirTemp'),
        // Humidity / precipitation / fog are logged as 0–1 fractions, YAML has them as %
        humidity:    humidity != null ? humidity * 100 : yamlNum(yaml, 'TrackRelativeHumidity'),
        windVel:     windVel   ?? yamlNum(yaml, 'TrackWindVel'),
        windDir:     windDir   ?? yamlNum(yaml, 'TrackWindDir'),
        skies:       skies != null ? Math.round(skies) : null,
        precip:      precip != null ? precip * 100 : yamlNum(yaml, 'TrackPrecipitation'),
        fog:         fog    != null ? fog    * 100 : yamlNum(yaml, 'TrackFogLevel'),
        wetness:     wetness != null ? Math.round(wetness) : null,
        weatherType: yamlStr(yaml, 'TrackSkies') ?? yamlStr(yaml, 'TrackWeatherType'),
        timeOfDay:   yamlStr(yaml, 'TimeOfDay'),
        rubber:      yamlStr(yaml, 'SessionTrackRubberState'),
      })
    })()
    return () => { cancelled = true }
  }, [selectedLapKeys[0], sessions.length])

  // ── World transform ────────────────────────────────────────────────────────
  const tf = useMemo(() => {
    if (laps.length === 0) return null
    const allLat: number[] = [], allLon: number[] = [], allAlt: number[] = []
    for (const lap of laps) {
      for (const v of lap.lat) allLat.push(v)
      for (const v of lap.lon) allLon.push(v)
      for (const v of lap.alt) allAlt.push(v)
    }
    return buildWorldTF(allLat, allLon, allAlt)
  }, [laps])

  // ── Three.js scene ─────────────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current
    if (!mount || laps.length === 0 || !tf) return

    const { width, height } = mount.getBoundingClientRect()
    const w = width || 300
    const h = height || 400

    // Scene — colors adapt to light/dark mode
    const skyCol  = isDark ? SKY_DARK : SKY_LIGHT
    const gndCol  = isDark ? 0x111612 : 0x5a7d3a
    const roadCol = isDark ? 0x26262c : 0x383840
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(skyCol)
    scene.fog = new THREE.Fog(skyCol, 300, 1200)
    sceneRef.current = scene

    // Camera
    const camera = new THREE.PerspectiveCamera(65, w / h, 0.1, 5000)

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(w, h)
    mount.appendChild(renderer.domElement)

    // Lights — brighter ambient in light mode for realistic daylight feel
    const ambient = new THREE.AmbientLight(0xffffff, isDark ? 0.55 : 1.1)
    scene.add(ambient)
    const sun = new THREE.DirectionalLight(0xffffff, isDark ? 2.2 : 3.0)
    sun.position.set(80, 200, 80)
    scene.add(sun)
    ambientRef.current = ambient
    sunRef.current = sun

    // ── Track surface ──────────────────────────────────────────────────────
    const pLap = laps[0]

    // Track shape comes from the cleanest selected lap, not necessarily the first
    // one: a lap with a spin or an off would drag the road along with it
    const sampled = laps.map(l => sampleCentreline(l, tf))
    const cleanest = sampled.reduce((best, s) => s.back < best.back ? s : best, sampled[0])
    // Everything below (road, curbs, runoff, terrain, trees) is offset from this
    // line, so it also has to be free of GPS jitter — see smoothPath
    const basePts = smoothPath(cleanest.pts, 12, tf.unitsPerMetre)   // ±12 m of track
    // Metres to world units for this track — see the *_M constants
    const M = tf.unitsPerMetre
    const ROAD_WIDTH = ROAD_WIDTH_M * M
    const CAM_BACK = 21 * M, CAM_UP = 8 * M   // chase camera offsets, in metres
    const LINE_WIDTH = LINE_WIDTH_M * M

    // ── Elevation terrain grid ─────────────────────────────────────────────
    // T_NEAR=20: any vertex within 20wu of track center → set to road height (flush, no float).
    // T_FAR=60:  blend to IDW beyond that.
    // Safety clamp ensures terrain ≤ closestY-0.12 in the entire near zone → no clipping.

    // The blend radii must not fall below the terrain's own resolution, or no
    // grid vertex lands inside them and the road floats free of the ground. One
    // cell is 17.8 units — 92 m at Spa but 270 m on the Nordschleife.
    const TERRAIN_CELLS = 160
    const TERRAIN_CELL = 1600 / TERRAIN_CELLS
    const T_NEAR = Math.max(45 * M, TERRAIN_CELL * 1.6)
    const T_FAR  = Math.max(140 * M, TERRAIN_CELL * 4.5)
    const terrainGeo = new THREE.PlaneGeometry(1600, 1600, TERRAIN_CELLS, TERRAIN_CELLS)
    terrainGeo.rotateX(-Math.PI / 2)
    const tPos = terrainGeo.attributes.position as THREE.BufferAttribute
    // Shielding radius kept local: taking the lowest road point across the whole
    // T_NEAR ring pulled the ground down by the elevation change over that ring —
    // 77 m on the Nordschleife, where T_NEAR spans 430 m.
    const SHIELD = Math.max(TERRAIN_CELL * 1.2, 30 * M)
    const SHIELD_SQ = SHIELD * SHIELD
    // Falloff for the distance weighting, in metres rather than a fixed unit
    // count: the old constant behaved like 680 m on a big track, which averaged
    // the whole lap into one flat height.
    const IDW_SOFT = (30 * M) * (30 * M)
    const groundHeightAt = (vx: number, vz: number): number => {
      let minD2 = Infinity, closestY = 0, minNearY = Infinity
      // j+=1: find true nearest road point — j+=2 could skip odd-index nearest → wrong closestY → clipping
      for (let j = 0; j < basePts.length; j++) {
        const dx = basePts[j].x - vx, dz = basePts[j].z - vz
        const d2 = dx * dx + dz * dz
        if (d2 < minD2) { minD2 = d2; closestY = basePts[j].y }
        if (d2 < SHIELD_SQ) minNearY = Math.min(minNearY, basePts[j].y)
      }
      // IDW with j+=2 is fine for smooth height (nearby jitter negligible)
      let totalW = 0, weightedY = 0
      for (let j = 0; j < basePts.length; j += 2) {
        const dx = basePts[j].x - vx, dz = basePts[j].z - vz
        const w = 1 / (dx * dx + dz * dz + IDW_SOFT)
        weightedY += basePts[j].y * w; totalW += w
      }
      const idwY = weightedY / totalW - 0.5 * M
      // Stay under the nearby tarmac so the ground never pokes through it
      const floorY = Math.min(closestY, minNearY < Infinity ? minNearY : closestY) - 1.8 * M
      const minD = Math.sqrt(minD2)
      if (minD <= T_NEAR) return floorY
      if (minD < T_FAR) {
        const st = (minD - T_NEAR) / (T_FAR - T_NEAR)
        return Math.min(floorY * (1 - st) + idwY * st, floorY)
      }
      return idwY
    }
    for (let vi = 0; vi < tPos.count; vi++) {
      tPos.setY(vi, groundHeightAt(tPos.getX(vi), tPos.getZ(vi)))
    }
    tPos.needsUpdate = true
    terrainGeo.computeVertexNormals()

    // Per-vertex colour noise — breaks up the flat single-colour grass
    const gndBase  = new THREE.Color(gndCol)
    const gndAlt1  = new THREE.Color(isDark ? 0x1e2a18 : 0x3d5c22)   // darker/cooler
    const gndAlt2  = new THREE.Color(isDark ? 0x0c110a : 0x728a3a)   // lighter/drier
    const tCol = new Float32Array(tPos.count * 3)
    for (let vi = 0; vi < tPos.count; vi++) {
      const vx = tPos.getX(vi), vz = tPos.getZ(vi)
      // Large-scale variation
      const n1 = (
        Math.sin(vx * 0.031 + vz * 0.027) * 0.40 +
        Math.sin(vx * 0.019 - vz * 0.043) * 0.35 +
        Math.sin((vx + vz) * 0.011)        * 0.25
      ) * 0.5 + 0.5
      // Mid-frequency detail
      const n2 = (
        Math.sin(vx * 0.071 + vz * 0.059) * 0.55 +
        Math.sin(vx * 0.047 - vz * 0.083) * 0.45
      ) * 0.5 + 0.5
      const c = gndBase.clone()
        .lerp(gndAlt1, n1 * 0.70)
        .lerp(gndAlt2, n2 * 0.40)
      tCol[vi * 3] = c.r; tCol[vi * 3 + 1] = c.g; tCol[vi * 3 + 2] = c.b
    }
    terrainGeo.setAttribute('color', new THREE.BufferAttribute(tCol, 3))
    scene.add(new THREE.Mesh(terrainGeo, new THREE.MeshLambertMaterial({ vertexColors: true })))

    // Road surface — material kept in a ref so wet conditions can darken it
    const roadMat = new THREE.MeshBasicMaterial({ color: roadCol, side: THREE.DoubleSide })
    roadMatRef.current = roadMat
    scene.add(new THREE.Mesh(buildRibbon(basePts, ROAD_WIDTH, true), roadMat))

    // Per-lap coloured driving line
    for (const lap of laps) {
      const lapStep = Math.max(1, Math.floor(lap.lat.length / MAX_TRACK_PTS))
      const lapPts: THREE.Vector3[] = []
      for (let i = 0; i < lap.lat.length; i += lapStep)
        lapPts.push(toWorld(lap.lat[i], lap.lon[i], lap.alt[i], tf))
      const lapMesh = new THREE.Mesh(
        buildRibbon(lapPts, LINE_WIDTH, true),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(getLapColor(lap.colorIndex)), side: THREE.DoubleSide }),
      )
      lapMesh.position.y = 0.12 * M
      scene.add(lapMesh)
    }

    // White edge strips
    const halfW = ROAD_WIDTH / 2
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })
    for (const sign of [-1, 1])
      scene.add(new THREE.Mesh(buildRibbon(offsetPath(basePts, sign * halfW, 0.25 * M), 1.1 * M, true), edgeMat))

    // ── Corner detection → curbs only at corners ───────────────────────────
    // Compute smoothed signed curvature (XZ cross product of consecutive direction vectors)
    const curvRaw = new Float32Array(basePts.length)
    for (let i = 2; i < basePts.length - 2; i++) {
      const d1 = new THREE.Vector3().subVectors(basePts[i], basePts[Math.max(0, i - 3)])
      const d2 = new THREE.Vector3().subVectors(basePts[Math.min(basePts.length - 1, i + 3)], basePts[i])
      const cross = d1.x * d2.z - d1.z * d2.x
      const denom = d1.length() * d2.length()
      curvRaw[i] = denom > 0.001 ? cross / denom : 0
    }
    const curvSm = new Float32Array(basePts.length)
    for (let i = 0; i < basePts.length; i++) {
      let sum = 0, cnt = 0
      for (let k = Math.max(0, i - 7); k <= Math.min(basePts.length - 1, i + 7); k++) { sum += curvRaw[k]; cnt++ }
      curvSm[i] = sum / cnt
    }
    const CURV_THR = 0.035
    const corners2: { start: number; end: number; apex: number; side: number; curv: number }[] = []
    let inC = false, cStart = 0, apexI = 0, apexV = 0
    for (let i = 0; i < basePts.length; i++) {
      if (Math.abs(curvSm[i]) > CURV_THR) {
        if (!inC) { inC = true; cStart = i; apexI = i; apexV = 0 }
        if (Math.abs(curvSm[i]) > apexV) { apexV = Math.abs(curvSm[i]); apexI = i }
      } else if (inC) {
        inC = false
        if (i - cStart > 4) corners2.push({ start: cStart, end: i - 1, apex: apexI, side: Math.sign(curvSm[apexI]), curv: apexV })
      }
    }
    // Helper: build alternating red/white curb from a slice of basePts, offset to one side
    const curbRed = new THREE.MeshBasicMaterial({ color: isDark ? 0x991111 : 0xdd1111, side: THREE.DoubleSide })
    const curbWht = new THREE.MeshBasicMaterial({ color: isDark ? 0xa8a8a8 : 0xffffff, side: THREE.DoubleSide })
    const CURB_W = CURB_W_M * M, CURB_STRIPE = CURB_STRIPE_M * M
    const addCurb = (pts: THREE.Vector3[], side: number) => {
      if (pts.length < 2) return
      // 0.275 = half the edge-strip width so curb inner edge is flush with white strip outer edge
      const strip = offsetPath(pts, side * (halfW + 0.55 * M + CURB_W / 2), 0.18 * M)
      let dist = 0, ss = 0, ci = 0
      for (let i = 1; i <= strip.length; i++) {
        if (i < strip.length) dist += strip[i].distanceTo(strip[i - 1])
        if (dist >= CURB_STRIPE || i === strip.length) {
          const seg = strip.slice(ss, i + 1)
          if (seg.length > 1) scene.add(new THREE.Mesh(
            buildRibbon(seg, CURB_W, false), ci % 2 === 0 ? curbRed : curbWht))
          ss = i; dist = 0; ci++
        }
      }
    }
    const n = basePts.length
    // Merge helper: sort ranges, then join any pair whose gap is ≤ `gap` indices
    const mergeSegs = (segs: {s: number; e: number}[], gap = 20) => {
      if (!segs.length) return []
      const sorted = [...segs].sort((a, b) => a.s - b.s)
      const out = [{ ...sorted[0] }]
      for (let i = 1; i < sorted.length; i++) {
        const last = out[out.length - 1]
        if (sorted[i].s <= last.e + gap) last.e = Math.max(last.e, sorted[i].e)
        else out.push({ ...sorted[i] })
      }
      return out
    }
    // Inner apex curbs stay per-corner (short, centred on apex, no merging needed)
    for (const c of corners2) {
      const span = c.end - c.start
      const aR = Math.max(5, Math.round(span * 0.28))
      addCurb(basePts.slice(Math.max(0, c.apex - aR), Math.min(n, c.apex + aR + 1)), c.side)
    }
    // Outer curbs: collect entry + exit ranges per side, then merge adjacent ones
    const outerCurbSegs: Record<string, {s: number; e: number}[]> = { '1': [], '-1': [] }
    for (const c of corners2) {
      const side = String(-c.side)
      const span = c.end - c.start
      const eR = Math.max(10, Math.round(span * 0.45))
      outerCurbSegs[side].push({ s: Math.max(0, c.start - 12), e: Math.min(n, c.start + eR) })
      outerCurbSegs[side].push({ s: Math.max(0, c.end - eR),   e: Math.min(n, c.end + 12) })
    }
    for (const [side, segs] of Object.entries(outerCurbSegs)) {
      for (const seg of mergeSegs(segs)) {
        addCurb(basePts.slice(seg.s, seg.e), Number(side))
      }
    }

    // ── Gravel/sand runoff areas (outside of corners only) ────────────────
    const RUNOFF_W    = RUNOFF_W_M * M
    const RUNOFF_INNER = halfW + 0.5 * M + CURB_W + 0.8 * M   // starts just past outer curb edge
    // Stamp noise-based vertex colours onto a ribbon so sand doesn't look uniformly flat
    const noiseRibbon = (geo: THREE.BufferGeometry, c1: THREE.Color, c2: THREE.Color, c3: THREE.Color) => {
      const p = geo.attributes.position as THREE.BufferAttribute
      const buf = new Float32Array(p.count * 3)
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), z = p.getZ(i)
        const n1 = (Math.sin(x * 0.11 + z * 0.09) + Math.sin(x * 0.07 - z * 0.13)) * 0.25 + 0.5
        const n2 = (Math.sin(x * 0.23 + z * 0.19) + Math.sin(x * 0.17 - z * 0.29)) * 0.25 + 0.5
        const c = c1.clone().lerp(c2, Math.max(0, Math.min(1, n1)) * 0.70)
                            .lerp(c3, Math.max(0, Math.min(1, n2)) * 0.45)
        buf[i * 3] = c.r; buf[i * 3 + 1] = c.g; buf[i * 3 + 2] = c.b
      }
      geo.setAttribute('color', new THREE.BufferAttribute(buf, 3))
      return geo
    }
    const gravelC1 = new THREE.Color(isDark ? 0x3a3020 : 0xd4b86a)
    const gravelC2 = new THREE.Color(isDark ? 0x22180e : 0xb88840)
    const gravelC3 = new THREE.Color(isDark ? 0x46382a : 0xe8c87a)
    const fringeC1 = new THREE.Color(isDark ? 0x28231a : 0xb89a50)
    const fringeC2 = new THREE.Color(isDark ? 0x161008 : 0x907030)
    const fringeC3 = new THREE.Color(isDark ? 0x342a1e : 0xcaaa60)
    const gravelMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
    const fringeMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })

    // Limits for everything that runs alongside the road, measured once on the
    // centreline: the corner radius (so a strip can't fold through a hairpin)
    // and the clearance to other sections (so it can't cross them).
    const baseLim   = lateralLimits(basePts)
    const baseClear = selfClearance(basePts, baseLim.perp, 150 * M)
    // A strip between two lateral distances, following the centreline. Both
    // edges obey the limits above, so where a neighbouring section crowds in the
    // strip narrows and finally disappears rather than cutting through it.
    const sideStrip = (
      s: number, e: number, side: number, innerD: number, outerD: number,
      yIn:  (p: THREE.Vector3, x: number, z: number) => number,
      yOut: (p: THREE.Vector3, x: number, z: number) => number,
    ) => {
      const cnt = e - s + 1
      const pos = new Float32Array(cnt * 6)
      const idx: number[] = []
      for (let k = 0; k < cnt; k++) {
        const i = s + k
        const p = basePts[i], pe = baseLim.perp[i]
        const R   = side > 0 ? baseLim.posR[i] : baseLim.negR[i]
        const cap = side > 0 ? baseClear.pos[i] : baseClear.neg[i]
        const di = Math.min(softOffset(innerD, R), cap)
        const dO = Math.min(softOffset(outerD, R), cap)
        const ix = p.x + pe.x * side * di, iz = p.z + pe.z * side * di
        const ox = p.x + pe.x * side * dO, oz = p.z + pe.z * side * dO
        const o = k * 6
        pos[o]     = ix; pos[o + 1] = yIn(p, ix, iz);  pos[o + 2] = iz
        pos[o + 3] = ox; pos[o + 4] = yOut(p, ox, oz); pos[o + 5] = oz
        if (k < cnt - 1) { const a = k * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, b, d, a, d, c) }
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setIndex(idx)
      geo.computeVertexNormals()
      return geo
    }

    const addRunoff = (s: number, e: number, side: number) => {
      if (e - s < 1) return
      // Gravel sits a little below the tarmac, like a real trap
      const gravelY = (p: THREE.Vector3) => p.y - 0.35 * M
      const fringeY = (p: THREE.Vector3) => p.y - 0.40 * M
      scene.add(new THREE.Mesh(noiseRibbon(
        sideStrip(s, e, side, RUNOFF_INNER, RUNOFF_INNER + RUNOFF_W, gravelY, gravelY),
        gravelC1, gravelC2, gravelC3), gravelMat))
      // Blend fringe (darker sand-to-grass) at outer edge — softens the hard cutoff
      scene.add(new THREE.Mesh(noiseRibbon(
        sideStrip(s, e, side, RUNOFF_INNER + RUNOFF_W, RUNOFF_INNER + RUNOFF_W + 3 * M, fringeY, fringeY),
        fringeC1, fringeC2, fringeC3), fringeMat))
    }
    const RUNOFF_CURV_THR = 0.09   // only at sharp corners (gentle bends stay clean)
    // Collect runoff ranges per side, then merge so adjacent corners share one continuous zone
    const runoffSegs: Record<string, {s: number; e: number}[]> = { '1': [], '-1': [] }
    for (const c of corners2) {
      if (c.curv < RUNOFF_CURV_THR) continue
      const side = String(-c.side)
      const span = c.end - c.start
      const eR   = Math.max(10, Math.round(span * 0.45))
      runoffSegs[side].push({ s: Math.max(0, c.start - 12), e: Math.min(n, c.start + eR) })
      runoffSegs[side].push({ s: Math.max(0, c.end - eR),   e: Math.min(n, c.end + 12) })
    }
    for (const [side, segs] of Object.entries(runoffSegs)) {
      for (const seg of mergeSegs(segs)) {
        addRunoff(seg.s, Math.min(seg.e, n - 1), Number(side))
      }
    }


    // ── Verge: ties the road to the ground ────────────────────────────────────
    // The terrain grid samples height at vertices up to half a cell away — 50 m
    // on the Nordschleife — so it can never meet the tarmac exactly, and the road
    // was left floating a good 20 m in the air. This strip runs the length of the
    // track: its inner edge sits at road level, its outer edge on the ground the
    // terrain actually draws, closing the gap regardless of grid resolution.
    // Where two sections crowd each other the strip stops at the midpoint, and
    // since both sides end on groundHeightAt of the same spot they meet flush.
    {
      const inner = RUNOFF_INNER + RUNOFF_W + 4 * M
      const outer = inner + 90 * M
      const vergeMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
      const c1 = new THREE.Color(gndCol)
      const c2 = new THREE.Color(isDark ? 0x1e2a18 : 0x3d5c22)
      // Same grass tones as the terrain, mottled so it doesn't read as a band
      const paint = (geo: THREE.BufferGeometry) => {
        const cnt = (geo.attributes.position as THREE.BufferAttribute).count
        const col = new Float32Array(cnt * 3)
        for (let v = 0; v < cnt; v++) {
          const t = (Math.sin((v >> 1) * 0.21) * 0.5 + 0.5) * 0.65
          const ci = new THREE.Color().copy(c1).lerp(c2, t)
          col[v * 3] = ci.r; col[v * 3 + 1] = ci.g; col[v * 3 + 2] = ci.b
        }
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
        return geo
      }
      for (const side of [-1, 1]) {
        // Flat apron from the road edge out to where the verge starts. Gravel is
        // only laid at corners, so everywhere else this is the only thing
        // covering the ground between tarmac and terrain. It sits half a metre
        // below the road, which keeps the gravel and kerbs on top of it.
        scene.add(new THREE.Mesh(paint(sideStrip(0, n - 1, side, halfW, inner,
          p => p.y - 0.5 * M, p => p.y - 0.6 * M)), vergeMat))
        // …and from there down to the terrain, picking up exactly the height the
        // grid draws so the two meet flush
        scene.add(new THREE.Mesh(paint(sideStrip(0, n - 1, side, inner, outer,
          p => p.y - 0.6 * M, (_p, x, z) => groundHeightAt(x, z))), vergeMat))
      }
    }

    // ── Background mountain range — continuous connected ridge ─────────────
    // Build two rings (main range + foothills) as single solid BufferGeometry each.
    // Height profile = layered sine waves → natural ridgeline, no gaps between peaks.
    const buildMtnRing = (innerR: number, outerR: number, segs: number,
      hFn: (t: number) => number, color: number) => {
      // Each segment point has 4 vertices: innerTop, innerBot, outerTop, outerBot
      const pos = new Float32Array((segs + 1) * 4 * 3)
      const idx: number[] = []
      for (let i = 0; i <= segs; i++) {
        const t = i / segs
        const a = t * Math.PI * 2
        const cx = Math.sin(a), cz = Math.cos(a)
        const h = hFn(t), hOut = h * 0.55
        const base = i * 4 * 3
        // innerTop
        pos[base]   = cx * innerR; pos[base+1] = h;   pos[base+2] = cz * innerR
        // innerBot
        pos[base+3] = cx * innerR; pos[base+4] = -20; pos[base+5] = cz * innerR
        // outerTop
        pos[base+6] = cx * outerR; pos[base+7] = hOut; pos[base+8] = cz * outerR
        // outerBot
        pos[base+9] = cx * outerR; pos[base+10]= -20; pos[base+11]= cz * outerR
        if (i < segs) {
          const A = i*4, B=A+1, C=A+2, D=A+3, E=(i+1)*4, F=E+1, G=E+2, H=E+3
          idx.push(A,F,B, A,E,F)   // inner face (toward track)
          idx.push(C,D,H, D,G,H)   // outer face (away from track)  — wait wrong
          idx.push(A,C,G, A,G,E)   // top ridge
        }
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setIndex(idx); geo.computeVertexNormals()
      scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide })))
    }
    // Main range — large connected ridge far away
    buildMtnRing(1050, 1350, 140, t => Math.max(8,
      110 + 100 * Math.sin(t * Math.PI * 2 * 5 + 0.7)
          + 55  * Math.sin(t * Math.PI * 2 * 9 + 1.5)
          + 30  * Math.sin(t * Math.PI * 2 * 13 + 0.3)
          + 20  * Math.sin(t * Math.PI * 2 * 3  + 2.1)
    ), 0x5e6e90)
    // Foothills — closer, lower, slightly different hue
    buildMtnRing(680, 920, 100, t => Math.max(5,
      50 + 45 * Math.sin(t * Math.PI * 2 * 7 + 1.1)
         + 25 * Math.sin(t * Math.PI * 2 * 12 + 0.6)
         + 15 * Math.sin(t * Math.PI * 2 * 4  + 1.8)
    ), 0x6a7a8c)

    // Clouds, rain and fog are built by the weather effect below (they depend on
    // the session's sky/precipitation values, which arrive after the scene data)

    // ── Trees ─────────────────────────────────────────────────────────────
    const seededRand = (seed: number) => { const x = Math.sin(seed + 1) * 10000; return x - Math.floor(x) }
    const trunkMat = new THREE.MeshLambertMaterial({ color: isDark ? 0x130a04 : 0x5c3a1e })
    const crownMats = (isDark
      ? [0x0d1f0a, 0x101c0d, 0x0a1808, 0x121e0f, 0x0c1a09, 0x0f1c0c]
      : [0x2d6a1e, 0x3d7a26, 0x4a8c30, 0x3b7322, 0x527d38, 0x245c18]
    ).map(c => new THREE.MeshLambertMaterial({ color: c }))
    const TREE_CLEAR = halfW + TREE_CLEAR_M * M    // trees start well clear of road + runoff
    const TREE_CLEAR_SQ = TREE_CLEAR * TREE_CLEAR
    const tooClose = (px: number, pz: number): boolean => {
      for (let j = 0; j < basePts.length; j++) {
        const dx = basePts[j].x - px, dz = basePts[j].z - pz
        if (dx * dx + dz * dz < TREE_CLEAR_SQ) return true
      }
      return false
    }
    let treeIdx = 0
    for (let i = 0; i < basePts.length; i += 5) {
      for (const side of [-1, 1]) {
        if (seededRand(i * 17 + side * 5) < 0.42) continue
        const prev = basePts[Math.max(0, i - 1)]
        const next = basePts[Math.min(basePts.length - 1, i + 1)]
        const tan  = new THREE.Vector3().subVectors(next, prev).normalize()
        const perp = new THREE.Vector3(-tan.z, 0, tan.x)
        const lateral = (32 + seededRand(i * 11 + side * 7) * 60) * M
        const fwdJitter = (seededRand(i * 23 + side) - 0.5) * 14 * M
        const treeH = (TREE_MIN_M + seededRand(i * 19 + side * 3) * (TREE_MAX_M - TREE_MIN_M)) * M
        const pos = basePts[i].clone().addScaledVector(perp, side * lateral).addScaledVector(tan, fwdJitter)
        if (tooClose(pos.x, pos.z)) continue
        // Same height rule the ground uses, so trees stand on it rather than in it
        pos.y = groundHeightAt(pos.x, pos.z)
        const trunkH = treeH * 0.32
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35 * M, 0.55 * M, trunkH, 5), trunkMat)
        trunk.position.set(pos.x, pos.y + trunkH / 2, pos.z)
        scene.add(trunk)
        const crown = new THREE.Mesh(new THREE.ConeGeometry(treeH * 0.40, treeH * 0.78, 6), crownMats[treeIdx % crownMats.length])
        crown.position.set(pos.x, pos.y + trunkH + treeH * 0.32, pos.z)
        scene.add(crown)
        treeIdx++
      }
    }

    // ── Tyre smoke ────────────────────────────────────────────────────────
    // A shared pool of billboards. Locking or spinning wheels spawn one at the
    // contact patch; it drifts up, grows and fades. Recycled oldest-first so the
    // count is fixed no matter how long the lock lasts.
    const SMOKE_MAX = 90
    const smokeGeo = new THREE.PlaneGeometry(1, 1)
    const smokeMat = new THREE.MeshBasicMaterial({
      color: 0xd8d8d8, transparent: true, opacity: 0, depthWrite: false,
    })
    type Puff = { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; max: number; size: number; vy: number }
    const puffs: Puff[] = []
    for (let i = 0; i < SMOKE_MAX; i++) {
      const mat = smokeMat.clone()
      const mesh = new THREE.Mesh(smokeGeo, mat)
      mesh.visible = false
      mesh.frustumCulled = false
      scene.add(mesh)
      puffs.push({ mesh, mat, life: 0, max: 1, size: 1, vy: 0 })
    }
    let puffNext = 0
    let frameNow = 0            // animate() stamps this each frame
    const puffPos = new THREE.Vector3()
    // Throttled per wheel so one long lock doesn't burn the whole pool at 60 fps
    const lastPuff: number[][] = laps.map(() => [0, 0, 0, 0])
    const CORNER_IDX: Record<Corner, number> = { LF: 0, RF: 1, LR: 2, RR: 3 }
    const puffSmoke = (li: number, w: CarWheel, strength: number) => {
      const slot = CORNER_IDX[w.corner]
      if (frameNow - lastPuff[li][slot] < 45) return    // ~22 puffs/s per wheel
      lastPuff[li][slot] = frameNow
      w.mesh.getWorldPosition(puffPos)
      const p = puffs[puffNext]
      puffNext = (puffNext + 1) % SMOKE_MAX
      p.mesh.position.copy(puffPos)
      p.mesh.position.y -= w.radius * 0.8               // down at the contact patch
      p.life = 0
      p.max = 0.5 + strength * 0.7                      // seconds
      p.size = w.radius * (0.9 + strength * 1.6)
      p.vy = 0.6 + strength * 1.2
      p.mesh.visible = true
      p.mat.opacity = 0.30 + strength * 0.28
      p.mesh.scale.setScalar(p.size)
    }

    // Computed lazily: Yaw arrives with the extras, after the scene is built.
    // undefined = not tried yet, null = no usable data.
    const yawOffsets: (number | null | undefined)[] = laps.map(() => undefined)

    // Car placeholder groups (shown immediately while OBJ loads)
    const carGroups: THREE.Group[] = laps.map(() => {
      const g = buildPlaceholderCar(CAR_WIDTH_M * M / 1.4)
      scene.add(g)
      return g
    })
    carMeshesRef.current = carGroups as unknown as THREE.Mesh[]

    // Load the real OBJ model and replace placeholders per lap
    let loadCancelled = false
    const modelUrl = openWheelCar ? F1_MODEL_URL : GT_MODEL_URL
    new OBJLoader().loadAsync(modelUrl)
      .then((baseModel: THREE.Group) => {
        if (loadCancelled) return
        // Rotation first, then fit: fitToWorldUnits centres the model on its
        // bounding box, and three applies position outside the rotation. Centring
        // before rotating left the F1 sitting 0.18 units off its own axis — beside
        // its racing line, and every zone measured from the box was off with it.
        // Porsche faces -Z natively → flip 180°; F1 faces +X natively → rotate -90°
        baseModel.rotation.y = openWheelCar ? -Math.PI / 2 : Math.PI
        fitToWorldUnits(baseModel, CAR_WIDTH_M * M)
        // Split the wheels off before cloning — clones share geometry, so the
        // re-homing must happen exactly once
        prepareWheels(baseModel)
        // Measured after the rotation correction, so the box is already in the
        // car frame the lights are placed in (nose at +Z)
        const carBox = new THREE.Box3().setFromObject(baseModel)
        const darkParts = shadeDarkParts(baseModel, carBox)
        // Closed-wheel car: carve the tail lights out of the bodywork. The
        // formula car has no such panel, so it keeps the built lamp.
        const tailGeo = openWheelCar ? null : buildTailLightBand(baseModel, carBox, darkParts)
        // Raycast the lamp seats once — same for every lap's copy of the car
        const lampSpots = computeLampSpots(baseModel, carBox, openWheelCar)

        carWheelsRef.current = []
        carLightsRef.current = []
        laps.forEach((lap, i) => {
          const innerModel = baseModel.clone(true)
          applyLapColor(innerModel, getLapColor(lap.colorIndex))
          carWheelsRef.current[i] = collectWheels(innerModel)
          // Outer group receives yaw from animation loop; inner model keeps the 180° correction
          const outerGroup = new THREE.Group()
          outerGroup.rotation.order = 'YXZ'   // yaw, then pitch — see buildPlaceholderCar
          outerGroup.add(innerModel)
          carLightsRef.current[i] = addCarLights(outerGroup, lampSpots, carBox, openWheelCar, tailGeo)
          outerGroup.position.copy(carGroups[i].position)
          outerGroup.rotation.copy(carGroups[i].rotation)
          scene.remove(carGroups[i])
          scene.add(outerGroup)
          carGroups[i] = outerGroup
        })
      })
      .catch(() => { /* OBJ failed to load — keep placeholder */ })


    // Always start from the beginning when a new scene is built (new file loaded)
    const tInit = pLap.timestamps[0]
    const initIdx = bsearchNearest(pLap.timestamps, tInit)
    const initPos = toWorld(pLap.lat[initIdx], pLap.lon[initIdx], pLap.alt[initIdx], tf)
    // Estimate forward direction at init
    const initNext = bsearchNearest(pLap.timestamps, tInit + 0.5)
    const initFwd = initNext > initIdx
      ? toWorld(pLap.lat[initNext], pLap.lon[initNext], pLap.alt[initNext], tf).sub(initPos).normalize()
      : new THREE.Vector3(0, 0, 1)
    cameraPosRef.current.copy(initPos)
      .addScaledVector(initFwd, -8)
      .setY(initPos.y + 3)
    cameraTargetRef.current.copy(initPos).addScaledVector(initFwd, 7).setY(initPos.y + 0.8)
    camera.position.copy(cameraPosRef.current)
    camera.lookAt(cameraTargetRef.current)
    currentTimeRef.current = tInit

    // Resize
    const ro = new ResizeObserver(entries => {
      const { width: nw, height: nh } = entries[0].contentRect
      if (!nw || !nh) return
      renderer.setSize(nw, nh)
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
    })
    ro.observe(mount)

    // Rolling telemetry buffers — one per lap, reset with each scene

    // TV cam — 16 trackside positions, close to the action
    const TV_CAM_COUNT = 16
    const tvCamPositions: THREE.Vector3[] = []
    for (let i = 0; i < TV_CAM_COUNT; i++) {
      const ptIdx = Math.floor((i / TV_CAM_COUNT) * basePts.length)
      const prevIdx = Math.max(0, ptIdx - 1)
      const nextIdx = Math.min(basePts.length - 1, ptIdx + 1)
      const tan   = new THREE.Vector3().subVectors(basePts[nextIdx], basePts[prevIdx]).normalize()
      const right = new THREE.Vector3(-tan.z, 0, tan.x)
      const side  = i % 2 === 0 ? 1 : -1
      const dist  = (12 + (i % 3) * 4) * M   // 12–20 m — tight trackside
      const height = (12 + (i % 4) * 3) * M  // 12–21 m — high enough to see cars on track
      tvCamPositions.push(
        basePts[ptIdx].clone()
          .addScaledVector(right, side * dist)
          .setY(basePts[ptIdx].y + height)
      )
    }
    let tvCamIndex = 0
    let tvCamLastSwitch = -Infinity  // trigger immediate pick on first frame
    let tvCamInterval = 7000         // ms; randomised on each switch
    let tvFovCurrent = 38

    // Animation loop
    let lastMs: number | null = null
    let frame = 0
    const tMin = pLap.timestamps[0]
    const tMax = pLap.timestamps[pLap.timestamps.length - 1]

    const animate = (now: number) => {
      frameNow = now      // puffSmoke() runs outside this closure and needs the clock
      rafRef.current = requestAnimationFrame(animate)
      const dt = lastMs != null ? Math.min((now - lastMs) / 1000, 0.05) : 0
      lastMs = now
      frame++

      // Advance or sync time
      if (playingRef.current) {
        currentTimeRef.current += dt * speedRef.current
        if (currentTimeRef.current >= tMax) currentTimeRef.current = tMin
      } else {
        const ct = crosshairRef.current
        if (ct != null) currentTimeRef.current = ct
      }

      const t = currentTimeRef.current

      // Update car positions + orientation + HUD DOM (direct writes — no React state)
      // Each lap has its own absolute timestamp base — shift so all laps progress
      // from their own start simultaneously (handles cross-lap and cross-session replay)
      const lapT0 = pLap.timestamps[0]
      const idx0 = bsearchFloor(pLap.timestamps, t)
      const elapsed0 = pLap.timestamps[idx0] - lapT0

      laps.forEach((lap, li) => {
        const group = carGroups[li]
        if (!group || !lap.timestamps.length) return
        const lapT = t + (lap.timestamps[0] - lapT0)
        // Floor search → idx is always the sample BEFORE lapT, so frac is always in [0,1)
        const idx = bsearchFloor(lap.timestamps, lapT)

        // Linear interpolation between idx and idx+1 — fully smooth at any playback speed
        const nIdx1 = Math.min(idx + 1, lap.lat.length - 1)
        let lat: number, lon: number, alt: number
        if (nIdx1 > idx) {
          const t0 = lap.timestamps[idx], t1 = lap.timestamps[nIdx1]
          const frac = t1 > t0 ? (lapT - t0) / (t1 - t0) : 0
          lat = lap.lat[idx] + (lap.lat[nIdx1] - lap.lat[idx]) * frac
          lon = lap.lon[idx] + (lap.lon[nIdx1] - lap.lon[idx]) * frac
          alt = lap.alt[idx] + (lap.alt[nIdx1] - lap.alt[idx]) * frac
        } else {
          lat = lap.lat[idx]; lon = lap.lon[idx]; alt = lap.alt[idx]
        }
        const pos = toWorld(lat, lon, alt, tf)
        group.position.copy(pos)
        group.position.y += 0.8 * M  // just above road ribbon so car appears on its trace
        // Attitude: measured Yaw/Pitch/Roll where the session logged them, so the
        // car shows what it actually did — oversteer, kerb strikes, dive under
        // braking. Falls back to deriving heading and gradient from the path.
        if (yawOffsets[li] === undefined && lap.yaw.length) yawOffsets[li] = calibrateYaw(lap, tf)
        const yawOff = yawOffsets[li]
        if (yawOff != null && lap.yaw.length > idx) {
          group.rotation.y = lap.yaw[idx] + yawOff
        } else {
          const dIdx = Math.min(idx + 5, lap.lat.length - 1)
          if (dIdx > idx) {
            const nPos = toWorld(lap.lat[dIdx], lap.lon[dIdx], lap.alt[dIdx], tf)
            const dir = nPos.clone().sub(pos)
            if (dir.lengthSq() > 0.001) group.rotation.y = Math.atan2(dir.x, dir.z)
          }
        }
        if (lap.pitch.length > idx) {
          // Pitch is nose-down positive (correlates -0.99 with the uphill
          // gradient), and so is rotation.x — no sign flip needed
          group.rotation.x = lap.pitch[idx]
        } else {
          // No attitude channel: read the gradient off the path instead. Longer
          // baseline than the heading because raw GPS altitude is noisy.
          const pIdx = Math.min(idx + 20, lap.lat.length - 1)
          const qIdx = Math.max(idx - 20, 0)
          if (pIdx > qIdx) {
            const aPos = toWorld(lap.lat[qIdx], lap.lon[qIdx], lap.alt[qIdx], tf)
            const bPos = toWorld(lap.lat[pIdx], lap.lon[pIdx], lap.alt[pIdx], tf)
            const run = Math.hypot(bPos.x - aPos.x, bPos.z - aPos.z)
            if (run > 0.05) {
              const target = -Math.atan2(bPos.y - aPos.y, run)
              group.rotation.x += (target - group.rotation.x) * (1 - Math.pow(0.75, dt * 60))
            }
          }
        }
        // Roll is the car's attitude in the world, so it is dominated by track
        // banking rather than body roll — on the Karussell it reaches 14 deg,
        // far past any suspension travel, and there the car leans *into* the
        // corner. Measured over the steepest points of a Nordschleife lap, a
        // left-hander always gives a negative Roll, i.e. negative = left side
        // down. rotation.z positive lifts the left side (+x), so it goes in
        // as-is: negative Roll then drops the left side to match.
        if (lap.roll.length > idx) group.rotation.z = lap.roll[idx]

        // Wheels: each one rolls at its own measured speed, so a locked wheel
        // actually stops and a spinning one races ahead. True wheel speed
        // (v / r ~ 150 rad/s at 190 km/h) strobes badly at 60 fps, so it
        // saturates smoothly — correct when crawling, readable when quick.
        const wheels = carWheelsRef.current[li]
        if (wheels?.length) {
          const carV = Math.abs(lap.speed[idx] ?? 0)              // m/s
          const steer = Math.max(-0.55, Math.min(0.55, (lap.steering[idx] ?? 0) / 8))
          for (const w of wheels) {
            const ws = lap.wheelSpeed[w.corner]
            const v = ws.length > idx ? Math.abs(ws[idx]) : carV
            // Only advance while playing: dt keeps running when paused, which had
            // the wheels spinning under a stationary car
            if (playingRef.current) {
              const omega = 16 * Math.tanh(v / (0.34 * 16))       // rad/s, capped near 16
              w.mesh.rotation[w.axis] += omega * w.spinSign * dt
            }
            if (w.front) w.pivot.rotation.y = steer

            // Tyre temperature tints the wheel
            const temps = lap.tyreTemp[w.corner]
            if (temps.length > idx) w.mat.color.copy(tyreColor(temps[idx]))

            // Slip: wheel turning slower than the car = locking, faster = spinning.
            // Below walking pace the ratio is meaningless, so it's skipped.
            if (ws.length > idx && carV > 6) {
              const slip = (Math.abs(ws[idx]) - carV) / carV
              if (Math.abs(slip) > 0.15) puffSmoke(li, w, Math.min(1, (Math.abs(slip) - 0.15) / 0.5))
            }
          }
        }

        // Brake lights — 5% pedal, so trailing pressure doesn't make them flicker
        const lights = carLightsRef.current[li]
        if (lights) {
          const braking = (lap.brake[idx] ?? 0) > 0.05
          if (braking !== lights.braking) {
            lights.mat.color.setHex(braking ? BRAKE_ON : BRAKE_OFF)
            lights.braking = braking
          }
        }

        // Direct DOM HUD updates — bypasses React virtual DOM
        const speed  = Math.round(speedFromMps(lap.speed[idx] ?? 0, unitsRef.current))
        const gear   = Math.round(lap.gear[idx] ?? 1)
        const thr    = Math.round((lap.throttle[idx] ?? 0) * 100)
        const brk    = Math.round((lap.brake[idx] ?? 0) * 100)
        // iRacing SteeringWheelAngle: positive = turn left, so negate for CSS rotate
        const stDeg  = Math.round((lap.steering[idx] ?? 0) * 180 / Math.PI)
        const cssDeg = -stDeg

        const speedEl = hudSpeedRefs.current[li]; if (speedEl) speedEl.textContent = String(speed)
        const gearEl  = hudGearRefs.current[li];  if (gearEl)  gearEl.textContent  = String(gear)
        const thrEl   = hudThrRefs.current[li];   if (thrEl)   thrEl.style.height   = `${thr}%`
        const brkEl   = hudBrkRefs.current[li];   if (brkEl)   brkEl.style.height   = `${brk}%`
        const wheelEl = hudWheelRefs.current[li]; if (wheelEl) wheelEl.style.transform = `rotate(${cssDeg}deg)`
        const degEl   = hudDegRefs.current[li];
        if (degEl) degEl.textContent = `${Math.abs(stDeg)}°${stDeg > 1 ? 'L' : stDeg < -1 ? 'R' : ''}`
        const fuelEl  = hudFuelRefs.current[li]
        if (fuelEl && lap.fuel.length) fuelEl.textContent =
          `${fuelFromL(lap.fuel[Math.min(idx, lap.fuel.length - 1)] ?? 0, unitsRef.current).toFixed(1)} ${fuelUnit(unitsRef.current)}`

        // Positional delta (lap i vs lap 0)
        if (li > 0 && pLap.lat.length > 1) {
          const frac0 = idx0 / (pLap.lat.length - 1)
          const j = Math.min(Math.round(frac0 * (lap.lat.length - 1)), lap.lat.length - 1)
          const delta = (lap.timestamps[j] - lap.timestamps[0]) - elapsed0
          const deltaEl = hudDeltaRefs.current[li]
          if (deltaEl) {
            deltaEl.textContent = `${delta >= 0 ? '+' : ''}${delta.toFixed(3)}s`
            // Colour by sign — only a delta that actually reads 0.000 stays neutral
            deltaEl.style.color = delta >= 0.0005 ? '#fb7185'
              : delta <= -0.0005 ? '#34d399'
              : isDark ? 'rgba(255,255,255,0.45)' : 'rgba(15,23,42,0.50)'
          }
        }

        // Tyre card — only for the lap the camera follows, since the card shows one car
        if (li === followIdxRef.current) {
          for (const c of ['LF', 'RF', 'LR', 'RR'] as Corner[]) {
            const bands = tyreBandRefs.current[c]
            const temp = lap.tyreTemp[c]
            const wear = lap.tyreWear[c]
            // Bands are inner / middle / outer, each with its own surface
            // temperature — that spread is what reveals camber and pressure
            const tb = lap.tyreTempBands[c]
            const bandTemp = [tb.l, tb.m, tb.r]
            for (let bi = 0; bi < 3; bi++) {
              const el = bands[bi]
              if (!el) continue
              const src = bandTemp[bi].length > idx ? bandTemp[bi] : temp
              if (src.length > idx) el.style.background = '#' + tyreColor(src[idx]).getHexString()
            }
            const wl = wear.l.length > idx ? wear.l[idx] : null
            const wm = wear.m.length > idx ? wear.m[idx] : null
            const wr = wear.r.length > idx ? wear.r[idx] : null
            // Tread left shortens the band, so a worn edge is visible at a glance.
            // The channels are 0-1 ratios despite their '%' unit.
            const setH = (el: HTMLDivElement | null, ratio: number | null) => {
              if (!el) return
              el.style.height = `${Math.max(3, Math.min(15, (ratio ?? 1) * 15))}px`
            }
            setH(bands[0], wl); setH(bands[1], wm); setH(bands[2], wr)
            const el = tyreWearRefs.current[c]
            if (el) {
              const avg = [wl, wm, wr].filter((x): x is number => x != null)
              // One decimal: a stint often only moves a couple of percent
              el.textContent = avg.length
                ? `${(avg.reduce((a, b) => a + b, 0) / avg.length * 100).toFixed(1)}%` : '—'
            }
          }
          // ABS is measured; wheelspin is derived — see the driven-wheel slip below
          const absOn = (lap.absActive[idx] ?? 0) > 0.5
          const absEl = absLampRef.current
          if (absEl) {
            absEl.style.color = absOn ? '#ffffff' : (isDark ? 'rgba(255,255,255,0.30)' : 'rgba(15,23,42,0.30)')
            absEl.style.background = absOn ? '#e0a020' : 'transparent'
          }
          const rearSlip = (['LR', 'RR'] as Corner[]).some(c => {
            const ws = lap.wheelSpeed[c]
            const v = Math.abs(lap.speed[idx] ?? 0)
            return ws.length > idx && v > 6 && (Math.abs(ws[idx]) - v) / v > 0.06 && (lap.throttle[idx] ?? 0) > 0.15
          })
          const spinEl = spinLampRef.current
          if (spinEl) {
            spinEl.style.color = rearSlip ? '#ffffff' : (isDark ? 'rgba(255,255,255,0.30)' : 'rgba(15,23,42,0.30)')
            spinEl.style.background = rearSlip ? '#d8402c' : 'transparent'
          }
        }

        // Minimap dot
        const dot = mapDotRefs.current[li]
        if (dot && trackMapDataRef.current) {
          const [mx, my] = trackMapDataRef.current.toMapXY(lap.lat[idx], lap.lon[idx])
          dot.setAttribute('cx', mx.toFixed(1))
          dot.setAttribute('cy', my.toFixed(1))
        }

        // Telemetry trace — read straight out of the lap data for the window that
        // ends at the current position. It used to be a buffer that only grew
        // while playing, so scrubbing left the trace frozen even though the car
        // moved. Reading the samples means scrubbing (and going backwards) shows
        // the trace up to wherever you are.
        const canvas = hudTraceRefs.current[li]
        if (canvas) {
          const ctx = canvas.getContext('2d')
          if (ctx) {
            const W = canvas.width, H = canvas.height
            const last = Math.min(idx, lap.throttle.length - 1, lap.brake.length - 1)
            const from = Math.max(0, last - TRACE_SAMPLES + 1)
            const n = last - from + 1
            ctx.clearRect(0, 0, W, H)
            // Draw filled area + stroke for each channel. Samples are 0–1 ratios.
            const drawChannel = (src: number[], fillColor: string, strokeColor: string,
                                 flag?: (sampleIdx: number) => boolean, flagColor?: string) => {
              if (n < 2) return
              // Newest sample always anchored to right edge; trace grows left at lap start
              const xOf = (i: number) => ((TRACE_SAMPLES - n + i) / TRACE_SAMPLES) * W
              const yOf = (i: number) => {
                const v = Math.max(0, Math.min(1, src[from + i] ?? 0))
                return H - v * (H - 2) - 1
              }
              ctx.beginPath()
              ctx.moveTo(xOf(0), H)
              for (let i = 0; i < n; i++) ctx.lineTo(xOf(i), yOf(i))
              ctx.lineTo(xOf(n - 1), H)
              ctx.closePath()
              ctx.fillStyle = fillColor
              ctx.fill()
              // Stroke in runs so a flagged stretch can take its own colour —
              // that's how the ABS section shows up inside the brake trace
              let i = 0
              while (i < n - 1) {
                const flagged = flag?.(from + i) ?? false
                // j always ends up > i, so the loop advances even for a run of
                // one sample. `i = j - 1` did not: with a flag that flips every
                // sample — which is exactly how ABS behaves under braking — i
                // never moved and the frame loop hung the whole window.
                let j = i + 1
                while (j < n - 1 && (flag?.(from + j) ?? false) === flagged) j++
                ctx.beginPath()
                ctx.strokeStyle = flagged ? (flagColor ?? strokeColor) : strokeColor
                ctx.lineWidth = flagged ? 2 : 1.5
                ctx.lineJoin = 'round'
                ctx.moveTo(xOf(i), yOf(i))
                for (let k = i + 1; k <= j; k++) ctx.lineTo(xOf(k), yOf(k))
                ctx.stroke()
                i = j
              }
            }
            // Brake trace turns amber wherever the ABS was cutting in
            const absArr = lap.absActive
            drawChannel(lap.brake, 'rgba(239,68,68,0.28)', '#ef4444',
              absArr.length ? (k: number) => (absArr[k] ?? 0) > 0.5 : undefined, '#f5a524')
            drawChannel(lap.throttle, 'rgba(34,197,94,0.28)', '#22c55e')
          }
        }
      })

      // Slider update at low frequency only
      if (frame % 9 === 0) setCurrentT(t)

      // Camera — three modes, all frame-rate-independent
      // Camera follows whichever lap is selected in the HUD strip, first by default
      const car0 = carGroups[followIdxRef.current] ?? carGroups[0]
      if (car0) {
        const ry  = car0.rotation.y
        const sy  = Math.sin(ry), cy2 = Math.cos(ry)
        // forward = (sy, 0, cy2), right = (cy2, 0, -sy)
        const posAlpha  = 1 - Math.pow(0.90, dt * 60)
        const lookAlpha = 1 - Math.pow(0.88, dt * 60)
        const carY = car0.position.y

        // Wheel zoom: the follow cams change distance, the fixed ones change FOV
        const zoom = zoomRef.current
        // zoom > 1 means "further out", so FOV widens with it
        const wantFov = cameraModeRef.current === 'cockpit'
          ? Math.max(30, Math.min(100, 65 * zoom))
          : 65
        if (cameraModeRef.current !== 'tv' && camera.fov !== wantFov) {
          camera.fov = wantFov
          camera.updateProjectionMatrix()
        }
        if (cameraModeRef.current === 'chase') {
          const behind = new THREE.Vector3(car0.position.x - sy * CAM_BACK * zoom, carY + CAM_UP * zoom, car0.position.z - cy2 * CAM_BACK * zoom)
          cameraPosRef.current.lerp(behind, posAlpha)
          const ahead = new THREE.Vector3(car0.position.x + sy * 16 * M, carY + 2 * M, car0.position.z + cy2 * 16 * M)
          cameraTargetRef.current.lerp(ahead, lookAlpha)
        } else if (cameraModeRef.current === 'cockpit') {
          // Bonnet cam — sits just over the nose, snappier follow than the chase
          // cam so the car's rotation reads as the world turning around you
          const cockAlpha = 1 - Math.pow(0.55, dt * 60)
          const eye = new THREE.Vector3(car0.position.x + sy * 2.6 * M, carY + 2.0 * M, car0.position.z + cy2 * 2.6 * M)
          cameraPosRef.current.lerp(eye, cockAlpha)
          const ahead = new THREE.Vector3(car0.position.x + sy * 70 * M, carY + 2.6 * M, car0.position.z + cy2 * 70 * M)
          cameraTargetRef.current.lerp(ahead, cockAlpha)
        } else if (cameraModeRef.current === 'front') {
          // Camera in front of car, looking back
          const front = new THREE.Vector3(car0.position.x + sy * CAM_BACK * zoom, carY + 4.2 * M * zoom, car0.position.z + cy2 * CAM_BACK * zoom)
          cameraPosRef.current.lerp(front, posAlpha)
          const carCenter = new THREE.Vector3(car0.position.x, carY + 1.4 * M, car0.position.z)
          cameraTargetRef.current.lerp(carCenter, lookAlpha)
        } else if (cameraModeRef.current === 'tv') {
          const n = tvCamPositions.length
          if (n > 0) {
            const distToCamera = tvCamPositions[tvCamIndex].distanceTo(car0.position)
            // Distance-based target FOV: keeps car at a consistent apparent size.
            // 250/D gives ~45° at D=5.5 (close), ~25° at D=10, ~15° at D=16.
            const targetFov = Math.max(10, Math.min(75, 250 / distToCamera * zoom))

            // Switch: pick the camera nearest to the car's current position
            if (now - tvCamLastSwitch >= tvCamInterval) {
              let bestIdx = 0, bestDist = Infinity
              for (let ci = 0; ci < n; ci++) {
                if (ci === tvCamIndex) continue
                const d = tvCamPositions[ci].distanceTo(car0.position)
                if (d < bestDist) { bestDist = d; bestIdx = ci }
              }
              tvCamIndex = bestIdx
              tvCamLastSwitch = now
              tvCamInterval = 5000 + Math.random() * 4000
              cameraPosRef.current.copy(tvCamPositions[tvCamIndex])
              // Burst: start 8° narrower than target for dramatic punch-in on cut
              tvFovCurrent = Math.max(12, targetFov - 8)
            }
            // Fixed vantage point — pan look-at to car
            cameraPosRef.current.copy(tvCamPositions[tvCamIndex])
            cameraTargetRef.current.lerp(
              new THREE.Vector3(car0.position.x, carY + 1.2 * M, car0.position.z),
              1 - Math.pow(0.90, dt * 60)
            )
            // Smooth drift to distance-based FOV — car stays visible at any range
            tvFovCurrent += (targetFov - tvFovCurrent) * (1 - Math.pow(0.992, dt * 60))
            camera.fov = tvFovCurrent
            camera.updateProjectionMatrix()
          }
        }

        camera.position.copy(cameraPosRef.current)
        camera.lookAt(cameraTargetRef.current)
      }

      // Tyre smoke: rise, swell, fade, then go back in the pool
      for (const p of puffs) {
        if (!p.mesh.visible) continue
        p.life += dt
        const k = p.life / p.max
        if (k >= 1) { p.mesh.visible = false; continue }
        p.mesh.position.y += p.vy * dt
        p.mesh.scale.setScalar(p.size * (1 + k * 1.8))
        p.mat.opacity = (1 - k) * (1 - k) * 0.55
        p.mesh.quaternion.copy(camera.quaternion)        // billboard
      }

      // Drift clouds slowly in wind direction; wrap at terrain boundary
      for (const cd of cloudGroupsRef.current) {
        cd.group.position.x += cd.vx * dt
        cd.group.position.z += cd.vz * dt
        if (cd.group.position.x >  1050) cd.group.position.x -= 2100
        if (cd.group.position.x < -1050) cd.group.position.x += 2100
        if (cd.group.position.z >  1050) cd.group.position.z -= 2100
        if (cd.group.position.z < -1050) cd.group.position.z += 2100
      }

      // Rain — drops live in a box that follows the camera, so a handful of
      // thousand streaks are enough to fill the view at any speed
      const rn = rainRef.current
      if (rn) {
        const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z
        const { local: L, world: W, box: B, height: H } = rn
        const halfB = B / 2, halfH = H / 2
        const fall = rn.fall * dt, wx = rn.dx * dt, wz = rn.dz * dt
        for (let i = 0; i < rn.count; i++) {
          const li = i * 3
          L[li]     += wx
          L[li + 1] -= fall
          L[li + 2] += wz
          if (L[li + 1] < -halfH) {
            L[li]     = (Math.random() - 0.5) * B
            L[li + 1] = halfH
            L[li + 2] = (Math.random() - 0.5) * B
          }
          if (L[li]     >  halfB) L[li]     -= B; else if (L[li]     < -halfB) L[li]     += B
          if (L[li + 2] >  halfB) L[li + 2] -= B; else if (L[li + 2] < -halfB) L[li + 2] += B
          const x = cx + L[li], y = cy + L[li + 1], z = cz + L[li + 2]
          const wi = i * 6
          W[wi]     = x;                     W[wi + 1] = y;              W[wi + 2] = z
          W[wi + 3] = x + rn.dx * 0.10;      W[wi + 4] = y - rn.streak;  W[wi + 5] = z + rn.dz * 0.10
        }
        rn.mesh.geometry.attributes.position.needsUpdate = true
      }

      renderer.render(scene, camera)
    }
    rafRef.current = requestAnimationFrame(animate)
    // Scene is ready — let the weather effect populate clouds / rain / fog
    setSceneEpoch(e => e + 1)

    return () => {
      loadCancelled = true
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
      sceneRef.current = null
      sunRef.current = null
      ambientRef.current = null
      roadMatRef.current = null
      rainRef.current = null
      cloudGroupsRef.current = []
      carWheelsRef.current = []
      carLightsRef.current = []
      scene.traverse(obj => {
        const mesh = obj as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const mat = mesh.material
        if (Array.isArray(mat)) mat.forEach(m => m.dispose())
        else if (mat) (mat as THREE.Material).dispose()
      })
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
    }
  }, [laps, tf, openWheelCar, isDark])

  // ── Weather visuals ────────────────────────────────────────────────────────
  // Cloud cover follows Skies, rain follows Precipitation, visibility follows
  // FogLevel. Kept separate from the scene build so conditions arriving late
  // don't trigger a full (expensive) terrain rebuild.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const c = conditions

    const overcast = c?.skies  != null ? c.skies / 3 : 0.30          // 0 clear … 1 overcast
    const rain     = c?.precip != null ? Math.min(1, c.precip / 25) : 0
    const fogAmt   = Math.max(c?.fog != null ? Math.min(1, c.fog / 40) : 0, rain * 0.35, overcast * 0.12)
    const wet      = Math.max(c?.wetness && c.wetness > 1 ? (c.wetness - 1) / 6 : 0, rain)
    const windRad  = c?.windDir ?? 0.9
    const windSpd  = c?.windVel ?? 3

    // ── Sky, light and fog tint ──────────────────────────────────────────────
    const sky = new THREE.Color(isDark ? SKY_DARK : SKY_LIGHT)
      .lerp(new THREE.Color(isDark ? 0x232631 : 0x9aa3ad), overcast * 0.85)
      .lerp(new THREE.Color(isDark ? 0x15171d : 0x6d747d), rain * 0.60)
    ;(scene.background as THREE.Color).copy(sky)
    const fog = scene.fog as THREE.Fog
    fog.color.copy(sky)
    fog.near = 300 - 265 * fogAmt
    fog.far  = 1200 - 960 * fogAmt

    if (sunRef.current)     sunRef.current.intensity     = (isDark ? 2.2 : 3.0) * (1 - 0.55 * overcast - 0.25 * rain)
    if (ambientRef.current) ambientRef.current.intensity = (isDark ? 0.55 : 1.1) * (1 - 0.15 * overcast + 0.10 * rain)
    // Wet asphalt reads darker than dry
    if (roadMatRef.current) roadMatRef.current.color.set(isDark ? 0x26262c : 0x383840).multiplyScalar(1 - 0.35 * wet)

    const group = new THREE.Group()
    scene.add(group)

    // ── Clouds ───────────────────────────────────────────────────────────────
    // MeshBasicMaterial = unlit → brightness is driven purely by the sky tint
    const cloudGeo = new THREE.SphereGeometry(1, 10, 6)
    const cloudMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(isDark ? 0x8f97ad : 0xf0f4ff)
        .lerp(new THREE.Color(isDark ? 0x4a4f5e : 0x8b93a3), overcast * 0.75)
        .lerp(new THREE.Color(isDark ? 0x30333d : 0x545a64), rain * 0.70),
      transparent: true,
      opacity: 0.55 + 0.35 * overcast,
    })
    const cloudR = (s: number) => { const x = Math.sin(s * 91.3 + 3.7) * 5471.2; return x - Math.floor(x) }
    const cloudCount = Math.round(6 + overcast * 30 + rain * 8)
    cloudGroupsRef.current = []
    for (let i = 0; i < cloudCount; i++) {
      const angle = cloudR(i) * Math.PI * 2
      // Overcast pulls the deck lower and closer, so it also covers the sky overhead
      const distMin = 450 - 320 * overcast
      const dist    = distMin + cloudR(i + 10) * (800 - distMin)
      const cloudY  = (175 - 55 * overcast) + cloudR(i + 20) * (110 - 30 * overcast)
      const mainR   = (28 + 16 * overcast) + cloudR(i + 40) * 36
      const cg = new THREE.Group()
      cg.position.set(Math.sin(angle) * dist, 0, Math.cos(angle) * dist)

      const body = new THREE.Mesh(cloudGeo, cloudMat)
      body.position.y = cloudY
      body.scale.set(mainR * 1.5, mainR * 0.22, mainR)
      cg.add(body)

      const numPuffs = 3 + Math.floor(cloudR(i + 30) * 3)
      for (let b = 0; b < numPuffs; b++) {
        const pr = mainR * (0.30 + cloudR(i * 7 + b + 2) * 0.22)
        const puff = new THREE.Mesh(cloudGeo, cloudMat)
        puff.position.set((cloudR(i * 7 + b) - 0.5) * mainR * 1.7,
                          cloudY + mainR * 0.16,
                          (cloudR(i * 7 + b + 1) - 0.5) * mainR * 0.6)
        puff.scale.set(pr * 1.1, pr * 0.48, pr)
        cg.add(puff)
      }

      group.add(cg)
      // Drift along the session's wind direction, speed scaled by wind velocity
      const spd = (1.5 + windSpd * 0.55) * (0.75 + cloudR(i + 60) * 0.5)
      cloudGroupsRef.current.push({
        group: cg,
        vx: Math.sin(windRad) * spd,
        vz: Math.cos(windRad) * spd,
      })
    }

    // ── Rain ─────────────────────────────────────────────────────────────────
    if (rain > 0.01) {
      const count  = Math.round(350 + rain * 1800)
      const rm = tf?.unitsPerMetre ?? 0.2
      const box    = 60 * rm, height = 45 * rm   // metres around the camera
      const streak = (0.4 + 0.7 * rain) * rm
      const local  = new Float32Array(count * 3)
      const world  = new Float32Array(count * 6)
      for (let i = 0; i < count; i++) {
        local[i * 3]     = (Math.random() - 0.5) * box
        local[i * 3 + 1] = (Math.random() - 0.5) * height
        local[i * 3 + 2] = (Math.random() - 0.5) * box
      }
      const geo = new THREE.BufferGeometry()
      const attr = new THREE.BufferAttribute(world, 3)
      attr.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('position', attr)
      const mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        color: isDark ? 0x8fa4c0 : 0xe4edf8,
        transparent: true,
        opacity: 0.14 + 0.16 * rain,
        depthWrite: false,
      }))
      mesh.frustumCulled = false     // box follows the camera, bounds are meaningless
      group.add(mesh)
      rainRef.current = {
        mesh, local, world, count, streak, box, height,
        fall: (22 + 15 * rain) * rm,
        dx: Math.sin(windRad) * windSpd * 0.8 * rm,
        dz: Math.cos(windRad) * windSpd * 0.8 * rm,
      }
    } else {
      rainRef.current = null
    }

    return () => {
      rainRef.current = null
      cloudGroupsRef.current = []
      scene.remove(group)
      group.traverse(obj => {
        const m = obj as THREE.Mesh
        if (m.geometry) m.geometry.dispose()
        const mat = m.material
        if (Array.isArray(mat)) mat.forEach(x => x.dispose())
        else if (mat) (mat as THREE.Material).dispose()
      })
    }
  }, [sceneEpoch, conditions, isDark])

  // ── HUD proportional scaling — shrinks pills when container is narrow ───────
  // Depends on `loading` as well: the loading branch unmounts the canvas container,
  // so the observer has to re-attach to the fresh element afterwards instead of
  // keeping watch on the detached one.
  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    const update = () => {
      const w = el.clientWidth
      // 0 = detached or not laid out yet — scaling to 0 would hide the HUD entirely
      if (w === 0) return
      const n = Math.max(1, laps.length)
      // natural pill width 320px; N pills + (N-1) gaps of 8px between them
      const naturalW = n * 320 + (n - 1) * 8
      setHudScale(Math.min(1, w / naturalW))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [laps.length, loading])

  // ── Mouse wheel zoom ───────────────────────────────────────────────────────
  // Re-attaches after the loading branch remounts the canvas, same as the HUD scaler
  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()   // don't scroll the panel behind the viewer
      const next = zoomRef.current * Math.exp(e.deltaY * 0.0012)
      zoomRef.current = Math.min(3, Math.max(0.35, next))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [laps.length, loading])

  // ── Playback controls ──────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    setPlaying(p => {
      if (p) {
        // Pausing: immediately lock crosshair to current playback position
        // so the animate loop doesn't snap back to a stale crosshairTime
        const t = currentTimeRef.current
        crosshairRef.current = t
        setCrosshairTime(t)
        setCurrentT(t)
      }
      return !p
    })
  }, [setCrosshairTime])

  // Space bar toggles playback while the 3D view is open — ignored while typing,
  // and preventDefault stops it from scrolling or re-triggering a focused button
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      togglePlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay])

  const pLap = laps[0]
  const tMin = pLap?.timestamps[0] ?? 0
  const tMax = pLap?.timestamps[pLap.timestamps.length - 1] ?? 1
  const lapDuration = tMax - tMin || 1
  const sliderVal = Math.round(((currentT - tMin) / lapDuration) * 1000)
  const sliderPct = sliderVal / 10  // 0–100, for CSS width/left

  const formatTime = (t: number) => {
    const s = Math.max(0, t - tMin)
    const m = Math.floor(s / 60)
    const sec = (s % 60).toFixed(1)
    return `${m}:${sec.padStart(4, '0')}`
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-background">
        <LoadingIndicator label={t('loading3d')} hint={t('loadingBig')} />
      </div>
    )
  }

  if (laps.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-background px-4 text-center">
        <p className="text-xs text-muted-foreground">{t('need3dGps')}</p>
      </div>
    )
  }

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">

      {/* Three.js canvas area — bg prevents flash before canvas mounts */}
      <div ref={mountRef} className="flex-1 min-h-0 relative overflow-hidden" style={{ backgroundColor: isDark ? '#1a1e2a' : '#9ec8e8' }}>

        {/* Camera mode buttons — top-right */}
        <div className="absolute top-2 right-2 flex gap-1 select-none">
          {(['chase', 'cockpit', 'front', 'tv'] as const).map(mode => (
            <button key={mode} onClick={() => setCameraMode(mode)}
              className={`text-[8px] font-bold rounded px-1.5 py-0.5 transition-colors ${
                cameraMode === mode
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-black/45 text-white/55 hover:text-white hover:bg-black/65'
              }`}>
              {mode === 'chase' ? 'REAR' : mode === 'cockpit' ? 'HOOD' : mode === 'front' ? 'FRONT' : 'TV'}
            </button>
          ))}
        </div>

        {/* Right-hand HUD column: the cards stack, so the tyre card follows the
            weather card's height instead of guessing an offset from the top */}
        <div className="absolute top-9 right-2 flex flex-col gap-1.5 items-end">

        {/* Tyres — temperature per band, tread left, and the driver aids.
            Shows the lap the camera follows; values are written straight to the
            DOM each frame like the rest of the HUD. */}
        {laps.length > 0 && (() => {
          const bg     = isDark ? 'rgba(14,16,22,0.62)'    : 'rgba(255,255,255,0.62)'
          const border = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.09)'
          const txt    = isDark ? 'rgba(255,255,255,0.92)' : 'rgba(15,23,42,0.92)'
          const dim    = isDark ? 'rgba(255,255,255,0.42)' : 'rgba(15,23,42,0.45)'
          const tyre = (corner: Corner) => (
            <div className="flex flex-col items-center gap-0.5">
              <div className="text-[7px] font-bold tracking-widest" style={{ color: dim }}>{corner}</div>
              {/* three bands: inner, middle, outer */}
              <div className="flex gap-[2px]">
                {[0, 1, 2].map(b => (
                  <div key={b}
                    ref={el => { tyreBandRefs.current[corner][b] = el }}
                    style={{ width: 6, height: 15, borderRadius: 2, background: '#141414' }} />
                ))}
              </div>
              <span ref={el => { tyreWearRefs.current[corner] = el }}
                className="text-[8px] font-semibold tabular-nums" style={{ color: txt }}>—</span>
            </div>
          )
          return (
            <div className="pointer-events-none select-none rounded-xl overflow-hidden"
              style={{
                order: 2, width: CARD_W,
                background: bg,
                backdropFilter: 'blur(14px) saturate(1.3)',
                WebkitBackdropFilter: 'blur(14px) saturate(1.3)',
                border: `1px solid ${border}`,
                boxShadow: isDark ? '0 6px 20px rgba(0,0,0,0.40)' : '0 6px 18px rgba(15,23,42,0.13)',
              }}>
              <button
                onClick={() => setTyresOpen(o => !o)}
                className="pointer-events-auto w-full flex items-center gap-1 px-2 py-1.5 cursor-pointer">
                <span className="text-[9px] font-bold tracking-wide" style={{ color: txt }}>{t('tyres')}</span>
                <span ref={absLampRef}
                  className="ml-auto text-[7px] font-bold tracking-widest px-1 rounded"
                  style={{ color: dim, background: 'transparent' }}>ABS</span>
                <span ref={spinLampRef}
                  className="text-[7px] font-bold tracking-widest px-1 rounded"
                  style={{ color: dim, background: 'transparent' }}>SPIN</span>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={dim} strokeWidth="3"
                  strokeLinecap="round" strokeLinejoin="round" className="shrink-0"
                  style={{ transform: tyresOpen ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 150ms' }}>
                  <path d="M5 15l7-7 7 7" />
                </svg>
              </button>
              {tyresOpen && (
                <div className="grid grid-cols-2 gap-y-1.5 px-2 pb-2 justify-items-center">
                  {tyre('LF')}{tyre('RF')}{tyre('LR')}{tyre('RR')}
                </div>
              )}
            </div>
          )
        })()}

        {/* Track & weather conditions — glass card, top-right below the camera buttons */}
        {conditions && (() => {
          const c = conditions
          const rain = c.precip ?? 0
          const sky  = c.skies != null ? (SKIES_KEYS[c.skies] ? t(SKIES_KEYS[c.skies]) : null) : c.weatherType
          const kind: 'sun' | 'partly' | 'cloud' | 'rain' =
            rain > 1 ? 'rain' : c.skies == null ? 'partly' : c.skies === 0 ? 'sun' : c.skies === 1 ? 'partly' : 'cloud'

          // Secondary readouts — only what the session actually reports
          const rows: [string, string][] = []
          if (c.humidity != null) rows.push([t('wHumidity'), `${Math.round(c.humidity)}%`])
          if (c.windVel  != null) {
            const dir = c.windDir != null
              ? ` ${COMPASS[Math.round((c.windDir % (Math.PI * 2)) / (Math.PI * 2) * 8) % 8]}`
              : ''
            rows.push([t('wWind'), `${speedFromKph(c.windVel * 3.6, units).toFixed(1)} ${speedUnit(units)}${dir}`])
          }
          if (c.precip != null) rows.push([t('wRain'), `${Math.round(c.precip)}%`])
          if (c.fog) rows.push([t('wFog'), `${Math.round(c.fog)}%`])
          if (c.wetness) rows.push([t('wSurface'), t(WETNESS_KEYS[c.wetness] ?? 'wetDry')])
          if (c.rubber) rows.push([t('wRubber'), c.rubber.replace(/ usage$/, '')])
          if (c.timeOfDay) rows.push([t('wTime'), c.timeOfDay])
          if (!rows.length && c.trackTemp == null && !sky) return null

          const bg     = isDark ? 'rgba(14,16,22,0.62)'     : 'rgba(255,255,255,0.62)'
          const border = isDark ? 'rgba(255,255,255,0.10)'  : 'rgba(15,23,42,0.09)'
          const line   = isDark ? 'rgba(255,255,255,0.08)'  : 'rgba(15,23,42,0.07)'
          const txt    = isDark ? 'rgba(255,255,255,0.92)'  : 'rgba(15,23,42,0.92)'
          const dim    = isDark ? 'rgba(255,255,255,0.42)'  : 'rgba(15,23,42,0.45)'
          const accent = kind === 'rain' ? (isDark ? '#7dd3fc' : '#0ea5e9')
                       : kind === 'cloud' ? (isDark ? '#a1adc0' : '#64748b')
                       : (isDark ? '#fcd34d' : '#f59e0b')

          const temp = (label: string, v: number | null) => v == null ? null : (
            <div className="flex-1">
              <div className="text-[7px] font-bold tracking-[0.12em] uppercase leading-none mb-0.5" style={{ color: dim }}>{label} {tempUnit(units)}</div>
              <div className="text-[13px] font-black tabular-nums leading-none" style={{ color: txt }}>{tempFromC(v, units).toFixed(1)}°</div>
            </div>
          )

          return (
            <div className="pointer-events-none select-none rounded-xl overflow-hidden"
              style={{
                order: 1, width: weatherOpen ? CARD_W : 'auto',
                background: bg,
                backdropFilter: 'blur(14px) saturate(1.3)',
                WebkitBackdropFilter: 'blur(14px) saturate(1.3)',
                border: `1px solid ${border}`,
                boxShadow: isDark ? '0 6px 20px rgba(0,0,0,0.40)' : '0 6px 18px rgba(15,23,42,0.13)',
              }}>

              {/* Header doubles as the collapse toggle — collapsed it keeps just the
                  glyph and the sky, so the sky stays visible without the full card */}
              <button
                onClick={() => setWeatherOpen(o => !o)}
                title={`${weatherOpen ? t('collapse') : t('expand')} — ${t('conditions')}`}
                className="pointer-events-auto w-full flex items-center gap-1.5 px-2 py-1.5 cursor-pointer">
                <WeatherIcon kind={kind} color={accent} />
                <span className="text-[9px] font-bold tracking-wide truncate" style={{ color: txt }}>
                  {sky ?? t('conditions')}
                </span>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={dim} strokeWidth="3"
                  strokeLinecap="round" strokeLinejoin="round" className="ml-auto shrink-0"
                  style={{ transform: weatherOpen ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 150ms' }}>
                  <path d="M5 15l7-7 7 7" />
                </svg>
              </button>

              {weatherOpen && (<>
                {/* Temperatures — the two numbers that matter most, side by side */}
                {(c.trackTemp != null || c.airTemp != null) && (
                  <div className="flex gap-2 px-2 pb-1.5">
                    {temp(t('track'), c.trackTemp)}
                    {temp(t('wAir'), c.airTemp)}
                  </div>
                )}

                {rows.length > 0 && (
                  <>
                    <div style={{ height: 1, background: line }} />
                    <div className="grid gap-x-2 gap-y-0.5 px-2 py-1.5" style={{ gridTemplateColumns: 'auto auto' }}>
                      {rows.map(([label, value]) => (
                        <div key={label} className="contents">
                          <span className="text-[7px] font-bold tracking-[0.10em] uppercase self-center" style={{ color: dim }}>{label}</span>
                          <span className="text-[9px] font-semibold tabular-nums text-right whitespace-nowrap self-center" style={{ color: txt }}>{value}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>)}
            </div>
          )
        })()}

        </div>

        {/* Track minimap — top-left, bare SVG on canvas */}
        {trackMapData && (
          <div className="absolute top-2 left-2 pointer-events-none select-none">
            <svg width="120" height="120" viewBox="0 0 100 100">
              <path d={trackMapData.d}
                fill={isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'}
                stroke={isDark ? 'rgba(255,255,255,0.40)' : 'rgba(0,0,0,0.50)'}
                strokeWidth="1.6" strokeLinejoin="round" />
              <circle cx={trackMapData.startXY[0]} cy={trackMapData.startXY[1]} r="2.5"
                fill={isDark ? 'white' : '#334155'} opacity="0.55" />
              {laps.map((lap, li) => {
                if (lap.lat.length === 0) return null
                const [ix, iy] = trackMapData.toMapXY(lap.lat[0], lap.lon[0])
                return (
                  <circle key={lap.lapKey}
                    ref={el => { mapDotRefs.current[li] = el }}
                    cx={ix} cy={iy} r="4.5"
                    fill={getLapColor(lap.colorIndex)}
                    stroke={isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.3)'}
                    strokeWidth="1.2" />
                )
              })}
            </svg>
          </div>
        )}

        {/* HUD panels — natural-width pills centered via translateX, scaled to fit */}
        {laps.length > 0 && (
          <div className="absolute bottom-2 flex flex-row gap-2 pointer-events-none select-none"
            style={{
              left: '50%',
              transform: `translateX(-50%) scale(${hudScale})`,
              transformOrigin: 'bottom center',
            }}>
            {laps.map((lap, li) => {
              const lapColor = getLapColor(lap.colorIndex)
              const lapTime = lapTimes[li]
              const fmtLapTime = lapTime != null
                ? `${Math.floor(lapTime / 60)}:${(lapTime % 60).toFixed(3).padStart(6, '0')}`
                : null
              // Theme-aware color tokens
              const pillBg   = isDark ? 'rgba(10,10,12,0.90)'   : 'rgba(255,255,255,0.93)'
              const textMain = isDark ? 'rgba(255,255,255,1)'    : 'rgba(15,23,42,0.95)'
              const textDim  = isDark ? 'rgba(255,255,255,0.30)' : 'rgba(15,23,42,0.40)'
              const divCol   = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)'
              const canvasBg = isDark ? 'rgba(0,0,0,0.40)'       : 'rgba(0,0,0,0.04)'
              const stripBg  = isDark ? 'rgba(0,0,0,0.58)'       : 'rgba(255,255,255,0.84)'
              const stripTxt = isDark ? 'rgba(255,255,255,0.82)' : 'rgba(15,23,42,0.85)'
              const stripSub = isDark ? 'rgba(255,255,255,0.52)' : 'rgba(15,23,42,0.60)'
              return (
                <div key={lap.lapKey} className="flex flex-col gap-0.5" style={{ width: 320 }}>

                  {/* Lap info strip — also picks which car the camera follows */}
                  <div
                    onClick={() => setFollowIdx(li)}
                    title={followIdx === li ? t('cameraFollows') : t('cameraFollow')}
                    className={`relative flex items-center gap-1.5 px-2 py-0.5 rounded-lg pointer-events-auto ${
                      followIdx === li ? '' : 'cursor-pointer'
                    }`}
                    style={{
                      background: stripBg,
                      backdropFilter: 'blur(6px)',
                      // The followed lap is outlined in its own colour
                      boxShadow: followIdx === li ? `inset 0 0 0 1.5px ${lapColor}` : 'none',
                    }}>
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: lapColor }} />
                    <span className="text-[9px] font-bold tracking-wider uppercase" style={{ color: stripTxt }}>L{lap.lapNumber}</span>
                    {followIdx === li && (
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={lapColor} strokeWidth="2.4"
                        strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                        <path d="M2 7.5h11v9H2z" />
                        <path d="M13 11l8-4v10l-8-4z" />
                      </svg>
                    )}
                    {fmtLapTime && (
                      <span className="text-[9px] font-mono tabular-nums" style={{ color: stripSub }}>{fmtLapTime}</span>
                    )}
                    {/* Fuel — live tank level plus this lap's consumption, centred in the strip */}
                    {lap.fuel.length > 0 && (() => {
                      const used = lap.fuel[0] - lap.fuel[lap.fuel.length - 1]
                      return (
                        <span className="absolute left-1/2 -translate-x-1/2 flex items-baseline gap-1 whitespace-nowrap">
                          <span className="text-[8px] font-semibold tracking-wider uppercase" style={{ color: stripSub }}>{t('fuel')}</span>
                          <span ref={el => { hudFuelRefs.current[li] = el }}
                            className="text-[9px] font-bold tabular-nums" style={{ color: stripTxt }}>
                            {fuelFromL(lap.fuel[0], units).toFixed(1)} {fuelUnit(units)}
                          </span>
                          {used > 0.01 && (
                            <span className="text-[9px] tabular-nums" style={{ color: stripSub }}>−{fuelFromL(used, units).toFixed(2)}/lap</span>
                          )}
                        </span>
                      )
                    })()}
                    {li > 0 && (
                      <span ref={el => { hudDeltaRefs.current[li] = el }}
                        className="text-[10px] font-bold tabular-nums whitespace-nowrap ml-auto"
                        style={{ color: stripTxt }}>—</span>
                    )}
                  </div>

                  {/* Main pill */}
                  <div className="flex items-stretch rounded-xl overflow-hidden"
                    style={{ background: pillBg, borderTop: `2px solid ${lapColor}`, boxShadow: isDark ? 'none' : '0 2px 12px rgba(0,0,0,0.10)' }}>

                    {/* Left accent stripe */}
                    <div className="w-1 shrink-0" style={{ background: lapColor }} />

                    {/* Telemetry trace canvas */}
                    <div className="flex items-stretch shrink-0">
                      <span className="flex items-center justify-center font-bold tracking-widest uppercase px-0.5"
                        style={{ fontSize: 6, writingMode: 'vertical-rl', transform: 'rotate(180deg)', color: textDim }}>
                        {t('telemetry')}
                      </span>
                      <canvas ref={el => { hudTraceRefs.current[li] = el }}
                        width={120} height={68}
                        style={{ display: 'block', width: 120, height: 68, background: canvasBg }} />
                    </div>

                    {/* BRK + THR vertical bars — current-value bars, grow from bottom */}
                    <div className="flex gap-1 self-stretch shrink-0" style={{ padding: '10px 8px' }}>
                      <div style={{ width: 8, position: 'relative', background: isDark ? 'rgba(239,68,68,0.18)' : 'rgba(239,68,68,0.14)', borderRadius: 3, overflow: 'hidden' }}>
                        <div ref={el => { hudBrkRefs.current[li] = el }}
                          style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '0%', background: '#ef4444', borderRadius: 3 }} />
                      </div>
                      <div style={{ width: 8, position: 'relative', background: isDark ? 'rgba(34,197,94,0.18)' : 'rgba(34,197,94,0.14)', borderRadius: 3, overflow: 'hidden' }}>
                        <div ref={el => { hudThrRefs.current[li] = el }}
                          style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '0%', background: '#22c55e', borderRadius: 3 }} />
                      </div>
                    </div>

                    <div className="w-px self-stretch my-2 shrink-0" style={{ background: divCol }} />

                    {/* Gear (top) → kph label → Speed (bottom), fixed width so digit count doesn't shift layout */}
                    <div className="flex flex-col items-center justify-center shrink-0" style={{ width: 62, gap: 1 }}>
                      <span ref={el => { hudGearRefs.current[li] = el }}
                        className="font-black tabular-nums leading-none"
                        style={{ fontSize: 32, color: textMain, letterSpacing: '-0.02em' }}>1</span>
                      <span className="font-semibold tracking-widest uppercase leading-none"
                        style={{ fontSize: 8, color: textDim }}>{speedUnit(units)}</span>
                      <span ref={el => { hudSpeedRefs.current[li] = el }}
                        className="font-bold tabular-nums leading-none"
                        style={{ fontSize: 16, color: textMain }}>0</span>
                    </div>

                    <div className="w-px self-stretch my-2 shrink-0" style={{ background: divCol }} />

                    {/* Steering wheel — fills remaining space, wheel centered, angle pinned to bottom */}
                    <div className="flex-1 flex flex-col items-center px-1" style={{ minWidth: 48 }}>
                      <div className="flex-1 flex items-center justify-center">
                        <img
                          ref={el => { hudWheelRefs.current[li] = el }}
                          src="/moza-gs-v2p-steering-wheel-pc.webp"
                          alt="wheel" width={46} height={46}
                          className="object-contain" style={{ display: 'block' }}
                          draggable={false}
                        />
                      </div>
                      <span ref={el => { hudDegRefs.current[li] = el }}
                        className="tabular-nums leading-none"
                        style={{ fontSize: 9, color: textDim, paddingBottom: 4 }}>0°</span>
                    </div>

                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Playback controls bar — adapts to light/dark */}
      <div className="shrink-0 bg-neutral-900 dark:bg-neutral-900 border-t select-none border-white/8 dark:border-white/8" style={isDark ? {} : { backgroundColor: '#f1f5f9', borderColor: '#cbd5e1' }}>
        {/* Progress timeline */}
        <div className="relative h-5 px-3 pt-3">
          <div className="relative h-[3px] rounded-full" style={{ background: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)' }}>
            <div className="absolute inset-y-0 left-0 rounded-full transition-none" style={{ width: `${sliderPct}%`, background: isDark ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.25)' }} />
            <div className="absolute top-1/2 w-2.5 h-2.5 bg-primary rounded-full shadow-md pointer-events-none"
              style={{ left: `${sliderPct}%`, transform: 'translate(-50%, -50%)' }} />
          </div>
          {/* Transparent range input layered on top for native drag */}
          <input type="range" min={0} max={1000} value={sliderVal}
            onChange={e => {
              const pct = Number(e.target.value) / 1000
              const t = tMin + pct * lapDuration
              currentTimeRef.current = t
              setCurrentT(t)
              setCrosshairTime(t)
            }}
            className="absolute inset-0 w-full opacity-0 cursor-pointer"
          />
        </div>
        {/* Transport row */}
        <div className="flex items-center justify-center gap-2 px-3 py-2" style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)' }}>
          {/* Skip to start */}
          <button
            onClick={() => { currentTimeRef.current = tMin; setCrosshairTime(tMin) }}
            className="p-1.5 rounded-lg hover:opacity-100 transition-opacity opacity-60 hover:bg-black/5 dark:hover:bg-white/10"
            title={t('toStart')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <rect x="1.5" y="2" width="2" height="10" rx="0.5" />
              <path d="M5 7L12 2.5v9L5 7z" />
            </svg>
          </button>

          {/* Speed: − label + */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => { const i = SPEEDS.indexOf(playbackSpeed); if (i > 0) setPlaybackSpeed(SPEEDS[i - 1]) }}
              disabled={SPEEDS.indexOf(playbackSpeed) === 0}
              className="w-6 h-6 rounded hover:bg-black/8 dark:hover:bg-white/10 transition-colors disabled:opacity-25 text-base font-bold flex items-center justify-center"
            >−</button>
            <span className="text-[11px] font-mono tabular-nums w-9 text-center opacity-65">{playbackSpeed}x</span>
            <button
              onClick={() => { const i = SPEEDS.indexOf(playbackSpeed); if (i < SPEEDS.length - 1) setPlaybackSpeed(SPEEDS[i + 1]) }}
              disabled={SPEEDS.indexOf(playbackSpeed) === SPEEDS.length - 1}
              className="w-6 h-6 rounded hover:bg-black/8 dark:hover:bg-white/10 transition-colors disabled:opacity-25 text-base font-bold flex items-center justify-center"
            >+</button>
          </div>

          {/* Play / Pause */}
          <button
            onClick={togglePlay}
            className="w-9 h-9 rounded-full bg-primary hover:opacity-90 flex items-center justify-center text-primary-foreground shadow-lg transition-opacity mx-1"
          >
            {playing ? (
              <svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor">
                <rect x="2" y="2" width="3" height="8" rx="0.5" />
                <rect x="7" y="2" width="3" height="8" rx="0.5" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor">
                <path d="M3 2l7 4-7 4V2z" />
              </svg>
            )}
          </button>

          {/* Skip to end */}
          <button
            onClick={() => { currentTimeRef.current = tMax; setCrosshairTime(tMax) }}
            className="p-1.5 rounded-lg hover:opacity-100 transition-opacity opacity-60 hover:bg-black/5 dark:hover:bg-white/10"
            title={t('toEnd')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <rect x="10.5" y="2" width="2" height="10" rx="0.5" />
              <path d="M9 7L2 2.5v9L9 7z" />
            </svg>
          </button>

          {/* Elapsed time */}
          <span className="text-[10px] font-mono tabular-nums ml-1 opacity-50">{formatTime(currentT)}</span>
        </div>
      </div>
    </div>
  )
}
