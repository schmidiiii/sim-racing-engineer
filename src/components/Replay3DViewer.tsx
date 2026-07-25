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

interface HudLapData {
  speed: number
  gear: number
  throttle: number
  brake: number
  steering: number
  delta: number  // seconds vs lap 0 (positional delta; 0 for reference lap)
  lapIdx: number // current GPS sample index into lap.lat/lon
}

interface HudState {
  time: number
  laps: HudLapData[]
}

interface WorldTF {
  centerLat: number
  centerLon: number
  minAlt: number
  scale: number
}

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
function buildRibbon(pts: THREE.Vector3[], width: number): THREE.BufferGeometry {
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

  const [laps, setLaps] = useState<LapReplayData[]>([])
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [hud, setHud] = useState<HudState | null>(null)

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

    // Scene
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0f172a)
    scene.fog = new THREE.Fog(0x0f172a, 300, 1200)

    // Camera
    const camera = new THREE.PerspectiveCamera(65, w / h, 0.1, 5000)

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(w, h)
    mount.appendChild(renderer.domElement)

    // Lights — ambient fills shadows, directional adds depth to car bodies
    scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    const sun = new THREE.DirectionalLight(0xffffff, 2.2)
    sun.position.set(80, 200, 80)
    scene.add(sun)

    // Subtle ground plane so cars cast a visual reference
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1200, 1200),
      new THREE.MeshBasicMaterial({ color: 0x0c1a2e }),
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

    // Dark road surface
    scene.add(new THREE.Mesh(
      buildRibbon(basePts, ROAD_WIDTH),
      new THREE.MeshBasicMaterial({ color: 0x0e1b2e, side: THREE.DoubleSide }),
    ))

    // Per-lap coloured driving line
    for (const lap of laps) {
      const lapStep = Math.max(1, Math.floor(lap.lat.length / MAX_TRACK_PTS))
      const lapPts: THREE.Vector3[] = []
      for (let i = 0; i < lap.lat.length; i += lapStep)
        lapPts.push(toWorld(lap.lat[i], lap.lon[i], lap.alt[i], tf))
      const lapMesh = new THREE.Mesh(
        buildRibbon(lapPts, LINE_WIDTH),
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
      scene.add(new THREE.Mesh(buildRibbon(edgePts, 0.55), edgeMat))
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

    // Init camera behind primary lap's car
    const tInit = crosshairRef.current ?? pLap.timestamps[0]
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
        if (frame % 2 === 0) setCrosshairTime(currentTimeRef.current)
      } else {
        const ct = crosshairRef.current
        if (ct != null) currentTimeRef.current = ct
      }

      const t = currentTimeRef.current

      // Update car positions + orientation
      // Each lap has its own absolute timestamp base — shift so all laps progress
      // from their own start simultaneously (handles cross-lap and cross-session replay)
      const lapT0 = pLap.timestamps[0]
      laps.forEach((lap, li) => {
        const group = carGroups[li]
        if (!group || !lap.timestamps.length) return
        const lapT = t + (lap.timestamps[0] - lapT0)
        const idx = bsearchNearest(lap.timestamps, lapT)
        const pos = toWorld(lap.lat[idx], lap.lon[idx], lap.alt[idx], tf)
        group.position.copy(pos)
        group.position.y += 1.0
        const nIdx = Math.min(idx + 6, lap.lat.length - 1)
        if (nIdx > idx) {
          const nPos = toWorld(lap.lat[nIdx], lap.lon[nIdx], lap.alt[nIdx], tf)
          const dir = nPos.clone().sub(pos)
          if (dir.lengthSq() > 0.001) group.rotation.y = Math.atan2(dir.x, dir.z)
        }
      })

      // Chase cam — close behind, looks ahead of car[0]
      const car0 = carGroups[0]
      if (car0) {
        const ry = car0.rotation.y
        const sy = Math.sin(ry), cy2 = Math.cos(ry)
        const behind = new THREE.Vector3(
          car0.position.x - sy * 8,
          car0.position.y + 3,
          car0.position.z - cy2 * 8,
        )
        cameraPosRef.current.lerp(behind, 0.10)
        camera.position.copy(cameraPosRef.current)
        const lookAhead = new THREE.Vector3(
          car0.position.x + sy * 7,
          car0.position.y + 0.8,
          car0.position.z + cy2 * 7,
        )
        cameraTargetRef.current.lerp(lookAhead, 0.12)
        camera.lookAt(cameraTargetRef.current)
      }

      renderer.render(scene, camera)

      // Update HUD + time display at ~20 fps
      if (frame % 3 === 0) {
        const lapT0base = pLap.timestamps[0]
        const idx0 = bsearchNearest(pLap.timestamps, t)
        const elapsed0 = pLap.timestamps[idx0] - lapT0base

        const lapHuds: HudLapData[] = laps.map((lap, li) => {
          const lapT = t + (lap.timestamps[0] - lapT0base)
          const idx = bsearchNearest(lap.timestamps, lapT)

          // Positional delta: seconds lap i needs to reach the same circuit fraction as lap 0
          let delta = 0
          if (li > 0 && pLap.lat.length > 1) {
            const frac0 = idx0 / (pLap.lat.length - 1)
            const j = Math.min(Math.round(frac0 * (lap.lat.length - 1)), lap.lat.length - 1)
            delta = (lap.timestamps[j] - lap.timestamps[0]) - elapsed0
          }

          return {
            speed: Math.round((lap.speed[idx] ?? 0) * 3.6),
            gear: Math.round(lap.gear[idx] ?? 1),
            throttle: Math.round((lap.throttle[idx] ?? 0) * 100),
            brake: Math.round((lap.brake[idx] ?? 0) * 100),
            steering: Math.round((lap.steering[idx] ?? 0) * 180 / Math.PI),
            delta,
            lapIdx: idx,
          }
        })
        setHud({ time: t, laps: lapHuds })
      }
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
  }, [laps, tf, openWheelCar])

  // ── Playback controls ──────────────────────────────────────────────────────
  const togglePlay = useCallback(() => setPlaying(p => !p), [])

  const pLap = laps[0]
  const tMin = pLap?.timestamps[0] ?? 0
  const tMax = pLap?.timestamps[pLap.timestamps.length - 1] ?? 1
  const lapDuration = tMax - tMin || 1
  const currentT = hud?.time ?? tMin
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

      {/* Three.js canvas area — bg-neutral-950 prevents white flash before canvas mounts */}
      <div ref={mountRef} className="flex-1 min-h-0 relative overflow-hidden bg-neutral-950">

        {/* Track minimap — top-left, bare SVG on canvas */}
        {trackMapData && (
          <div className="absolute top-2 left-2 pointer-events-none select-none">
            <svg width="130" height="130" viewBox="0 0 100 100">
              <path d={trackMapData.d} fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.38)" strokeWidth="1.6" strokeLinejoin="round" />
              <circle cx={trackMapData.startXY[0]} cy={trackMapData.startXY[1]} r="2.5" fill="white" opacity="0.5" />
              {hud?.laps.map((lapData, li) => {
                const lap = laps[li]
                if (!lap || lap.lat.length === 0) return null
                const idx = Math.min(lapData.lapIdx, lap.lat.length - 1)
                const [cx, cy] = trackMapData.toMapXY(lap.lat[idx], lap.lon[idx])
                return (
                  <g key={lap.lapKey}>
                    <circle cx={cx} cy={cy} r="4" fill={getLapColor(lap.colorIndex)} />
                    <circle cx={cx} cy={cy} r="4" fill="none" stroke="white" strokeWidth="0.7" opacity="0.45" />
                  </g>
                )
              })}
            </svg>
          </div>
        )}

        {/* HUD panels — bottom-left and bottom-right */}
        {hud && hud.laps.length > 0 && (
          <div className="absolute bottom-2 inset-x-2 flex items-end justify-between pointer-events-none select-none">
            {hud.laps.map((lapData, li) => {
              const lap = laps[li]
              if (!lap) return null
              const lapColor = getLapColor(lap.colorIndex)
              const lapTime = lapTimes[li]
              const fmtLapTime = lapTime != null
                ? `${Math.floor(lapTime / 60)}:${(lapTime % 60).toFixed(3).padStart(6, '0')}`
                : null
              const deltaColor = lapData.delta > 0.05 ? 'text-rose-400' : lapData.delta < -0.05 ? 'text-emerald-400' : 'text-white/45'
              return (
                <div key={lap.lapKey}
                  className="bg-black/55 backdrop-blur-md text-white rounded-xl px-3 py-2 ring-1 ring-white/10">
                  {/* Header */}
                  <div className="flex items-center gap-1.5 mb-2">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: lapColor }} />
                    <span className="text-[9px] font-bold tracking-wider text-white/80 uppercase">L{lap.lapNumber}</span>
                    {fmtLapTime && (
                      <span className="text-[9px] font-mono text-white/50 tabular-nums ml-1">{fmtLapTime}</span>
                    )}
                    {li > 0 && (
                      <span className={`text-[9px] font-bold tabular-nums ml-auto ${deltaColor}`}>
                        {lapData.delta >= 0 ? '+' : ''}{lapData.delta.toFixed(3)}s
                      </span>
                    )}
                  </div>
                  {/* Main data row */}
                  <div className="flex items-center gap-2.5">
                    {/* Vertical BRK / THR bars */}
                    <div className="flex gap-1 items-end pb-3">
                      {([
                        { label: 'BRK', val: lapData.brake,    color: 'bg-rose-500'   },
                        { label: 'THR', val: lapData.throttle, color: 'bg-emerald-400' },
                      ] as const).map(bar => (
                        <div key={bar.label} className="flex flex-col items-center gap-0.5">
                          <div className="w-[9px] h-10 bg-white/10 rounded-sm relative overflow-hidden">
                            <div className={`absolute bottom-0 left-0 right-0 ${bar.color} transition-none`}
                              style={{ height: `${bar.val}%` }} />
                          </div>
                          <span className="text-[6px] text-white/35 tracking-wide">{bar.label}</span>
                        </div>
                      ))}
                    </div>
                    {/* Gear */}
                    <div className="flex flex-col items-center">
                      <span className="text-[30px] font-bold leading-none tabular-nums text-amber-300">{lapData.gear}</span>
                      <span className="text-[7px] text-white/35 tracking-widest mt-0.5">GEAR</span>
                    </div>
                    {/* Speed */}
                    <div className="flex flex-col items-center">
                      <span className="text-[24px] font-bold leading-none tabular-nums">{lapData.speed}</span>
                      <span className="text-[7px] text-white/40 tracking-wide mt-0.5">km/h</span>
                    </div>
                    {/* Steering wheel */}
                    <div className="flex flex-col items-center gap-0.5">
                      <div className="relative w-[30px] h-[30px]">
                        <svg width="30" height="30" viewBox="-15 -15 30 30"
                          style={{ transform: `rotate(${lapData.steering}deg)`, display: 'block' }}>
                          <circle r="12" fill="none" stroke="white" strokeWidth="2" opacity="0.7" />
                          <circle r="3" fill="white" opacity="0.3" />
                          <line x1="0" y1="-12" x2="0" y2="-4" stroke="white" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                          <line x1="0" y1="12"  x2="0"  y2="4"  stroke="white" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                          <line x1="-12" y1="0" x2="-4" y2="0"  stroke="white" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                          <line x1="12"  y1="0" x2="4"  y2="0"  stroke="white" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                        </svg>
                        <svg width="30" height="30" viewBox="-15 -15 30 30" className="absolute inset-0 pointer-events-none">
                          <line x1="0" y1="-14" x2="0" y2="-9" stroke="white" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
                        </svg>
                      </div>
                      <span className="text-[6px] text-white/35 tabular-nums">
                        {Math.abs(lapData.steering)}°{lapData.steering > 1 ? 'R' : lapData.steering < -1 ? 'L' : ''}
                      </span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Playback controls — dark bar matching 3D theme */}
      <div className="shrink-0 bg-neutral-900 border-t border-white/8 select-none">
        {/* Progress timeline */}
        <div className="relative h-5 px-3 pt-3">
          <div className="relative h-[3px] bg-white/12 rounded-full">
            <div className="absolute inset-y-0 left-0 bg-white/30 rounded-full transition-none" style={{ width: `${sliderPct}%` }} />
            <div className="absolute top-1/2 w-2.5 h-2.5 bg-amber-400 rounded-full shadow-md shadow-amber-400/40 pointer-events-none"
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
        <div className="flex items-center justify-center gap-1.5 px-3 py-2">
          {/* Skip to start */}
          <button
            onClick={() => { currentTimeRef.current = tMin; setCrosshairTime(tMin) }}
            className="p-1.5 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/8 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <rect x="1.5" y="2" width="2" height="10" rx="0.5" />
              <path d="M5 7L12 2.5v9L5 7z" />
            </svg>
          </button>
          {/* Slower */}
          <button
            onClick={() => { const i = SPEEDS.indexOf(playbackSpeed); if (i > 0) setPlaybackSpeed(SPEEDS[i - 1]) }}
            className="p-1.5 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/8 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3L4 7l4 4M13 3L9 7l4 4" />
            </svg>
          </button>
          {/* Play / Pause — amber accent */}
          <button
            onClick={togglePlay}
            className="w-9 h-9 rounded-full bg-amber-400 hover:bg-amber-300 flex items-center justify-center text-neutral-900 shadow-lg shadow-amber-400/20 transition-colors mx-1"
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
          {/* Faster */}
          <button
            onClick={() => { const i = SPEEDS.indexOf(playbackSpeed); if (i < SPEEDS.length - 1) setPlaybackSpeed(SPEEDS[i + 1]) }}
            className="p-1.5 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/8 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 3l4 4-4 4M1 3l4 4-4 4" />
            </svg>
          </button>
          {/* Skip to end */}
          <button
            onClick={() => { currentTimeRef.current = tMax; setCrosshairTime(tMax) }}
            className="p-1.5 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/8 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <rect x="10.5" y="2" width="2" height="10" rx="0.5" />
              <path d="M9 7L2 2.5v9L9 7z" />
            </svg>
          </button>
          {/* Speed label */}
          <span className="text-[10px] font-mono text-white/45 tabular-nums w-8 text-center ml-2">{playbackSpeed}x</span>
          {/* Elapsed time */}
          <span className="text-[10px] font-mono text-white/45 tabular-nums ml-1">{formatTime(currentT)}</span>
        </div>
      </div>
    </div>
  )
}
