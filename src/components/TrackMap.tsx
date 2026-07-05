import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, parseLapKey } from '@/store/session'
import { useT } from '@/lib/i18n'

interface LapChannelData {
  lap_number: number
  channel: string
  samples: number[]
  timestamps: number[]
  lap_dist_pct: number[]
}

interface Point {
  x: number
  y: number
  value: number
  timestamp: number
  lapDist: number
}

interface Transform {
  minLat: number
  minLon: number
  scale: number
  ox: number
  oy: number
}

type MapChannel = 'Speed' | 'Throttle' | 'Brake' | 'Gear'

const GEAR_COLORS = ['#888', '#6366f1', '#38bdf8', '#34d399', '#fbbf24', '#fb923c', '#ef4444', '#e879f9']

function valueToColor(val: number, mode: MapChannel, lo: number, hi: number): string {
  if (mode === 'Gear') return GEAR_COLORS[Math.max(0, Math.min(7, Math.round(val)))]
  const t = hi > lo ? Math.max(0, Math.min(1, (val - lo) / (hi - lo))) : 0
  if (mode === 'Throttle') {
    const r = Math.round((1 - t) * 80); const g = Math.round(80 + t * 175); const b = Math.round((1 - t) * 80)
    return `rgb(${r},${g},${b})`
  }
  if (mode === 'Brake') {
    const r = Math.round(80 + t * 175); const g = Math.round((1 - t) * 80); const b = Math.round((1 - t) * 80)
    return `rgb(${r},${g},${b})`
  }
  const r = Math.round(t < 0.5 ? 0 : (t - 0.5) * 2 * 255)
  const g = Math.round(t < 0.5 ? t * 2 * 255 : (1 - (t - 0.5) * 2) * 255)
  const b = Math.round(t < 0.5 ? (1 - t * 2) * 255 : 0)
  return `rgb(${r},${g},${b})`
}

function normalizePoints(
  lats: number[], lons: number[], values: number[], timestamps: number[], lapDistPcts: number[]
): { points: Point[]; transform: Transform } {
  const n = Math.min(lats.length, lons.length, values.length, timestamps.length)
  const minLat = Math.min(...lats.slice(0, n)); const maxLat = Math.max(...lats.slice(0, n))
  const minLon = Math.min(...lons.slice(0, n)); const maxLon = Math.max(...lons.slice(0, n))
  const latRange = maxLat - minLat || 1; const lonRange = maxLon - minLon || 1
  const scale = Math.min(180 / lonRange, 180 / latRange)
  const ox = (200 - lonRange * scale) / 2; const oy = (200 - latRange * scale) / 2
  const transform: Transform = { minLat, minLon, scale, ox, oy }
  const points = Array.from({ length: n }, (_, i) => ({
    x: (lons[i] - minLon) * scale + ox,
    y: 200 - (lats[i] - minLat) * scale - oy,
    value: values[i],
    timestamp: timestamps[i],
    lapDist: lapDistPcts[i] ?? 0,
  }))
  return { points, transform }
}

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function detectCornerPositions(speedKmh: number[], lapDistPct: number[]): number[] {
  if (speedKmh.length < 20) return []
  const WINDOW = 5; const MIN_SEP = 0.02; const MIN_PROM = 15; const WIN = 80
  const smooth = speedKmh.map((_, i) => {
    const s = Math.max(0, i - WINDOW), e = Math.min(speedKmh.length - 1, i + WINDOW)
    let sum = 0; for (let j = s; j <= e; j++) sum += speedKmh[j]
    return sum / (e - s + 1)
  })
  const candidates: { dist: number; speed: number }[] = []
  for (let i = 1; i < smooth.length - 1; i++) {
    if (smooth[i] > smooth[i - 1] || smooth[i] > smooth[i + 1]) continue
    const sl = smooth.slice(Math.max(0, i - WIN), i)
    const sr = smooth.slice(i + 1, Math.min(smooth.length, i + WIN + 1))
    if (!sl.length || !sr.length) continue
    if (Math.min(Math.max(...sl) - smooth[i], Math.max(...sr) - smooth[i]) >= MIN_PROM) {
      candidates.push({ dist: lapDistPct[i] ?? 0, speed: smooth[i] })
    }
  }
  const merged: { dist: number; speed: number }[] = []
  for (const c of candidates) {
    const idx = merged.findIndex(e => Math.abs(e.dist - c.dist) < MIN_SEP)
    if (idx >= 0) { if (c.speed < merged[idx].speed) merged[idx] = c } else merged.push(c)
  }
  return merged.sort((a, b) => a.dist - b.dist).map(c => c.dist)
}

const DEFAULT_VB = { x: 0, y: 0, w: 200, h: 200 }

export default function TrackMap() {
  const t = useT()
  const { sessions, selectedLapKeys, crosshairTime } = useSessionStore()
  const [points, setPoints] = useState<Point[]>([])
  const [cornerDists, setCornerDists] = useState<number[]>([])
  const [loading, setLoading] = useState(false)
  const [channel, setChannel] = useState<MapChannel>('Speed')
  const [vb, setVb] = useState(DEFAULT_VB)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)

  const mapChannels: { key: MapChannel; label: string }[] = [
    { key: 'Speed', label: 'Speed' },
    { key: 'Throttle', label: t('mapThrottle') },
    { key: 'Brake', label: t('mapBrake') },
    { key: 'Gear', label: t('mapGear') },
  ]

  // Reset zoom when laps change
  useEffect(() => { setVb(DEFAULT_VB) }, [selectedLapKeys.join(',')])

  useEffect(() => {
    if (selectedLapKeys.length === 0 || sessions.length === 0) return
    setLoading(true)

    const fetchAll = async () => {
      let bestPoints: Point[] = []
      let bestRange = 0
      let bestCornerDists: number[] = []

      for (const key of selectedLapKeys) {
        const { sessionId, lapNumber: lapNum } = parseLapKey(key)
        const sess = sessions.find(s => s.id === sessionId)
        if (!sess) continue
        const available = new Set(sess.available_channels.map(c => c.name))
        if (!available.has('Lat') || !available.has('Lon')) continue

        const channelToFetch = available.has(channel) ? channel : 'Speed'
        const needSpeedSeparately = channelToFetch !== 'Speed' && available.has('Speed')

        try {
          const fetches: Promise<LapChannelData[]>[] = [
            invoke('get_lap_channel_data', { sessionId, lapNumbers: [lapNum], channel: 'Lat' }),
            invoke('get_lap_channel_data', { sessionId, lapNumbers: [lapNum], channel: 'Lon' }),
            invoke('get_lap_channel_data', { sessionId, lapNumbers: [lapNum], channel: channelToFetch }),
          ]
          if (needSpeedSeparately) {
            fetches.push(invoke('get_lap_channel_data', { sessionId, lapNumbers: [lapNum], channel: 'Speed' }))
          }
          const results = await Promise.all(fetches)
          const latData = results[0][0]; const lonData = results[1][0]; const valData = results[2][0]
          const speedData = needSpeedSeparately ? results[3]?.[0] : (channelToFetch === 'Speed' ? valData : null)
          if (!latData || !lonData) continue

          const latRange = Math.max(...latData.samples) - Math.min(...latData.samples)
          if (latRange < 0.0001) continue

          if (latRange > bestRange) {
            bestRange = latRange
            const values = valData?.samples ?? latData.samples.map(() => 0)
            const transformed = (channel === 'Throttle' || channel === 'Brake') ? values.map(v => v * 100) : values
            const result = normalizePoints(latData.samples, lonData.samples, transformed, latData.timestamps, latData.lap_dist_pct)
            bestPoints = result.points
            if (speedData) {
              bestCornerDists = detectCornerPositions(speedData.samples.map(v => v * 3.6), speedData.lap_dist_pct)
            }
          }
        } catch { continue }
      }

      if (bestPoints.length > 0) { setPoints(bestPoints); setCornerDists(bestCornerDists) }
      setLoading(false)
    }

    fetchAll()
  }, [selectedLapKeys.join(','), sessions.length, channel])

  const { lo, hi } = useMemo(() => {
    if (points.length === 0) return { lo: 0, hi: 1 }
    if (channel === 'Gear') return { lo: 1, hi: 7 }
    const sorted = [...points.map(p => p.value)].sort((a, b) => a - b)
    return { lo: percentile(sorted, 5), hi: percentile(sorted, 95) }
  }, [points, channel])

  const cursorPoint = useMemo(() => {
    if (crosshairTime == null || points.length === 0) return null
    let best = points[0], bestDiff = Infinity
    for (const pt of points) {
      const diff = Math.abs(pt.timestamp - crosshairTime)
      if (diff < bestDiff) { bestDiff = diff; best = pt }
    }
    return best
  }, [crosshairTime, points])

  const cornerSvgPoints = useMemo(() => {
    if (!points.length || !cornerDists.length) return []
    return cornerDists.map((dist, idx) => {
      let best = points[0], bestDiff = Infinity
      for (const pt of points) { const d = Math.abs(pt.lapDist - dist); if (d < bestDiff) { bestDiff = d; best = pt } }
      return { x: best.x, y: best.y, label: `T${idx + 1}` }
    })
  }, [points, cornerDists])

  // Zoom: wheel event
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    const svg = svgRef.current; if (!svg) return
    const rect = svg.getBoundingClientRect()
    setVb(cur => {
      const factor = e.deltaY < 0 ? 0.75 : 1.33
      const newW = Math.min(200, Math.max(10, cur.w * factor))
      const newH = Math.min(200, Math.max(10, cur.h * factor))
      const mx = (e.clientX - rect.left) / rect.width * cur.w + cur.x
      const my = (e.clientY - rect.top) / rect.height * cur.h + cur.y
      return {
        x: mx - (mx - cur.x) * (newW / cur.w),
        y: my - (my - cur.y) * (newH / cur.h),
        w: newW, h: newH,
      }
    })
  }, [])

  // Attach non-passive wheel listener so preventDefault works
  useEffect(() => {
    const el = svgRef.current; if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y }
  }, [vb])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current) return
    const svg = svgRef.current; if (!svg) return
    const rect = svg.getBoundingClientRect()
    const dx = (e.clientX - dragRef.current.x) / rect.width * vb.w
    const dy = (e.clientY - dragRef.current.y) / rect.height * vb.h
    setVb(cur => ({ ...cur, x: dragRef.current!.vx - dx, y: dragRef.current!.vy - dy }))
  }, [vb.w, vb.h])

  const handleMouseUp = useCallback(() => { dragRef.current = null }, [])

  const isZoomed = vb.w < 199

  if (sessions.length === 0) return null

  if (!loading && points.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-xs text-muted-foreground">{t('noGpsData')}</p>
      </div>
    )
  }

  const gearLabels = ['N', '1', '2', '3', '4', '5', '6', '7']

  return (
    <div className="h-full flex flex-col">
      {/* Channel selector */}
      <div className="shrink-0 flex items-center justify-center gap-1 pt-1.5 pb-0.5">
        {mapChannels.map(opt => (
          <button key={opt.key} onClick={() => setChannel(opt.key)}
            className={`px-2 py-0.5 text-[10px] font-semibold rounded transition-colors ${
              channel === opt.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
            }`}>
            {opt.label}
          </button>
        ))}
        {isZoomed && (
          <button onClick={() => setVb(DEFAULT_VB)}
            className="px-2 py-0.5 text-[10px] font-semibold rounded text-muted-foreground hover:text-foreground hover:bg-secondary ml-1">
            ↺
          </button>
        )}
      </div>

      {/* Map */}
      <div className="flex-1 min-h-0 flex items-center justify-center relative">
        {loading && <p className="absolute text-xs text-muted-foreground">{t('loadingMap')}</p>}
        {points.length > 0 && (
          <svg
            ref={svgRef}
            viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
            preserveAspectRatio="xMidYMid meet"
            className="w-full h-full"
            style={{ maxHeight: '100%', cursor: dragRef.current ? 'grabbing' : 'grab' }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            {points.slice(0, -1).map((pt, i) => (
              <line key={i}
                x1={pt.x} y1={pt.y} x2={points[i + 1].x} y2={points[i + 1].y}
                stroke={valueToColor(pt.value, channel, lo, hi)}
                strokeWidth={2} strokeLinecap="round" />
            ))}
            {points[0] && <circle cx={points[0].x} cy={points[0].y} r={4} fill="#ffffff" opacity={0.8} />}
            {cursorPoint && (
              <circle cx={cursorPoint.x} cy={cursorPoint.y} r={5} fill="#ffffff" stroke="#000000" strokeWidth={1.5} opacity={0.95} />
            )}
            {cornerSvgPoints.map((c, i) => (
              <g key={i}>
                <circle cx={c.x} cy={c.y} r={5} fill="white" opacity={0.85} />
                <text x={c.x} y={c.y + 3.5} textAnchor="middle" fontSize={5} fontWeight="bold" fill="black">
                  {c.label}
                </text>
              </g>
            ))}
          </svg>
        )}
      </div>

      {/* Legend */}
      {points.length > 0 && (
        <div className="shrink-0 flex items-center justify-center gap-1.5 pb-1">
          {channel === 'Gear' ? (
            <div className="flex items-center gap-1">
              {GEAR_COLORS.slice(1).map((c, i) => (
                <span key={i} className="flex flex-col items-center gap-0.5">
                  <span className="w-3 h-1.5 rounded-sm block" style={{ background: c }} />
                  <span className="text-[8px] text-muted-foreground">{gearLabels[i + 1]}</span>
                </span>
              ))}
            </div>
          ) : (
            <>
              <span className="text-[10px] text-muted-foreground">{channel === 'Speed' ? t('slow') : '0%'}</span>
              <div className="w-14 h-1.5 rounded" style={{
                background: channel === 'Throttle'
                  ? 'linear-gradient(to right, rgb(80,80,80), rgb(80,255,80))'
                  : channel === 'Brake'
                  ? 'linear-gradient(to right, rgb(80,80,80), rgb(255,80,80))'
                  : 'linear-gradient(to right, rgb(0,0,255), rgb(0,255,0), rgb(255,255,0), rgb(255,0,0))'
              }} />
              <span className="text-[10px] text-muted-foreground">{channel === 'Speed' ? t('fast') : '100%'}</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
