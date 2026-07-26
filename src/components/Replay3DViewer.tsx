import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, parseLapKey, getLapColor } from '@/store/session'
import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'

const ALT_SCALE = 0.2 // world units per metre of altitude
const MAX_TRACK_PTS = 1500
const ROAD_WIDTH = 10  // world units (visible road surface width)
const LINE_WIDTH  = 0.35 // per-lap driving line width (world units)
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
  timestamps: number[]
}


interface WorldTF {
  centerLat: number
  centerLon: number
  minAlt: number
  scale: number
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
  return {
    centerLat: (minLat + maxLat) / 2,
    centerLon: (minLon + maxLon) / 2,
    minAlt,
    scale: 400 / Math.max(latR, lonR),
  }
}

function toWorld(lat: number, lon: number, alt: number, tf: WorldTF): THREE.Vector3 {
  return new THREE.Vector3(
    (lon - tf.centerLon) * tf.scale,
    (alt - tf.minAlt) * ALT_SCALE,
    -(lat - tf.centerLat) * tf.scale,
  )
}

// Build a flat road ribbon (no colour attribute — colour set via Material).
// close=true connects the last vertex pair back to the first, sealing the loop at start/finish.
function buildRibbon(pts: THREE.Vector3[], width: number, close = false): THREE.BufferGeometry {
  const n = pts.length
  const positions = new Float32Array(n * 2 * 3)
  const indices: number[] = []

  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)]
    const next = pts[Math.min(n - 1, i + 1)]
    const tan  = new THREE.Vector3().subVectors(next, prev).normalize()
    const perp = new THREE.Vector3(-tan.z, 0, tan.x).normalize()

    const L = pts[i].clone().addScaledVector(perp,  width / 2)
    const R = pts[i].clone().addScaledVector(perp, -width / 2)

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

// Tint every mesh in a loaded model with the lap colour
function applyLapColor(model: THREE.Object3D, hexColor: string) {
  const color = new THREE.Color(hexColor)
  model.traverse(child => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    // Dispose any existing material(s) to avoid leaks
    if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose())
    else if (mesh.material) mesh.material.dispose()
    mesh.material = new THREE.MeshLambertMaterial({ color })
  })
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
function buildPlaceholderCar(): THREE.Group {
  const group = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.55, 3.5), new THREE.MeshLambertMaterial({ color: 0x555555 }))
  body.position.y = 0.35
  group.add(body)
  return group
}

export default function Replay3DViewer() {
  const { sessions, selectedLapKeys, crosshairTime, setCrosshairTime } = useSessionStore()
  const mountRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef(0)
  const carMeshesRef = useRef<THREE.Mesh[]>([])  // holds THREE.Group[] at runtime
  const cameraPosRef = useRef(new THREE.Vector3())
  const cameraTargetRef = useRef(new THREE.Vector3())

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
  const cameraModeRef = useRef<'chase' | 'front' | 'tv'>('chase')

  const [laps, setLaps] = useState<LapReplayData[]>([])
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  // currentT drives the slider — updated every 9 frames (~7fps), all other HUD values
  // are written directly to DOM refs to avoid React re-renders during playback
  const [currentT, setCurrentT] = useState(0)
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'))
  const [cameraMode, setCameraMode] = useState<'chase' | 'front' | 'tv'>('chase')
  const [hudScale, setHudScale] = useState(1)

  const hudSpeedRefs  = useRef<(HTMLSpanElement  | null)[]>([])
  const hudGearRefs   = useRef<(HTMLSpanElement  | null)[]>([])
  const hudThrRefs    = useRef<(HTMLDivElement   | null)[]>([])
  const hudBrkRefs    = useRef<(HTMLDivElement   | null)[]>([])
  const hudWheelRefs  = useRef<(HTMLImageElement  | null)[]>([])
  const hudDegRefs    = useRef<(HTMLSpanElement  | null)[]>([])
  const hudDeltaRefs  = useRef<(HTMLSpanElement  | null)[]>([])
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
    const scale = 90 / Math.max(latR, lonR)
    const toMapXY = (lat: number, lon: number): [number, number] => [
      5 + (lon - minLon) * scale,
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
    if (selectedLapKeys.length === 0 || sessions.length === 0) { setLaps([]); return }
    setLoading(true)
    const CHANNELS = ['Lat', 'Lon', 'Alt', 'Speed', 'Gear', 'Throttle', 'Brake', 'SteeringWheelAngle'] as const

    ;(async () => {
      const out: LapReplayData[] = []
      for (let ci = 0; ci < selectedLapKeys.length; ci++) {
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
          const [latD, lonD, altD, speedD, gearD, throttleD, brakeD, steeringD] = results
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
            timestamps: latD.timestamps,
          })
        } catch { /* no GPS */ }
      }
      setLaps(out)
      setLoading(false)
    })()
  }, [selectedLapKeys.join(','), sessions.length])

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
    const skyCol  = isDark ? 0x1c1c1e : 0xffffff
    const gndCol  = isDark ? 0x141416 : 0xe5e5e5
    const roadCol = isDark ? 0x2a2a2e : 0x5a6070
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(skyCol)
    scene.fog = new THREE.Fog(skyCol, 300, 1200)

    // Camera
    const camera = new THREE.PerspectiveCamera(65, w / h, 0.1, 5000)

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(w, h)
    mount.appendChild(renderer.domElement)

    // Lights — brighter ambient in light mode for realistic daylight feel
    scene.add(new THREE.AmbientLight(0xffffff, isDark ? 0.55 : 1.1))
    const sun = new THREE.DirectionalLight(0xffffff, isDark ? 2.2 : 3.0)
    sun.position.set(80, 200, 80)
    scene.add(sun)

    // Subtle ground plane so cars cast a visual reference
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1200, 1200),
      new THREE.MeshBasicMaterial({ color: gndCol }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.05
    scene.add(ground)

    // ── Track surface ──────────────────────────────────────────────────────
    const pLap = laps[0]

    const step = Math.max(1, Math.floor(pLap.lat.length / MAX_TRACK_PTS))
    const basePts: THREE.Vector3[] = []
    for (let i = 0; i < pLap.lat.length; i += step)
      basePts.push(toWorld(pLap.lat[i], pLap.lon[i], pLap.alt[i], tf))

    // Road surface
    scene.add(new THREE.Mesh(
      buildRibbon(basePts, ROAD_WIDTH, true),
      new THREE.MeshBasicMaterial({ color: roadCol, side: THREE.DoubleSide }),
    ))

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
      lapMesh.position.y = 0.06
      scene.add(lapMesh)
    }

    // White edge strips
    const halfW = ROAD_WIDTH / 2
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })
    for (const sign of [-1, 1]) {
      const edgePts = basePts.map((p, i) => {
        const prev = basePts[Math.max(0, i - 1)]
        const next = basePts[Math.min(basePts.length - 1, i + 1)]
        const tan  = new THREE.Vector3().subVectors(next, prev).normalize()
        const perp = new THREE.Vector3(-tan.z, 0, tan.x)
        return p.clone().addScaledVector(perp, sign * halfW).setY(p.y + 0.12)
      })
      scene.add(new THREE.Mesh(buildRibbon(edgePts, 0.55, true), edgeMat))
    }

    // Car placeholder groups (shown immediately while OBJ loads)
    const carGroups: THREE.Group[] = laps.map(() => {
      const g = buildPlaceholderCar()
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
        fitToWorldUnits(baseModel, 1.4)
        // Porsche faces -Z natively → flip 180°; F1 faces +X natively → rotate -90°
        baseModel.rotation.y = openWheelCar ? -Math.PI / 2 : Math.PI

        laps.forEach((lap, i) => {
          const innerModel = baseModel.clone(true)
          applyLapColor(innerModel, getLapColor(lap.colorIndex))
          // Outer group receives yaw from animation loop; inner model keeps the 180° correction
          const outerGroup = new THREE.Group()
          outerGroup.add(innerModel)
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
    const traceBuffers: { thr: number[]; brk: number[] }[] = laps.map(() => ({ thr: [], brk: [] }))

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
      const dist  = 5 + (i % 3) * 1.5   // 5, 6.5, 8 units — tight trackside
      const height = 5 + (i % 4) * 1.0  // 5 → 8 units — elevated enough to see cars on track
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
        group.position.y += 0.35  // just above road ribbon so car appears on its trace
        // Heading: look a few samples ahead from the interpolated position
        const dIdx = Math.min(idx + 5, lap.lat.length - 1)
        if (dIdx > idx) {
          const nPos = toWorld(lap.lat[dIdx], lap.lon[dIdx], lap.alt[dIdx], tf)
          const dir = nPos.clone().sub(pos)
          if (dir.lengthSq() > 0.001) group.rotation.y = Math.atan2(dir.x, dir.z)
        }

        // Direct DOM HUD updates — bypasses React virtual DOM
        const speed  = Math.round((lap.speed[idx] ?? 0) * 3.6)
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

        // Positional delta (lap i vs lap 0)
        if (li > 0 && pLap.lat.length > 1) {
          const frac0 = idx0 / (pLap.lat.length - 1)
          const j = Math.min(Math.round(frac0 * (lap.lat.length - 1)), lap.lat.length - 1)
          const delta = (lap.timestamps[j] - lap.timestamps[0]) - elapsed0
          const deltaEl = hudDeltaRefs.current[li]
          if (deltaEl) {
            deltaEl.textContent = `${delta >= 0 ? '+' : ''}${delta.toFixed(3)}s`
            deltaEl.style.color = delta > 0.05 ? '#fb7185' : delta < -0.05 ? '#34d399' : isDark ? 'rgba(255,255,255,0.45)' : 'rgba(15,23,42,0.50)'
          }
        }

        // Minimap dot
        const dot = mapDotRefs.current[li]
        if (dot && trackMapDataRef.current) {
          const [mx, my] = trackMapDataRef.current.toMapXY(lap.lat[idx], lap.lon[idx])
          dot.setAttribute('cx', mx.toFixed(1))
          dot.setAttribute('cy', my.toFixed(1))
        }

        // Rolling telemetry trace — only advance when playing, freeze on pause
        const buf = traceBuffers[li]
        if (playingRef.current) {
          buf.thr.push(thr)
          buf.brk.push(brk)
          if (buf.thr.length > TRACE_SAMPLES) { buf.thr.shift(); buf.brk.shift() }
        }
        const canvas = hudTraceRefs.current[li]
        if (canvas) {
          const ctx = canvas.getContext('2d')
          if (ctx) {
            const W = canvas.width, H = canvas.height
            const n = buf.thr.length
            ctx.clearRect(0, 0, W, H)
            // Draw filled area + stroke for each channel
            const drawChannel = (data: number[], fillColor: string, strokeColor: string) => {
              if (n < 2) return
              // Newest sample always anchored to right edge; trace grows left as buffer fills
              const xOf = (i: number) => ((TRACE_SAMPLES - n + i) / TRACE_SAMPLES) * W
              const xStart = xOf(0), xEnd = xOf(n - 1)
              ctx.beginPath()
              ctx.moveTo(xStart, H)
              for (let i = 0; i < n; i++) {
                ctx.lineTo(xOf(i), H - (data[i] / 100) * (H - 2) - 1)
              }
              ctx.lineTo(xEnd, H)
              ctx.closePath()
              ctx.fillStyle = fillColor
              ctx.fill()
              ctx.beginPath()
              ctx.strokeStyle = strokeColor; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'
              for (let i = 0; i < n; i++) {
                const x = xOf(i), y = H - (data[i] / 100) * (H - 2) - 1
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
              }
              ctx.stroke()
            }
            drawChannel(buf.brk, 'rgba(239,68,68,0.28)', '#ef4444')
            drawChannel(buf.thr, 'rgba(34,197,94,0.28)', '#22c55e')
          }
        }
      })

      // Slider update at low frequency only
      if (frame % 9 === 0) setCurrentT(t)

      // Camera — three modes, all frame-rate-independent
      const car0 = carGroups[0]
      if (car0) {
        const ry  = car0.rotation.y
        const sy  = Math.sin(ry), cy2 = Math.cos(ry)
        // forward = (sy, 0, cy2), right = (cy2, 0, -sy)
        const posAlpha  = 1 - Math.pow(0.90, dt * 60)
        const lookAlpha = 1 - Math.pow(0.88, dt * 60)
        const carY = car0.position.y

        // Restore base FOV when not in TV mode
        if (cameraModeRef.current !== 'tv' && camera.fov !== 65) {
          camera.fov = 65
          camera.updateProjectionMatrix()
        }
        if (cameraModeRef.current === 'chase') {
          const behind = new THREE.Vector3(car0.position.x - sy * 9, carY + 3.5, car0.position.z - cy2 * 9)
          cameraPosRef.current.lerp(behind, posAlpha)
          const ahead = new THREE.Vector3(car0.position.x + sy * 7, carY + 0.8, car0.position.z + cy2 * 7)
          cameraTargetRef.current.lerp(ahead, lookAlpha)
        } else if (cameraModeRef.current === 'front') {
          // Camera in front of car, looking back
          const front = new THREE.Vector3(car0.position.x + sy * 9, carY + 1.8, car0.position.z + cy2 * 9)
          cameraPosRef.current.lerp(front, posAlpha)
          const carCenter = new THREE.Vector3(car0.position.x, carY + 0.6, car0.position.z)
          cameraTargetRef.current.lerp(carCenter, lookAlpha)
        } else if (cameraModeRef.current === 'tv') {
          const n = tvCamPositions.length
          if (n > 0) {
            const distToCamera = tvCamPositions[tvCamIndex].distanceTo(car0.position)
            // Distance-based target FOV: keeps car at a consistent apparent size.
            // 250/D gives ~45° at D=5.5 (close), ~25° at D=10, ~15° at D=16.
            const targetFov = Math.max(15, Math.min(45, 250 / distToCamera))

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
              new THREE.Vector3(car0.position.x, carY + 0.5, car0.position.z),
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

      renderer.render(scene, camera)
    }
    rafRef.current = requestAnimationFrame(animate)

    return () => {
      loadCancelled = true
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
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

  // ── HUD proportional scaling — shrinks pills when container is narrow ───────
  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    const update = () => {
      const w = el.clientWidth
      const n = Math.max(1, laps.length)
      // natural pill width 320px; N pills + (N-1) gaps of 8px between them
      const naturalW = n * 320 + (n - 1) * 8
      setHudScale(Math.min(1, w / naturalW))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [laps.length])

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
        <p className="text-xs text-muted-foreground">Loading 3D data…</p>
      </div>
    )
  }

  if (laps.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-background px-4 text-center">
        <p className="text-xs text-muted-foreground">Select laps with GPS data to view 3D replay</p>
      </div>
    )
  }

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">

      {/* Three.js canvas area — bg prevents flash before canvas mounts */}
      <div ref={mountRef} className="flex-1 min-h-0 relative overflow-hidden" style={{ backgroundColor: isDark ? '#1c1c1e' : '#ffffff' }}>

        {/* Camera mode buttons — top-right */}
        <div className="absolute top-2 right-2 flex gap-1 select-none">
          {(['chase', 'front', 'tv'] as const).map(mode => (
            <button key={mode} onClick={() => setCameraMode(mode)}
              className={`text-[8px] font-bold rounded px-1.5 py-0.5 transition-colors ${
                cameraMode === mode
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-black/45 text-white/55 hover:text-white hover:bg-black/65'
              }`}>
              {mode === 'chase' ? 'REAR' : mode === 'front' ? 'FRONT' : 'TV'}
            </button>
          ))}
        </div>

        {/* Track minimap — top-left, bare SVG on canvas */}
        {trackMapData && (
          <div className="absolute top-2 left-2 pointer-events-none select-none">
            <svg width="90" height="90" viewBox="0 0 100 100">
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

                  {/* Lap info strip — backdrop for readability over 3D scene */}
                  <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg"
                    style={{ background: stripBg, backdropFilter: 'blur(6px)' }}>
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: lapColor }} />
                    <span className="text-[9px] font-bold tracking-wider uppercase" style={{ color: stripTxt }}>L{lap.lapNumber}</span>
                    {fmtLapTime && (
                      <span className="text-[9px] font-mono tabular-nums" style={{ color: stripSub }}>{fmtLapTime}</span>
                    )}
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
                        Telemetry
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
                        style={{ fontSize: 8, color: textDim }}>kph</span>
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
            title="Zum Anfang"
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
            title="Zum Ende"
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
