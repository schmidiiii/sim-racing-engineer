import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, parseLapKey, getLapColor } from '@/store/session'
import TrackMap from '@/components/TrackMap'

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
  timestamps: number[]
}

interface ViewBox { x: number; y: number; w: number; h: number }

const SIZE = 1000
const INITIAL_VB: ViewBox = { x: 0, y: 0, w: SIZE, h: SIZE }
const COLLAPSED_H = 200
const EXPANDED_H = 380

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

function nearestTimeIdx(timestamps: number[], target: number): number {
  let lo = 0, hi = timestamps.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (timestamps[mid] < target) lo = mid + 1; else hi = mid
  }
  if (lo > 0 && Math.abs(timestamps[lo - 1] - target) < Math.abs(timestamps[lo] - target)) lo--
  return lo
}

type ActiveTab = 'traces' | 'map'

export default function SidebarTrackMap() {
  const { sessions, selectedLapKeys, crosshairTime } = useSessionStore()
  const [activeTab, setActiveTab] = useState<ActiveTab>('traces')
  const [expanded, setExpanded] = useState(false)
  const [laps, setLaps] = useState<LapGPS[]>([])
  const [loading, setLoading] = useState(false)

  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [vb, setVb] = useState<ViewBox>(INITIAL_VB)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)

  // ── GPS data fetch ────────────────────────────────────────────────────────
  useEffect(() => {
    if (selectedLapKeys.length === 0 || sessions.length === 0) { setLaps([]); return }
    setLoading(true)
    const go = async () => {
      const out: LapGPS[] = []
      for (let ci = 0; ci < selectedLapKeys.length; ci++) {
        const key = selectedLapKeys[ci]
        const { sessionId, lapNumber } = parseLapKey(key)
        const sess = sessions.find(s => s.id === sessionId)
        if (!sess) continue
        const avail = new Set(sess.available_channels.map(c => c.name))
        if (!avail.has('Lat') || !avail.has('Lon')) continue
        try {
          const [latR, lonR] = await Promise.all([
            invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNumber], channel: 'Lat' }),
            invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNumber], channel: 'Lon' }),
          ])
          if (latR[0] && lonR[0])
            out.push({ lapKey: key, lapNumber, colorIndex: ci, lat: latR[0].samples, lon: lonR[0].samples, timestamps: latR[0].timestamps })
        } catch { /* no GPS */ }
      }
      setLaps(out)
      setLoading(false)
    }
    go()
  }, [selectedLapKeys.join(','), sessions.length])

  // ── SVG geometry — only rebuilds when laps change ─────────────────────────
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

  const trackDot = useMemo(() => {
    if (crosshairTime == null || !tf || laps.length === 0) return null
    const lap = laps[0]
    if (!lap.timestamps.length || !lap.lat.length) return null
    const i = Math.min(nearestTimeIdx(lap.timestamps, crosshairTime), lap.lat.length - 1)
    return { pt: project(lap.lat[i], lap.lon[i], tf), color: getLapColor(lap.colorIndex) }
  }, [crosshairTime, laps, tf])

  const fitVb = useMemo((): ViewBox => {
    if (!tf) return INITIAL_VB
    const minPad = Math.min(tf.ox, tf.oy)
    const dim = SIZE - 2 * minPad
    const cx = SIZE / 2
    return { x: cx - dim / 2, y: cx - dim / 2, w: dim, h: dim }
  }, [tf])

  const fitVbRef = useRef<ViewBox>(INITIAL_VB)
  useEffect(() => { fitVbRef.current = fitVb }, [fitVb])
  useEffect(() => { setVb(fitVb) }, [fitVb])

  // ── Zoom / pan ────────────────────────────────────────────────────────────
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    setVb(prev => {
      const fvb = fitVbRef.current
      const factor = e.deltaY > 0 ? 1.22 : 1 / 1.22
      const mx = prev.x + (e.clientX - rect.left) / rect.width * prev.w
      const my = prev.y + (e.clientY - rect.top) / rect.height * prev.h
      if (!isFinite(mx) || !isFinite(my)) return prev
      const nw = Math.min(fvb.w, Math.max(30, prev.w * factor))
      const nh = Math.min(fvb.h, Math.max(30, prev.h * factor))
      const nx = Math.max(fvb.x, Math.min(fvb.x + fvb.w - nw, mx - (mx - prev.x) / prev.w * nw))
      const ny = Math.max(fvb.y, Math.min(fvb.y + fvb.h - nh, my - (my - prev.y) / prev.h * nh))
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
    const fvb = fitVbRef.current
    setVb(prev => ({
      ...prev,
      x: Math.max(fvb.x, Math.min(fvb.x + fvb.w - prev.w, drag.ox - dx)),
      y: Math.max(fvb.y, Math.min(fvb.y + fvb.h - prev.h, drag.oy - dy)),
    }))
  }
  const onMouseUp = () => { dragRef.current = null }

  const isZoomed = vb.w < fitVb.w * 0.99
  const gScale = SIZE / vb.w
  const gTransform = `scale(${gScale.toFixed(6)}) translate(${(-vb.x).toFixed(4)} ${(-vb.y).toFixed(4)})`
  const mapH = expanded ? EXPANDED_H : COLLAPSED_H

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="shrink-0 border-t border-border">

      {/* Header: tabs + legend + expand toggle */}
      <div className="flex items-center px-2 pt-1.5 pb-0.5 gap-1">
        <button
          onClick={() => setActiveTab('traces')}
          className={`px-2 py-0.5 text-[10px] font-semibold rounded transition-colors ${
            activeTab === 'traces'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
          }`}
        >
          Traces
        </button>
        <button
          onClick={() => setActiveTab('map')}
          className={`px-2 py-0.5 text-[10px] font-semibold rounded transition-colors ${
            activeTab === 'map'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
          }`}
        >
          Map
        </button>

        <div className="flex-1" />

        {activeTab === 'traces' && laps.length > 0 && (
          <div className="flex items-center gap-2 mr-1.5">
            {laps.map(l => (
              <span key={l.lapKey} className="flex items-center gap-1 text-[9px] text-muted-foreground">
                <span className="inline-block w-3 h-1 rounded-full" style={{ background: getLapColor(l.colorIndex) }} />
                L{l.lapNumber}
              </span>
            ))}
          </div>
        )}

        <button
          onClick={() => setExpanded(v => !v)}
          className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
          title={expanded ? 'Collapse map' : 'Expand map'}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            {expanded
              ? <path d="M1 7l4-4 4 4" />
              : <path d="M1 3l4 4 4-4" />
            }
          </svg>
        </button>
      </div>

      {/* Map body */}
      <div style={{ height: mapH }} className="overflow-hidden transition-[height] duration-200">

        {activeTab === 'map' ? (
          <TrackMap />
        ) : (
          /* Traces tab */
          <div
            ref={containerRef}
            className="relative w-full h-full"
            style={{ cursor: dragRef.current ? 'grabbing' : 'grab' }}
          >
            {loading ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-xs text-muted-foreground">Loading…</p>
              </div>
            ) : laps.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center px-4 text-center">
                <p className="text-xs text-muted-foreground">Select laps with GPS data</p>
              </div>
            ) : polylines ? (
              <>
                <svg
                  ref={svgRef}
                  viewBox="0 0 1000 1000"
                  className="absolute inset-0 w-full h-full"
                  overflow="hidden"
                  onMouseDown={onMouseDown}
                  onMouseMove={onMouseMove}
                  onMouseUp={onMouseUp}
                  onMouseLeave={onMouseUp}
                  onDoubleClick={() => setVb(fitVb)}
                >
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
                      <circle cx={polylines.start.x} cy={polylines.start.y} r={8 / gScale}
                        fill="white" stroke={getLapColor(0)} strokeWidth={3}
                        vectorEffect="non-scaling-stroke" />
                    )}
                    {trackDot && (
                      <g>
                        <circle cx={trackDot.pt.x} cy={trackDot.pt.y} r={12 / gScale}
                          fill="white" opacity={0.65} strokeWidth={0}
                          vectorEffect="non-scaling-stroke" />
                        <circle cx={trackDot.pt.x} cy={trackDot.pt.y} r={8 / gScale}
                          fill={trackDot.color} stroke="white" strokeWidth={3}
                          vectorEffect="non-scaling-stroke" />
                      </g>
                    )}
                  </g>
                </svg>

                {isZoomed && (
                  <>
                    {/* Minimap */}
                    <div
                      className="absolute bottom-2 right-2 pointer-events-none rounded border border-border bg-card shadow-md overflow-hidden"
                      style={{ width: 80, height: 80 }}
                    >
                      <svg viewBox={`${fitVb.x} ${fitVb.y} ${fitVb.w} ${fitVb.h}`} className="w-full h-full">
                        {polylines.laps.slice(0, 1).map(({ key, pts }) => (
                          <polyline key={key} points={pts} fill="none"
                            stroke="currentColor" strokeWidth={2} opacity={0.5}
                            strokeLinecap="round" strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke" />
                        ))}
                        <rect x={vb.x} y={vb.y} width={vb.w} height={vb.h}
                          fill="currentColor" fillOpacity={0.05}
                          stroke="currentColor" strokeWidth={2} strokeOpacity={0.45}
                          strokeDasharray="8 5"
                          vectorEffect="non-scaling-stroke" />
                      </svg>
                    </div>
                    {/* Reset button */}
                    <button
                      className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[9px] border border-border rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground bg-card transition-colors"
                      onClick={() => setVb(fitVb)}
                    >
                      Reset
                    </button>
                  </>
                )}
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
