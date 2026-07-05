import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, parseLapKey, getLapColor } from '@/store/session'
import TraceChart, { LapTrace } from '@/components/TraceChart'

interface LapChannelData {
  lap_number: number
  channel: string
  samples: number[]
  timestamps: number[]
  lap_dist_pct: number[]
}

interface LapGPS {
  lapKey: string
  lapNumber: number
  colorIndex: number
  lat: number[]
  lon: number[]
  timestamps: number[]   // needed to map crosshair time → track position
}

interface ViewBox { x: number; y: number; w: number; h: number }

const SIZE = 1000
const INITIAL_VB: ViewBox = { x: 0, y: 0, w: SIZE, h: SIZE }

// Loop-based min/max — Math.min(...largeArray) can stack-overflow for big GPS traces
function computeTransform(lats: number[], lons: number[]) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity
  for (let i = 0; i < lats.length; i++) {
    if (lats[i] < minLat) minLat = lats[i]
    if (lats[i] > maxLat) maxLat = lats[i]
  }
  for (let i = 0; i < lons.length; i++) {
    if (lons[i] < minLon) minLon = lons[i]
    if (lons[i] > maxLon) maxLon = lons[i]
  }
  const latR = maxLat - minLat || 1e-6
  const lonR = maxLon - minLon || 1e-6
  const scale = Math.min(SIZE / lonR, SIZE / latR) * 0.9
  return { minLat, minLon, scale, ox: (SIZE - lonR * scale) / 2, oy: (SIZE - latR * scale) / 2 }
}

function project(lat: number, lon: number, tf: ReturnType<typeof computeTransform>) {
  return { x: (lon - tf.minLon) * tf.scale + tf.ox, y: SIZE - (lat - tf.minLat) * tf.scale - tf.oy }
}

function buildPolyline(lat: number[], lon: number[], tf: ReturnType<typeof computeTransform>, step: number) {
  const pts: string[] = []
  for (let i = 0; i < lat.length; i += step) {
    const p = project(lat[i], lon[i], tf)
    pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`)
  }
  if (lat.length > 0) {
    const p = project(lat[0], lon[0], tf)
    pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`)
  }
  return pts.join(' ')
}

// Binary search: index of timestamp closest to target
function nearestTimeIdx(timestamps: number[], target: number): number {
  let lo = 0, hi = timestamps.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (timestamps[mid] < target) lo = mid + 1; else hi = mid
  }
  if (lo > 0 && Math.abs(timestamps[lo - 1] - target) < Math.abs(timestamps[lo] - target)) lo--
  return lo
}

const TELE_CHANNELS = [
  { ch: 'Speed',    unit: 'km/h', domain: [0, 'auto'] as [number | 'auto', number | 'auto'], xform: (v: number) => v * 3.6 },
  { ch: 'Throttle', unit: '%',    domain: [0, 100]    as [number | 'auto', number | 'auto'], xform: (v: number) => v * 100 },
  { ch: 'Brake',    unit: '%',    domain: [0, 100]    as [number | 'auto', number | 'auto'], xform: (v: number) => v * 100 },
  { ch: 'Gear',     unit: '',     domain: [0, 'auto'] as [number | 'auto', number | 'auto'], xform: (v: number) => v },
]

export default function LapMap() {
  const { sessions, selectedLapKeys } = useSessionStore()
  const [laps, setLaps]     = useState<LapGPS[]>([])
  const [traces, setTraces] = useState<Record<string, LapTrace[]>>({})
  const [loading, setLoading] = useState(false)

  // Map zoom/pan
  const svgRef       = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [vb, setVb]  = useState<ViewBox>(INITIAL_VB)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)

  // Telemetry chart sync (crosshair + zoom)
  const zoomRef     = useRef<[number, number] | null>(null)
  const redrawsRef  = useRef(new Set<() => void>())
  const [crosshairTime, setCrosshairTime] = useState<number | null>(null)

  const handleZoom = useCallback((domain: [number, number] | null) => {
    zoomRef.current = domain
    redrawsRef.current.forEach(fn => fn())
  }, [])
  const registerRedraw = useCallback((fn: () => void) => {
    redrawsRef.current.add(fn)
    return () => { redrawsRef.current.delete(fn) }
  }, [])

  // ── Data fetch ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (selectedLapKeys.length === 0 || sessions.length === 0) { setLaps([]); setTraces({}); return }
    setLoading(true)

    const go = async () => {
      const gpsOut: LapGPS[] = []
      const tmap: Record<string, LapTrace[]> = { Speed: [], Throttle: [], Brake: [] }

      for (let ci = 0; ci < selectedLapKeys.length; ci++) {
        const key = selectedLapKeys[ci]
        const { sessionId, lapNumber } = parseLapKey(key)
        const sess = sessions.find(s => s.id === sessionId)
        if (!sess) continue
        const avail = new Set(sess.available_channels.map(c => c.name))

        if (avail.has('Lat') && avail.has('Lon')) {
          try {
            const [latR, lonR] = await Promise.all([
              invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNumber], channel: 'Lat' }),
              invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNumber], channel: 'Lon' }),
            ])
            if (latR[0] && lonR[0])
              gpsOut.push({ lapKey: key, lapNumber, colorIndex: ci,
                lat: latR[0].samples, lon: lonR[0].samples, timestamps: latR[0].timestamps })
          } catch { /* no GPS */ }
        }

        for (const { ch, xform } of TELE_CHANNELS) {
          if (!avail.has(ch)) continue
          try {
            const res = await invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNumber], channel: ch })
            const d = res[0]
            if (d) tmap[ch].push({ lapNumber, colorIndex: ci, samples: d.samples.map(xform), timestamps: d.timestamps, lapDistPct: d.lap_dist_pct })
          } catch { /* skip */ }
        }
      }

      setLaps(gpsOut)
      setTraces(tmap)
      setLoading(false)
      setVb(INITIAL_VB)
      zoomRef.current = null
      redrawsRef.current.forEach(fn => fn())
    }

    go()
  }, [selectedLapKeys.join(','), sessions.length])

  // ── Memoised SVG geometry — only rebuilds when laps change, NOT on zoom/pan ──

  const tf = useMemo(() => {
    if (laps.length === 0) return null
    const allLats: number[] = [], allLons: number[] = []
    for (const lap of laps) { for (const v of lap.lat) allLats.push(v); for (const v of lap.lon) allLons.push(v) }
    if (allLats.length === 0) return null
    return computeTransform(allLats, allLons)
  }, [laps])

  const polylines = useMemo(() => {
    if (!tf || laps.length === 0) return null
    return {
      base: buildPolyline(laps[0].lat, laps[0].lon, tf, 4),
      laps: laps.map(lap => ({ key: lap.lapKey, pts: buildPolyline(lap.lat, lap.lon, tf, 4), color: getLapColor(lap.colorIndex) })),
      start: laps[0].lat.length > 0 ? project(laps[0].lat[0], laps[0].lon[0], tf) : null,
    }
  }, [laps, tf])

  // Track position dot — follows telemetry crosshair
  const trackDots = useMemo(() => {
    if (crosshairTime === null || !tf) return []
    return laps.flatMap(lap => {
      if (!lap.timestamps.length || !lap.lat.length) return []
      const i = Math.min(nearestTimeIdx(lap.timestamps, crosshairTime), lap.lat.length - 1)
      return [{ pt: project(lap.lat[i], lap.lon[i], tf), color: getLapColor(lap.colorIndex) }]
    })
  }, [crosshairTime, laps, tf])

  // ── Zoom / pan ─────────────────────────────────────────────────────────────

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    setVb(prev => {
      const factor = e.deltaY > 0 ? 1.22 : 1 / 1.22
      const mx = prev.x + (e.clientX - rect.left) / rect.width * prev.w
      const my = prev.y + (e.clientY - rect.top) / rect.height * prev.h
      if (!isFinite(mx) || !isFinite(my)) return prev
      const nw = Math.min(SIZE, Math.max(30, prev.w * factor))
      const nh = Math.min(SIZE, Math.max(30, prev.h * factor))
      const nx = Math.max(0, Math.min(SIZE - nw, mx - (mx - prev.x) / prev.w * nw))
      const ny = Math.max(0, Math.min(SIZE - nh, my - (my - prev.y) / prev.h * nh))
      return isFinite(nx) && isFinite(ny) ? { x: nx, y: ny, w: nw, h: nh } : prev
    })
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  const onMouseDown = (e: React.MouseEvent) => {
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: vb.x, oy: vb.y }
  }
  const onMouseMove = (e: React.MouseEvent) => {
    const drag = dragRef.current
    if (!drag || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const dx = (e.clientX - drag.sx) / rect.width * vb.w
    const dy = (e.clientY - drag.sy) / rect.height * vb.h
    if (!isFinite(dx) || !isFinite(dy)) return
    // Capture ox/oy into closure BEFORE setVb — dragRef may be null when updater runs
    const ox = drag.ox, oy = drag.oy
    setVb(prev => ({
      ...prev,
      x: Math.max(0, Math.min(SIZE - prev.w, ox - dx)),
      y: Math.max(0, Math.min(SIZE - prev.h, oy - dy)),
    }))
  }
  const onMouseUp = () => { dragRef.current = null }

  const isZoomed  = vb.w < SIZE * 0.99
  const gScale    = SIZE / vb.w
  const gTransform = `scale(${gScale.toFixed(6)}) translate(${(-vb.x).toFixed(4)} ${(-vb.y).toFixed(4)})`

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 overflow-hidden flex min-h-0 bg-background">

      {/* ── Left column: track map, full height, no padding ────────────────── */}
      <div className="flex flex-col border-r border-border bg-card" style={{ width: '40%', minWidth: 160 }}>

        {/* Header bar */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
          <span className="text-[11px] font-semibold text-foreground">Track Map</span>
          <div className="flex items-center gap-3">
            {laps.map(l => (
              <span key={l.lapKey} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="inline-block w-4 h-1 rounded-full" style={{ background: getLapColor(l.colorIndex) }} />
                L{l.lapNumber}
              </span>
            ))}
            {isZoomed && (
              <button onClick={() => setVb(INITIAL_VB)}
                className="text-[10px] border border-border rounded px-2 py-0.5 text-muted-foreground hover:text-foreground transition-colors">
                Reset
              </button>
            )}
          </div>
        </div>

        {/* Map — fills all remaining height */}
        <div ref={containerRef} className="flex-1 relative min-h-0"
          style={{ cursor: dragRef.current ? 'grabbing' : 'grab' }}>

          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-sm text-muted-foreground">Loading…</p>
            </div>
          ) : laps.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
              <p className="text-sm text-muted-foreground">Select laps with GPS data</p>
            </div>
          ) : polylines ? (
            <svg ref={svgRef} viewBox="0 0 1000 1000"
              className="absolute inset-0 w-full h-full" overflow="hidden"
              onMouseDown={onMouseDown} onMouseMove={onMouseMove}
              onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
              onDoubleClick={() => setVb(INITIAL_VB)}>
              <g transform={gTransform}>
                <polyline points={polylines.base} fill="none"
                  stroke="rgba(150,150,150,0.18)" strokeWidth={16}
                  strokeLinecap="round" strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke" />
                {polylines.laps.map(({ key, pts, color }) => (
                  <polyline key={key} points={pts} fill="none"
                    stroke={color} strokeWidth={4} opacity={0.9}
                    strokeLinecap="round" strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke" />
                ))}
                {polylines.start && (
                  <circle cx={polylines.start.x} cy={polylines.start.y} r={8}
                    fill="white" stroke={getLapColor(0)} strokeWidth={3}
                    vectorEffect="non-scaling-stroke" />
                )}
                {trackDots.map(({ pt, color }, i) => (
                  <g key={i}>
                    <circle cx={pt.x} cy={pt.y} r={12}
                      fill="white" opacity={0.65} strokeWidth={0}
                      vectorEffect="non-scaling-stroke" />
                    <circle cx={pt.x} cy={pt.y} r={8}
                      fill={color} stroke="white" strokeWidth={3}
                      vectorEffect="non-scaling-stroke" />
                  </g>
                ))}
              </g>
            </svg>
          ) : null}
        </div>

        {/* Zoom hint */}
        <div className="border-t border-border text-center py-1 shrink-0">
          <span className="text-[9px] text-muted-foreground/35">
            Scroll to zoom · Drag to pan · Double-click to reset
          </span>
        </div>
      </div>

      {/* ── Right column: telemetry channels, no gap, border dividers ──────── */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-y-auto divide-y divide-border">
        {loading || selectedLapKeys.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">
              {loading ? 'Loading…' : 'Select laps to compare'}
            </p>
          </div>
        ) : TELE_CHANNELS.map(({ ch, unit, domain }) => {
          const lapTraces = traces[ch] ?? []
          if (!lapTraces.length) return null
          return (
            <div key={ch} className="bg-card shrink-0">
              <TraceChart
                channel={ch} unit={unit} yDomain={domain}
                traces={lapTraces}
                crosshairTime={crosshairTime} onMouseMove={setCrosshairTime}
                zoomRef={zoomRef} onZoom={handleZoom} registerRedraw={registerRedraw}
                height={128}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
