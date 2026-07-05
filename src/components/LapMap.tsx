import { useEffect, useState, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, parseLapKey, getLapColor } from '@/store/session'

interface LapChannelData {
  lap_number: number
  channel: string
  samples: number[]
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

function computeTransform(lats: number[], lons: number[]) {
  const minLat = Math.min(...lats), maxLat = Math.max(...lats)
  const minLon = Math.min(...lons), maxLon = Math.max(...lons)
  const latR = maxLat - minLat || 1e-6
  const lonR = maxLon - minLon || 1e-6
  const scale = Math.min(SIZE / lonR, SIZE / latR) * 0.9
  const ox = (SIZE - lonR * scale) / 2
  const oy = (SIZE - latR * scale) / 2
  return { minLat, minLon, scale, ox, oy }
}

function project(lat: number, lon: number, tf: ReturnType<typeof computeTransform>) {
  return {
    x: (lon - tf.minLon) * tf.scale + tf.ox,
    y: SIZE - (lat - tf.minLat) * tf.scale - tf.oy,
  }
}

// Downsample GPS points for rendering (every Nth point)
function buildPolyline(lat: number[], lon: number[], tf: ReturnType<typeof computeTransform>, step: number) {
  const pts: string[] = []
  for (let i = 0; i < lat.length; i += step) {
    const p = project(lat[i], lon[i], tf)
    pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`)
  }
  // Close the loop
  if (lat.length > 0) {
    const p = project(lat[0], lon[0], tf)
    pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`)
  }
  return pts.join(' ')
}

const INITIAL_VB: ViewBox = { x: 0, y: 0, w: SIZE, h: SIZE }

export default function LapMap() {
  const { sessions, selectedLapKeys } = useSessionStore()
  const [laps, setLaps] = useState<LapGPS[]>([])
  const [loading, setLoading] = useState(false)
  const svgRef = useRef<SVGSVGElement>(null)
  const [vb, setVb] = useState<ViewBox>(INITIAL_VB)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)

  useEffect(() => {
    if (selectedLapKeys.length === 0 || sessions.length === 0) { setLaps([]); return }
    setLoading(true)

    const fetchAll = async () => {
      const results: LapGPS[] = []
      for (let ci = 0; ci < selectedLapKeys.length; ci++) {
        const key = selectedLapKeys[ci]
        const { sessionId, lapNumber } = parseLapKey(key)
        const sess = sessions.find(s => s.id === sessionId)
        if (!sess) continue
        const avail = new Set(sess.available_channels.map(c => c.name))
        if (!avail.has('Lat') || !avail.has('Lon')) continue
        try {
          const [latRes, lonRes] = await Promise.all([
            invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNumber], channel: 'Lat' }),
            invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNumber], channel: 'Lon' }),
          ])
          const latD = latRes[0], lonD = lonRes[0]
          if (!latD || !lonD) continue
          results.push({ lapKey: key, lapNumber, colorIndex: ci, lat: latD.samples, lon: lonD.samples })
        } catch { continue }
      }
      setLaps(results)
      setLoading(false)
      setVb(INITIAL_VB)
    }

    fetchAll()
  }, [selectedLapKeys.join(','), sessions.length])

  const allLats = laps.flatMap(l => l.lat)
  const allLons = laps.flatMap(l => l.lon)
  const tf = allLats.length > 0 ? computeTransform(allLats, allLons) : null

  // Zoom centred on cursor
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    if (!svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    setVb(prev => {
      const factor = e.deltaY > 0 ? 1.22 : 1 / 1.22
      const mx = prev.x + (e.clientX - rect.left) / rect.width * prev.w
      const my = prev.y + (e.clientY - rect.top) / rect.height * prev.h
      const newW = Math.min(SIZE, Math.max(30, prev.w * factor))
      const newH = Math.min(SIZE, Math.max(30, prev.h * factor))
      return {
        x: Math.max(0, Math.min(SIZE - newW, mx - (mx - prev.x) / prev.w * newW)),
        y: Math.max(0, Math.min(SIZE - newH, my - (my - prev.y) / prev.h * newH)),
        w: newW, h: newH,
      }
    })
  }, [])

  useEffect(() => {
    const el = svgRef.current
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
    const dx = (e.clientX - dragRef.current.sx) / rect.width * vb.w
    const dy = (e.clientY - dragRef.current.sy) / rect.height * vb.h
    setVb(prev => ({
      ...prev,
      x: Math.max(0, Math.min(SIZE - prev.w, dragRef.current!.ox - dx)),
      y: Math.max(0, Math.min(SIZE - prev.h, dragRef.current!.oy - dy)),
    }))
  }

  const onMouseUp = () => { dragRef.current = null }

  const isZoomed = vb.w < SIZE * 0.99

  // Adaptive stroke width: keep lines visually consistent regardless of zoom level
  const strokeW = (vb.w / SIZE) * 6

  // Downsample less when zoomed in (show detail)
  const step = Math.max(1, Math.floor(vb.w / SIZE * 5))

  return (
    <div className="flex-1 overflow-hidden p-4 flex flex-col gap-2 bg-background">
      <div className="bg-card rounded-xl border border-border shadow-sm flex flex-col flex-1 min-h-0 p-3">
        {/* Header */}
        <div className="flex items-center justify-between mb-2 shrink-0">
          <h3 className="text-xs font-semibold text-foreground">Track Map</h3>
          <div className="flex items-center gap-4">
            {laps.map(l => (
              <span key={l.lapKey} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="inline-block w-6 h-1.5 rounded-full" style={{ background: getLapColor(l.colorIndex) }} />
                L{l.lapNumber}
              </span>
            ))}
            {isZoomed && (
              <button
                onClick={() => setVb(INITIAL_VB)}
                className="text-[10px] border border-border rounded px-2 py-0.5 text-muted-foreground hover:text-foreground transition-colors"
              >
                Reset zoom
              </button>
            )}
          </div>
        </div>

        {/* Map */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">Loading GPS data…</p>
          </div>
        ) : laps.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">Select laps with GPS data to see the track map</p>
          </div>
        ) : tf ? (
          <svg
            ref={svgRef}
            viewBox={`${vb.x.toFixed(1)} ${vb.y.toFixed(1)} ${vb.w.toFixed(1)} ${vb.h.toFixed(1)}`}
            className="w-full flex-1"
            style={{ cursor: dragRef.current ? 'grabbing' : 'grab', userSelect: 'none' }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            onDoubleClick={() => setVb(INITIAL_VB)}
          >
            {/* Reference track outline (first lap, grey) */}
            <polyline
              points={buildPolyline(laps[0].lat, laps[0].lon, tf, step)}
              fill="none"
              stroke="rgba(120,120,120,0.25)"
              strokeWidth={strokeW * 2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {/* Each lap's racing line */}
            {laps.map(lap => (
              <polyline
                key={lap.lapKey}
                points={buildPolyline(lap.lat, lap.lon, tf, step)}
                fill="none"
                stroke={getLapColor(lap.colorIndex)}
                strokeWidth={strokeW}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.85}
              />
            ))}

            {/* Start/finish marker */}
            {(() => {
              const lap = laps[0]
              if (!lap.lat.length) return null
              const p = project(lap.lat[0], lap.lon[0], tf)
              const r = strokeW * 2.5
              return (
                <circle
                  cx={p.x} cy={p.y} r={r}
                  fill="white"
                  stroke={getLapColor(0)}
                  strokeWidth={strokeW * 0.6}
                />
              )
            })()}
          </svg>
        ) : null}

        {/* Zoom hint */}
        {!loading && laps.length > 0 && (
          <p className="text-[10px] text-muted-foreground/40 text-center mt-1 shrink-0">
            Scroll to zoom · Drag to pan · Double-click to reset
          </p>
        )}
      </div>
    </div>
  )
}
