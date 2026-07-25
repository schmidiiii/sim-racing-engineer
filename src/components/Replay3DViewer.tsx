import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, parseLapKey, getLapColor } from '@/store/session'
import * as THREE from 'three'

const ALT_SCALE = 0.2 // world units per metre of altitude
const MAX_TRACK_PTS = 2000
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
    const camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 5000)

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(w, h)
    mount.appendChild(renderer.domElement)

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.65))
    const sun = new THREE.DirectionalLight(0xffffff, 1.8)
    sun.position.set(100, 300, 100)
    scene.add(sun)

    // Ground grid
    const grid = new THREE.GridHelper(900, 50, 0x1e3a5f, 0x0f2240)
    scene.add(grid)

    // Speed-colored track (primary lap)
    const pLap = laps[0]
    const step = Math.max(1, Math.floor(pLap.lat.length / MAX_TRACK_PTS))
    const maxKph = Math.max(...pLap.speed) * 3.6
    const trackPos: number[] = []
    const trackCol: number[] = []
    for (let i = 0; i < pLap.lat.length; i += step) {
      const p = toWorld(pLap.lat[i], pLap.lon[i], pLap.alt[i], tf)
      trackPos.push(p.x, p.y, p.z)
      const c = speedColor(pLap.speed[i] * 3.6, maxKph)
      trackCol.push(c.r, c.g, c.b)
    }
    const trackGeom = new THREE.BufferGeometry()
    trackGeom.setAttribute('position', new THREE.Float32BufferAttribute(trackPos, 3))
    trackGeom.setAttribute('color', new THREE.Float32BufferAttribute(trackCol, 3))
    scene.add(new THREE.Line(trackGeom, new THREE.LineBasicMaterial({ vertexColors: true })))

    // Car meshes
    const carGeom = new THREE.BoxGeometry(2.5, 1.2, 5)
    const cars: THREE.Mesh[] = []
    for (const lap of laps) {
      const mesh = new THREE.Mesh(carGeom, new THREE.MeshLambertMaterial({ color: getLapColor(lap.colorIndex) }))
      scene.add(mesh)
      cars.push(mesh)
    }
    carMeshesRef.current = cars

    // Init camera behind primary lap's car at current crosshair position
    const tInit = crosshairRef.current ?? pLap.timestamps[0]
    const initIdx = bsearchNearest(pLap.timestamps, tInit)
    const initPos = toWorld(pLap.lat[initIdx], pLap.lon[initIdx], pLap.alt[initIdx], tf)
    cameraPosRef.current.set(initPos.x, initPos.y + 12, initPos.z + 30)
    cameraTargetRef.current.copy(initPos).add(new THREE.Vector3(0, 2, 0))
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
        const mesh = cars[li]
        if (!mesh || !lap.timestamps.length) return
        const idx = bsearchNearest(lap.timestamps, t)
        const pos = toWorld(lap.lat[idx], lap.lon[idx], lap.alt[idx], tf)
        mesh.position.copy(pos)
        mesh.position.y += 0.6 // car sits on top of track line
        const nIdx = Math.min(idx + 5, lap.lat.length - 1)
        if (nIdx > idx) {
          const nPos = toWorld(lap.lat[nIdx], lap.lon[nIdx], lap.alt[nIdx], tf)
          const dir = nPos.clone().sub(pos)
          if (dir.lengthSq() > 0.001) mesh.rotation.y = Math.atan2(dir.x, dir.z)
        }
      })

      // Chase cam (smooth lerp, follows car[0])
      const car0 = cars[0]
      if (car0) {
        const cy = car0.rotation.y
        const behind = new THREE.Vector3(
          car0.position.x - Math.sin(cy) * 30,
          car0.position.y + 14,
          car0.position.z - Math.cos(cy) * 30,
        )
        cameraPosRef.current.lerp(behind, 0.07)
        camera.position.copy(cameraPosRef.current)
        const look = car0.position.clone().add(new THREE.Vector3(0, 2, 0))
        cameraTargetRef.current.lerp(look, 0.1)
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
