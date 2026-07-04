import { useEffect, useState, useMemo } from 'react'
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
}

interface Transform {
  minLat: number
  minLon: number
  scale: number
  ox: number
  oy: number
}

type MapChannel = 'Speed' | 'Throttle' | 'Brake' | 'Gear'

const MAP_CHANNELS: { key: MapChannel; label: string }[] = [
  { key: 'Speed', label: 'Speed' },
  { key: 'Throttle', label: 'Gas' },
  { key: 'Brake', label: 'Bremse' },
  { key: 'Gear', label: 'Gang' },
]

const GEAR_COLORS = ['#888', '#6366f1', '#38bdf8', '#34d399', '#fbbf24', '#fb923c', '#ef4444', '#e879f9']

function valueToColor(val: number, mode: MapChannel, lo: number, hi: number): string {
  if (mode === 'Gear') return GEAR_COLORS[Math.max(0, Math.min(7, Math.round(val)))]
  const t = hi > lo ? Math.max(0, Math.min(1, (val - lo) / (hi - lo))) : 0
  if (mode === 'Throttle') {
    const r = Math.round((1 - t) * 80)
    const g = Math.round(80 + t * 175)
    const b = Math.round((1 - t) * 80)
    return `rgb(${r},${g},${b})`
  }
  if (mode === 'Brake') {
    const r = Math.round(80 + t * 175)
    const g = Math.round((1 - t) * 80)
    const b = Math.round((1 - t) * 80)
    return `rgb(${r},${g},${b})`
  }
  // Speed: blue → green → yellow → red
  const r = Math.round(t < 0.5 ? 0 : (t - 0.5) * 2 * 255)
  const g = Math.round(t < 0.5 ? t * 2 * 255 : (1 - (t - 0.5) * 2) * 255)
  const b = Math.round(t < 0.5 ? (1 - t * 2) * 255 : 0)
  return `rgb(${r},${g},${b})`
}

function normalizePoints(
  lats: number[], lons: number[], values: number[], timestamps: number[]
): { points: Point[]; transform: Transform } {
  const n = Math.min(lats.length, lons.length, values.length, timestamps.length)
  const minLat = Math.min(...lats.slice(0, n))
  const maxLat = Math.max(...lats.slice(0, n))
  const minLon = Math.min(...lons.slice(0, n))
  const maxLon = Math.max(...lons.slice(0, n))
  const latRange = maxLat - minLat || 1
  const lonRange = maxLon - minLon || 1
  const scale = Math.min(180 / lonRange, 180 / latRange)
  const ox = (200 - lonRange * scale) / 2
  const oy = (200 - latRange * scale) / 2
  const transform: Transform = { minLat, minLon, scale, ox, oy }
  const points = Array.from({ length: n }, (_, i) => ({
    x: (lons[i] - minLon) * scale + ox,
    y: 200 - (lats[i] - minLat) * scale - oy,
    value: values[i],
    timestamp: timestamps[i],
  }))
  return { points, transform }
}

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

export default function TrackMap() {
  const t = useT()
  const { sessions, selectedLapKeys, crosshairTime } = useSessionStore()
  const [points, setPoints] = useState<Point[]>([])
  const [loading, setLoading] = useState(false)
  const [channel, setChannel] = useState<MapChannel>('Speed')

  useEffect(() => {
    if (selectedLapKeys.length === 0 || sessions.length === 0) return

    setLoading(true)

    const fetchAll = async () => {
      let bestPoints: Point[] = []
      let bestRange = 0

      for (const key of selectedLapKeys) {
        const { sessionId, lapNumber: lapNum } = parseLapKey(key)
        const sess = sessions.find(s => s.id === sessionId)
        if (!sess) continue
        const available = new Set(sess.available_channels.map(c => c.name))
        if (!available.has('Lat') || !available.has('Lon')) continue

        const channelToFetch = available.has(channel) ? channel : 'Speed'

        try {
          const [latResults, lonResults, valResults] = await Promise.all([
            invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNum], channel: 'Lat' }),
            invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNum], channel: 'Lon' }),
            invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNum], channel: channelToFetch }),
          ])
          const latData = latResults[0]
          const lonData = lonResults[0]
          const valData = valResults[0]
          if (!latData || !lonData) continue

          const latRange = Math.max(...latData.samples) - Math.min(...latData.samples)
          if (latRange < 0.0001) continue

          if (latRange > bestRange) {
            bestRange = latRange
            const values = valData?.samples ?? latData.samples.map(() => 0)
            // Apply unit transforms
            const transformed = (channel === 'Throttle' || channel === 'Brake')
              ? values.map(v => v * 100)
              : values
            const result = normalizePoints(latData.samples, lonData.samples, transformed, latData.timestamps)
            bestPoints = result.points
          }
        } catch {
          continue
        }
      }

      if (bestPoints.length > 0) setPoints(bestPoints)
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
        {MAP_CHANNELS.map(opt => (
          <button
            key={opt.key}
            onClick={() => setChannel(opt.key)}
            className={`px-2 py-0.5 text-[10px] font-semibold rounded transition-colors ${
              channel === opt.key
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Map */}
      <div className="flex-1 min-h-0 flex items-center justify-center relative">
        {loading && <p className="absolute text-xs text-muted-foreground">{t('loadingMap')}</p>}
        {points.length > 0 && (
          <svg viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet" className="w-full h-full" style={{ maxHeight: '100%' }}>
            {points.slice(0, -1).map((pt, i) => (
              <line
                key={i}
                x1={pt.x} y1={pt.y}
                x2={points[i + 1].x} y2={points[i + 1].y}
                stroke={valueToColor(pt.value, channel, lo, hi)}
                strokeWidth={2}
                strokeLinecap="round"
              />
            ))}
            {points[0] && <circle cx={points[0].x} cy={points[0].y} r={4} fill="#ffffff" opacity={0.8} />}
            {cursorPoint && (
              <circle cx={cursorPoint.x} cy={cursorPoint.y} r={5}
                fill="#ffffff" stroke="#000000" strokeWidth={1.5} opacity={0.95} />
            )}
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
              <span className="text-[10px] text-muted-foreground">
                {channel === 'Speed' ? t('slow') : '0%'}
              </span>
              <div className="w-14 h-1.5 rounded" style={{
                background: channel === 'Throttle'
                  ? 'linear-gradient(to right, rgb(80,80,80), rgb(80,255,80))'
                  : channel === 'Brake'
                  ? 'linear-gradient(to right, rgb(80,80,80), rgb(255,80,80))'
                  : 'linear-gradient(to right, rgb(0,0,255), rgb(0,255,0), rgb(255,255,0), rgb(255,0,0))'
              }} />
              <span className="text-[10px] text-muted-foreground">
                {channel === 'Speed' ? t('fast') : '100%'}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
