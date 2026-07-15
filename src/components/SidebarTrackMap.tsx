import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, parseLapKey, getLapColor } from '@/store/session'
import TrackMap, { type MapChannel } from '@/components/TrackMap'

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

type ActiveView = 'traces' | MapChannel

const MAP_CHANNELS: MapChannel[] = ['Speed', 'Throttle', 'Brake', 'Gear']

export default function SidebarTrackMap() {
  const { sessions, selectedLapKeys, crosshairTime, zoomDomain, sidebarMapExpanded, setSidebarMapExpanded } = useSessionStore()
  const [activeView, setActiveView] = useState<ActiveView>('traces')
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

  // ── SVG geometry ──────────────────────────────────────────────────────────
  const tf = useMemo(() => {
    if (laps.length === 0) return null
    const allLats: number[] = [], allLons: number[] = []
    for (const lap of laps) { for (const v of lap.lat) allLats.push(v); for (const v of lap.lon) allLons.push(v) }
    if (allLats.length === 0) return null
    return computeTransform(allLats, allLons)
  }, [laps])

  const polylines = useMemo(() => {
    if (!tf || laps.length === 0) return null
    const lap0 = laps[0]
    const startPt = lap0.lat.length > 0 ? project(lap0.lat[0], lap0.lon[0], tf) : null

    // Compute start/finish line perpendicular to the track direction
    let startLine: { x1: number; y1: number; x2: number; y2: number } | null = null
    if (startPt && lap0.lat.length > 8) {
      const ahead = project(lap0.lat[8], lap0.lon[8], tf)
      const dx = ahead.x - startPt.x
      const dy = ahead.y - startPt.y
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      // Perpendicular unit vector
      const px = -dy / len
      const py = dx / len
      const half = 22  // half-length in SVG units
      startLine = { x1: startPt.x + px * half, y1: startPt.y + py * half, x2: startPt.x - px * half, y2: startPt.y - py * half }
    }

    return {
      base: buildPolyline(lap0.lat, lap0.lon, tf, 4),
      laps: laps.map(lap => ({ key: lap.lapKey, pts: buildPolyline(lap.lat, lap.lon, tf, 4), color: getLapColor(lap.colorIndex) })),
      startLine,
    }
  }, [laps, tf])

  const trackDots = useMemo(() => {
    if (crosshairTime == null || !tf || laps.length === 0) return []
    return laps.flatMap(lap => {
      if (!lap.timestamps.length || !lap.lat.length) return []
      const i = Math.min(nearestTimeIdx(lap.timestamps, crosshairTime), lap.lat.length - 1)
      return [{ pt: project(lap.lat[i], lap.lon[i], tf), color: getLapColor(lap.colorIndex) }]
    })
  }, [crosshairTime, laps, tf])

  const zoomedSegments = useMemo(() => {
    if (!zoomDomain || !tf || laps.length === 0) return null
    const [tLo, tHi] = zoomDomain
    return laps.map(lap => {
      if (!lap.timestamps.length || !lap.lat.length) return null
      let lo = 0, hi = lap.timestamps.length - 1
      while (lo < hi) { const m = (lo + hi) >> 1; if (lap.timestamps[m] < tLo) lo = m + 1; else hi = m }
      const startIdx = lo
      lo = 0; hi = lap.timestamps.length - 1
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lap.timestamps[m] > tHi) hi = m - 1; else lo = m }
      const endIdx = lo
      if (startIdx >= endIdx) return null
      const pts: string[] = []
      for (let i = startIdx; i <= endIdx; i += 2) {
        if (i >= lap.lat.length) break
        const p = project(lap.lat[i], lap.lon[i], tf)
        pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      }
      if (pts.length < 2) return null
      return { key: lap.lapKey, pts: pts.join(' '), color: getLapColor(lap.colorIndex) }
    }).filter(Boolean) as { key: string; pts: string; color: string }[]
  }, [zoomDomain, laps, tf])

  const fitVb = useMemo((): ViewBox => {
    return INITIAL_VB
  }, [])

  const fitVbRef = useRef<ViewBox>(INITIAL_VB)
  useEffect(() => { fitVbRef.current = fitVb }, [fitVb])
  useEffect(() => { setVb(fitVb) }, [fitVb])

  // Auto-pan: keep crosshair dot centred when map is zoomed
  useEffect(() => {
    if (crosshairTime == null || !tf || laps.length === 0 || dragRef.current) return
    const fvb = fitVbRef.current
    setVb(prev => {
      if (prev.w >= fvb.w * 0.99) return prev
      const lap = laps[0]
      if (!lap.timestamps.length) return prev
      const i = Math.min(nearestTimeIdx(lap.timestamps, crosshairTime), lap.lat.length - 1)
      const pt = project(lap.lat[i], lap.lon[i], tf)
      const nx = Math.max(fvb.x, Math.min(fvb.x + fvb.w - prev.w, pt.x - prev.w / 2))
      const ny = Math.max(fvb.y, Math.min(fvb.y + fvb.h - prev.h, pt.y - prev.h / 2))
      return { ...prev, x: nx, y: ny }
    })
  }, [crosshairTime, tf, laps])

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
  })

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

  // Stroke widths: thinner in the small collapsed map, slightly thicker when expanded
  const sw = sidebarMapExpanded
    ? { base: 10, trace: 3, zoomed: 5 }
    : { base: 7, trace: 3.5, zoomed: 4.5 }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={`border-t border-border${sidebarMapExpanded ? ' flex-1 min-h-0 flex flex-col' : ' shrink-0'}`}>

      {/* Header: view selector + legend + expand toggle */}
      <div className="flex items-center px-2 pt-1.5 pb-0.5 gap-1 min-w-0">
        {/* Scrollable tabs — so they never push the expand button off-screen */}
        <div className="flex items-center gap-1 overflow-x-auto min-w-0 flex-1" style={{ scrollbarWidth: 'none' }}>
          {(['traces', ...MAP_CHANNELS] as ActiveView[]).map(view => (
            <button
              key={view}
              onClick={() => setActiveView(view)}
              className={`shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded transition-colors ${
                activeView === view
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              }`}
            >
              {view === 'traces' ? 'Traces' : view}
            </button>
          ))}
        </div>

      </div>

      {/* Map body */}
      <div
        style={!sidebarMapExpanded ? { height: COLLAPSED_H } : undefined}
        className={`overflow-hidden relative${sidebarMapExpanded ? ' flex-1 min-h-0' : ''}`}
      >
        {activeView !== 'traces' ? (
          <div className="absolute inset-0">
            <TrackMap channel={activeView} />
          </div>
        ) : (
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
                      stroke="rgba(130,130,130,0.45)" strokeWidth={sw.base / gScale}
                      strokeLinecap="round" strokeLinejoin="round" />
                    {polylines.laps.map(({ key, pts, color }) => (
                      <polyline key={key} points={pts} fill="none"
                        stroke={color} strokeWidth={sw.trace / gScale} opacity={zoomedSegments?.length ? 0.22 : 0.9}
                        strokeLinecap="round" strokeLinejoin="round" />
                    ))}
                    {zoomedSegments?.map(seg => (
                      <polyline key={`${seg.key}_zoom`} points={seg.pts}
                        fill="none" stroke={seg.color} strokeWidth={sw.zoomed / gScale} opacity={1}
                        strokeLinecap="round" strokeLinejoin="round" />
                    ))}
                    {polylines.startLine && (
                      <>
                        {/* Shadow */}
                        <line x1={polylines.startLine.x1} y1={polylines.startLine.y1}
                          x2={polylines.startLine.x2} y2={polylines.startLine.y2}
                          stroke="rgba(0,0,0,0.5)" strokeWidth={10 / gScale} strokeLinecap="butt" />
                        {/* White base */}
                        <line x1={polylines.startLine.x1} y1={polylines.startLine.y1}
                          x2={polylines.startLine.x2} y2={polylines.startLine.y2}
                          stroke="white" strokeWidth={7 / gScale} strokeLinecap="butt" />
                        {/* Black dashes → checkered flag pattern */}
                        <line x1={polylines.startLine.x1} y1={polylines.startLine.y1}
                          x2={polylines.startLine.x2} y2={polylines.startLine.y2}
                          stroke="black" strokeWidth={7 / gScale} strokeLinecap="butt"
                          strokeDasharray={`${6 / gScale} ${6 / gScale}`} />
                      </>
                    )}
                    {trackDots.map(({ pt, color }, i) => (
                      <g key={i}>
                        <circle cx={pt.x} cy={pt.y} r={12 / gScale}
                          fill="white" opacity={0.65} strokeWidth={0}
                          vectorEffect="non-scaling-stroke" />
                        <circle cx={pt.x} cy={pt.y} r={8 / gScale}
                          fill={color} stroke="white" strokeWidth={3}
                          vectorEffect="non-scaling-stroke" />
                      </g>
                    ))}
                  </g>
                </svg>

                {/* Lap legend — bottom-left overlay */}
                {laps.length > 0 && (
                  <div className="absolute bottom-1.5 left-2 flex items-center gap-2 pointer-events-none">
                    {laps.map(l => (
                      <span key={l.lapKey} className="flex items-center gap-1 text-[9px] text-muted-foreground">
                        <span className="inline-block w-2.5 h-1 rounded-full" style={{ background: getLapColor(l.colorIndex) }} />
                        L{l.lapNumber}
                      </span>
                    ))}
                  </div>
                )}

                {isZoomed && (
                  <>
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

      {/* Expand/Collapse labeled button below map */}
      <button
        onClick={() => setSidebarMapExpanded(!sidebarMapExpanded)}
        className="shrink-0 w-full flex items-center justify-center gap-1.5 py-1.5 border-t border-border bg-card text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {sidebarMapExpanded ? <path d="M8 2L4 6l4 4" /> : <path d="M4 2l4 4-4 4" />}
        </svg>
        {sidebarMapExpanded ? 'Collapse Map' : 'Expand Map'}
      </button>
    </div>
  )
}
