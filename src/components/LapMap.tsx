import { useEffect, useState, useRef, useCallback } from 'react'
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
}

interface ViewBox { x: number; y: number; w: number; h: number }

const SIZE = 1000
const INITIAL_VB: ViewBox = { x: 0, y: 0, w: SIZE, h: SIZE }

function computeTransform(lats: number[], lons: number[]) {
  const minLat = Math.min(...lats), maxLat = Math.max(...lats)
  const minLon = Math.min(...lons), maxLon = Math.max(...lons)
  const latR = maxLat - minLat || 1e-6
  const lonR = maxLon - minLon || 1e-6
  const scale = Math.min(SIZE / lonR, SIZE / latR) * 0.9
  return {
    minLat, minLon, scale,
    ox: (SIZE - lonR * scale) / 2,
    oy: (SIZE - latR * scale) / 2,
  }
}

function project(lat: number, lon: number, tf: ReturnType<typeof computeTransform>) {
  return {
    x: (lon - tf.minLon) * tf.scale + tf.ox,
    y: SIZE - (lat - tf.minLat) * tf.scale - tf.oy,
  }
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

const TELE_CHANNELS = [
  { ch: 'Speed',    unit: 'km/h', domain: [0, 'auto'] as [number | 'auto', number | 'auto'], transform: (v: number) => v * 3.6 },
  { ch: 'Throttle', unit: '%',    domain: [0, 100]    as [number | 'auto', number | 'auto'], transform: (v: number) => v * 100 },
  { ch: 'Brake',    unit: '%',    domain: [0, 100]    as [number | 'auto', number | 'auto'], transform: (v: number) => v * 100 },
]

export default function LapMap() {
  const { sessions, selectedLapKeys } = useSessionStore()
  const [laps, setLaps] = useState<LapGPS[]>([])
  const [traces, setTraces] = useState<Record<string, LapTrace[]>>({})
  const [loading, setLoading] = useState(false)

  // Map zoom/pan state
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [vb, setVb] = useState<ViewBox>(INITIAL_VB)
  const vbRef = useRef(vb)
  vbRef.current = vb
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)

  // Telemetry chart sync
  const zoomRef = useRef<[number, number] | null>(null)
  const redrawsRef = useRef(new Set<() => void>())
  const [crosshairTime, setCrosshairTime] = useState<number | null>(null)
  const handleZoom = useCallback((domain: [number, number] | null) => {
    zoomRef.current = domain
    redrawsRef.current.forEach(fn => fn())
  }, [])
  const registerRedraw = useCallback((fn: () => void) => {
    redrawsRef.current.add(fn)
    return () => { redrawsRef.current.delete(fn) }
  }, [])

  // Fetch GPS + telemetry for all selected laps
  useEffect(() => {
    if (selectedLapKeys.length === 0 || sessions.length === 0) {
      setLaps([]); setTraces({}); return
    }
    setLoading(true)

    const fetchAll = async () => {
      const gpsResults: LapGPS[] = []
      const traceMap: Record<string, LapTrace[]> = { Speed: [], Throttle: [], Brake: [] }

      for (let ci = 0; ci < selectedLapKeys.length; ci++) {
        const key = selectedLapKeys[ci]
        const { sessionId, lapNumber } = parseLapKey(key)
        const sess = sessions.find(s => s.id === sessionId)
        if (!sess) continue
        const avail = new Set(sess.available_channels.map(c => c.name))

        // GPS
        if (avail.has('Lat') && avail.has('Lon')) {
          try {
            const [latR, lonR] = await Promise.all([
              invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNumber], channel: 'Lat' }),
              invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNumber], channel: 'Lon' }),
            ])
            if (latR[0] && lonR[0])
              gpsResults.push({ lapKey: key, lapNumber, colorIndex: ci, lat: latR[0].samples, lon: lonR[0].samples })
          } catch { /* no GPS */ }
        }

        // Telemetry channels
        for (const { ch, transform } of TELE_CHANNELS) {
          if (!avail.has(ch)) continue
          try {
            const res = await invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNumber], channel: ch })
            const d = res[0]
            if (d) {
              traceMap[ch].push({
                lapNumber,
                colorIndex: ci,
                samples: d.samples.map(transform),
                timestamps: d.timestamps,
                lapDistPct: d.lap_dist_pct,
              })
            }
          } catch { /* skip */ }
        }
      }

      setLaps(gpsResults)
      setTraces(traceMap)
      setLoading(false)
      setVb(INITIAL_VB)
      zoomRef.current = null
      redrawsRef.current.forEach(fn => fn())
    }

    fetchAll()
  }, [selectedLapKeys.join(','), sessions.length])

  // Wheel zoom — attached to container div (always in DOM, avoids conditional SVG ref)
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    if (!rect.width || !rect.height) return   // guard against 0-size during layout
    setVb(prev => {
      const factor = e.deltaY > 0 ? 1.22 : 1 / 1.22
      const mx = prev.x + (e.clientX - rect.left) / rect.width * prev.w
      const my = prev.y + (e.clientY - rect.top) / rect.height * prev.h
      if (!isFinite(mx) || !isFinite(my)) return prev    // NaN guard
      const newW = Math.min(SIZE, Math.max(30, prev.w * factor))
      const newH = Math.min(SIZE, Math.max(30, prev.h * factor))
      const nx = Math.max(0, Math.min(SIZE - newW, mx - (mx - prev.x) / prev.w * newW))
      const ny = Math.max(0, Math.min(SIZE - newH, my - (my - prev.y) / prev.h * newH))
      if (!isFinite(nx) || !isFinite(ny)) return prev    // NaN guard
      return { x: nx, y: ny, w: newW, h: newH }
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
    if (!dragRef.current || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const dx = (e.clientX - dragRef.current.sx) / rect.width * vb.w
    const dy = (e.clientY - dragRef.current.sy) / rect.height * vb.h
    if (!isFinite(dx) || !isFinite(dy)) return
    setVb(prev => ({
      ...prev,
      x: Math.max(0, Math.min(SIZE - prev.w, dragRef.current!.ox - dx)),
      y: Math.max(0, Math.min(SIZE - prev.h, dragRef.current!.oy - dy)),
    }))
  }
  const onMouseUp = () => { dragRef.current = null }

  const allLats = laps.flatMap(l => l.lat)
  const allLons = laps.flatMap(l => l.lon)
  const tf = allLats.length > 0 ? computeTransform(allLats, allLons) : null
  const isZoomed = vb.w < SIZE * 0.99
  // SVG viewBox is ALWAYS "0 0 1000 1000". Pan/zoom is applied via <g transform>.
  // This avoids WebView compositor issues when viewBox values change rapidly.
  const gScale = SIZE / vb.w
  const gTransform = `scale(${gScale.toFixed(6)}) translate(${(-vb.x).toFixed(4)} ${(-vb.y).toFixed(4)})`

  return (
    <div className="flex-1 overflow-hidden flex gap-3 p-4 bg-background min-h-0">

      {/* ── Track map (left) ───────────────────────────────── */}
      <div className="flex flex-col bg-card rounded-xl border border-border shadow-sm" style={{ width: '44%', minWidth: 180 }}>
        <div className="flex items-center justify-between px-3 pt-3 pb-2 shrink-0">
          <h3 className="text-xs font-semibold text-foreground">Track Map</h3>
          <div className="flex items-center gap-3">
            {laps.map(l => (
              <span key={l.lapKey} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="inline-block w-5 h-1.5 rounded-full" style={{ background: getLapColor(l.colorIndex) }} />
                L{l.lapNumber}
              </span>
            ))}
            {isZoomed && (
              <button
                onClick={() => setVb(INITIAL_VB)}
                className="text-[10px] border border-border rounded px-2 py-0.5 text-muted-foreground hover:text-foreground transition-colors"
              >
                Reset
              </button>
            )}
          </div>
        </div>

        <div
          ref={containerRef}
          className="flex-1 relative"
          style={{ cursor: dragRef.current ? 'grabbing' : 'grab' }}
        >
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-sm text-muted-foreground">Loading…</p>
            </div>
          ) : laps.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center px-4 text-center">
              <p className="text-sm text-muted-foreground">Select laps with GPS data</p>
            </div>
          ) : tf ? (
            <svg
              ref={svgRef}
              viewBox="0 0 1000 1000"
              className="absolute inset-0 w-full h-full"
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
              onDoubleClick={() => setVb(INITIAL_VB)}
            >
              {/* All content lives inside one <g> that handles pan/zoom.
                  viewBox stays "0 0 1000 1000" forever — changing it rapidly
                  causes WebView compositor corruption (blank screen). */}
              <g transform={gTransform}>
                {/* Grey track base */}
                <polyline
                  points={buildPolyline(laps[0].lat, laps[0].lon, tf, 4)}
                  fill="none"
                  stroke="rgba(130,130,130,0.22)"
                  strokeWidth={16}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
                {/* Racing lines per lap */}
                {laps.map(lap => (
                  <polyline
                    key={lap.lapKey}
                    points={buildPolyline(lap.lat, lap.lon, tf, 4)}
                    fill="none"
                    stroke={getLapColor(lap.colorIndex)}
                    strokeWidth={4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={0.88}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                {/* Start/finish dot */}
                {(() => {
                  const l = laps[0]
                  if (!l.lat.length) return null
                  const p = project(l.lat[0], l.lon[0], tf)
                  return (
                    <circle cx={p.x} cy={p.y} r={8}
                      fill="white" stroke={getLapColor(0)} strokeWidth={3}
                      vectorEffect="non-scaling-stroke" />
                  )
                })()}
              </g>
            </svg>
          ) : null}
        </div>

        {!loading && laps.length > 0 && (
          <p className="text-[9px] text-muted-foreground/35 text-center py-1 shrink-0">
            Scroll to zoom · Drag to pan · Double-click to reset
          </p>
        )}
      </div>

      {/* ── Telemetry charts (right) ───────────────────────── */}
      <div className="flex-1 flex flex-col gap-2 overflow-y-auto min-w-0">
        {loading ? (
          <div className="flex-1 flex items-center justify-center bg-card rounded-xl border border-border shadow-sm">
            <p className="text-sm text-muted-foreground">Loading…</p>
          </div>
        ) : selectedLapKeys.length === 0 ? (
          <div className="flex-1 flex items-center justify-center bg-card rounded-xl border border-border shadow-sm">
            <p className="text-sm text-muted-foreground">Select laps to compare</p>
          </div>
        ) : (
          TELE_CHANNELS.map(({ ch, unit, domain }) => {
            const ch_traces = traces[ch] ?? []
            if (ch_traces.length === 0) return null
            return (
              <div key={ch} className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
                <TraceChart
                  channel={ch}
                  unit={unit}
                  yDomain={domain}
                  traces={ch_traces}
                  crosshairTime={crosshairTime}
                  onMouseMove={setCrosshairTime}
                  zoomRef={zoomRef}
                  onZoom={handleZoom}
                  registerRedraw={registerRedraw}
                  height={140}
                />
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
