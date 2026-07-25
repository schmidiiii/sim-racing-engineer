import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, parseLapKey, getLapColor } from '@/store/session'
import * as THREE from 'three'

const ALT_SCALE = 0.2 // world units per metre of altitude
const MAX_TRACK_PTS = 1500
const ROAD_WIDTH = 10  // world units (visible road surface width)
const SPEEDS = [0.25, 0.5, 1, 2, 4]

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

interface HudState {
  time: number
  speed: number   // km/h
  gear: number
  throttle: number // 0-100
  brake: number    // 0-100
  steering: number // degrees
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

function speedColor(speedKph: number, maxKph: number): THREE.Color {
  const t = Math.min(1, speedKph / (maxKph || 250))
  const c = new THREE.Color()
  c.setHSL((1 - t) * 0.667, 1, 0.55)
  return c
}

// Build a speed-coloured road ribbon from a series of world-space points.
// Each pair of adjacent points becomes a quad (two triangles) giving the road
// its visible width.  The perpendicular is always kept horizontal so the
// road surface stays level even on slopes.
function buildTrackRibbon(
  pts: THREE.Vector3[],
  speedsKph: number[],
  maxKph: number,
): THREE.BufferGeometry {
  const n = pts.length
  const positions = new Float32Array(n * 2 * 3)
  const colors    = new Float32Array(n * 2 * 3)
  const indices: number[] = []

  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)]
    const next = pts[Math.min(n - 1, i + 1)]
    const tan = new THREE.Vector3().subVectors(next, prev).normalize()
    // Horizontal perpendicular (XZ only so the road doesn't bank)
    const perp = new THREE.Vector3(-tan.z, 0, tan.x).normalize()

    const L = pts[i].clone().addScaledVector(perp,  ROAD_WIDTH / 2)
    const R = pts[i].clone().addScaledVector(perp, -ROAD_WIDTH / 2)

    const o = i * 6
    positions[o]     = L.x; positions[o + 1] = L.y; positions[o + 2] = L.z
    positions[o + 3] = R.x; positions[o + 4] = R.y; positions[o + 5] = R.z

    const c = speedColor(speedsKph[i], maxKph)
    colors[o]     = c.r; colors[o + 1] = c.g; colors[o + 2] = c.b
    colors[o + 3] = c.r; colors[o + 4] = c.g; colors[o + 5] = c.b

    if (i < n - 1) {
      const a = i * 2, b = i * 2 + 1, c2 = i * 2 + 2, d = i * 2 + 3
      indices.push(a, b, d, a, d, c2)
    }
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setAttribute('color',    new THREE.BufferAttribute(colors,    3))
  geom.setIndex(indices)
  return geom
}

// Simple two-box car: flat body + raised cabin, both tinted with lap colour.
function buildCarGroup(hexColor: string): THREE.Group {
  const base  = new THREE.Color(hexColor)
  const dark  = base.clone().multiplyScalar(0.55)
  const group = new THREE.Group()

  // Body
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(3.2, 0.9, 5.2),
    new THREE.MeshLambertMaterial({ color: base }),
  )
  body.position.y = 0.45
  group.add(body)

  // Cabin
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(2.3, 0.8, 2.6),
    new THREE.MeshLambertMaterial({ color: dark }),
  )
  cabin.position.set(0, 1.25, -0.3)
  group.add(cabin)

  return group
}

export default function Replay3DViewer() {
  const { sessions, selectedLapKeys, crosshairTime, setCrosshairTime } = useSessionStore()
  const mountRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef(0)
  const carMeshesRef = useRef<THREE.Mesh[]>([])
  const cameraPosRef = useRef(new THREE.Vector3())
  const cameraTargetRef = useRef(new THREE.Vector3())

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

    // Speed-coloured road ribbon (primary lap)
    const pLap = laps[0]
    const step = Math.max(1, Math.floor(pLap.lat.length / MAX_TRACK_PTS))
    const maxKph = Math.max(...pLap.speed) * 3.6
    const pts: THREE.Vector3[] = []
    const speedsKph: number[] = []
    for (let i = 0; i < pLap.lat.length; i += step) {
      pts.push(toWorld(pLap.lat[i], pLap.lon[i], pLap.alt[i], tf))
      speedsKph.push(pLap.speed[i] * 3.6)
    }
    const ribbonGeom = buildTrackRibbon(pts, speedsKph, maxKph)
    scene.add(new THREE.Mesh(ribbonGeom, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })))

    // Centre line (thin white strip for visibility at distance)
    const clPos = new Float32Array(pts.length * 3)
    pts.forEach((p, i) => { clPos[i * 3] = p.x; clPos[i * 3 + 1] = p.y + 0.02; clPos[i * 3 + 2] = p.z })
    const clGeom = new THREE.BufferGeometry()
    clGeom.setAttribute('position', new THREE.BufferAttribute(clPos, 3))
    scene.add(new THREE.Line(clGeom, new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.25, transparent: true })))

    // Car groups — body + cabin per lap
    const carGroups: THREE.Group[] = []
    for (const lap of laps) {
      const g = buildCarGroup(getLapColor(lap.colorIndex))
      scene.add(g)
      carGroups.push(g)
    }
    carMeshesRef.current = carGroups as unknown as THREE.Mesh[]

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
      .addScaledVector(initFwd, -20)
      .setY(initPos.y + 8)
    cameraTargetRef.current.copy(initPos).addScaledVector(initFwd, 12).setY(initPos.y + 1.5)
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
      laps.forEach((lap, li) => {
        const group = carGroups[li]
        if (!group || !lap.timestamps.length) return
        const idx = bsearchNearest(lap.timestamps, t)
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

      // Chase cam — low, close, looks 14 units ahead of car[0]
      const car0 = carGroups[0]
      if (car0) {
        const ry = car0.rotation.y
        const sy = Math.sin(ry), cy2 = Math.cos(ry)
        const behind = new THREE.Vector3(
          car0.position.x - sy * 20,
          car0.position.y + 7,
          car0.position.z - cy2 * 20,
        )
        cameraPosRef.current.lerp(behind, 0.10)
        camera.position.copy(cameraPosRef.current)
        const lookAhead = new THREE.Vector3(
          car0.position.x + sy * 14,
          car0.position.y + 1.5,
          car0.position.z + cy2 * 14,
        )
        cameraTargetRef.current.lerp(lookAhead, 0.12)
        camera.lookAt(cameraTargetRef.current)
      }

      renderer.render(scene, camera)

      // Update HUD + time display at ~20 fps
      if (frame % 3 === 0) {
        const idx = bsearchNearest(pLap.timestamps, t)
        setHud({
          time: t,
          speed: Math.round((pLap.speed[idx] ?? 0) * 3.6),
          gear: Math.round(pLap.gear[idx] ?? 1),
          throttle: Math.round((pLap.throttle[idx] ?? 0) * 100),
          brake: Math.round((pLap.brake[idx] ?? 0) * 100),
          steering: Math.round((pLap.steering[idx] ?? 0) * 180 / Math.PI),
        })
      }
    }
    rafRef.current = requestAnimationFrame(animate)

    return () => {
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
  }, [laps, tf])

  // ── Playback controls ──────────────────────────────────────────────────────
  const togglePlay = useCallback(() => setPlaying(p => !p), [])

  const pLap = laps[0]
  const tMin = pLap?.timestamps[0] ?? 0
  const tMax = pLap?.timestamps[pLap.timestamps.length - 1] ?? 1
  const lapDuration = tMax - tMin || 1
  const currentT = hud?.time ?? tMin
  const sliderVal = Math.round(((currentT - tMin) / lapDuration) * 1000)

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

      {/* Three.js canvas area */}
      <div ref={mountRef} className="flex-1 min-h-0 relative overflow-hidden">

        {/* HUD overlay — top-right corner */}
        {hud && (
          <div className="absolute top-2 right-2 bg-black/75 text-white rounded-xl p-2.5 text-[10px] font-mono min-w-[76px] pointer-events-none select-none space-y-1 backdrop-blur-sm">
            <div className="text-xl font-bold leading-none tabular-nums">
              {hud.speed}
              <span className="text-[9px] font-normal opacity-60 ml-0.5">km/h</span>
            </div>
            <div className="opacity-75">
              Gear <span className="font-bold text-amber-300">{hud.gear}</span>
            </div>
            <div className="space-y-0.5 pt-0.5">
              <div className="flex items-center gap-1">
                <span className="opacity-50 w-3">T</span>
                <div className="flex-1 h-1.5 bg-white/15 rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-400 rounded-full transition-none" style={{ width: `${hud.throttle}%` }} />
                </div>
              </div>
              <div className="flex items-center gap-1">
                <span className="opacity-50 w-3">B</span>
                <div className="flex-1 h-1.5 bg-white/15 rounded-full overflow-hidden">
                  <div className="h-full bg-rose-400 rounded-full transition-none" style={{ width: `${hud.brake}%` }} />
                </div>
              </div>
            </div>
            <div className="opacity-70 tabular-nums">
              {Math.abs(hud.steering)}°{hud.steering > 1 ? 'R' : hud.steering < -1 ? 'L' : ''}
            </div>
          </div>
        )}

        {/* Lap legend — top-left */}
        <div className="absolute top-2 left-2 flex flex-col gap-0.5 pointer-events-none">
          {laps.map(lap => (
            <span key={lap.lapKey} className="flex items-center gap-1 text-[9px] drop-shadow">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: getLapColor(lap.colorIndex) }} />
              <span className="text-white/70 font-mono">L{lap.lapNumber}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Playback controls bar */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 bg-card border-t border-border">
        {/* Play/Pause */}
        <button
          onClick={togglePlay}
          className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <rect x="2" y="2" width="3" height="8" rx="0.5" />
              <rect x="7" y="2" width="3" height="8" rx="0.5" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M3 2l7 4-7 4V2z" />
            </svg>
          )}
        </button>

        {/* Speed selector */}
        <div className="flex items-center gap-0.5">
          {SPEEDS.map(s => (
            <button
              key={s}
              onClick={() => setPlaybackSpeed(s)}
              className={`text-[9px] px-1 py-0.5 rounded transition-colors ${
                playbackSpeed === s
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {s}x
            </button>
          ))}
        </div>

        {/* Slider */}
        <input
          type="range"
          min={0}
          max={1000}
          value={sliderVal}
          onChange={e => {
            const pct = Number(e.target.value) / 1000
            const t = tMin + pct * lapDuration
            currentTimeRef.current = t
            setCrosshairTime(t)
          }}
          className="flex-1 accent-primary cursor-pointer"
          style={{ height: 4 }}
        />

        {/* Time */}
        <span className="text-[9px] font-mono text-muted-foreground tabular-nums shrink-0 min-w-[40px] text-right">
          {formatTime(currentT)}
        </span>
      </div>
    </div>
  )
}
