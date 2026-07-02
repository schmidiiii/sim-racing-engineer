import { useEffect, useState, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, parseLapKey } from '@/store/session'

interface LapChannelData {
  lap_number: number
  channel: string
  samples: number[]
  timestamps: number[]
}

interface Point {
  x: number
  y: number
  speed: number
}

function normalizePoints(lats: number[], lons: number[], speeds: number[]): Point[] {
  if (lats.length === 0) return []
  const n = Math.min(lats.length, lons.length, speeds.length)
  const minLat = Math.min(...lats.slice(0, n))
  const maxLat = Math.max(...lats.slice(0, n))
  const minLon = Math.min(...lons.slice(0, n))
  const maxLon = Math.max(...lons.slice(0, n))
  const latRange = maxLat - minLat || 1
  const lonRange = maxLon - minLon || 1
  const scale = Math.min(480 / lonRange, 220 / latRange)
  return Array.from({ length: n }, (_, i) => ({
    x: (lons[i] - minLon) * scale + 10,
    y: 230 - (lats[i] - minLat) * scale - 10,
    speed: speeds[i],
  }))
}

function speedToColor(speed: number, minSpeed: number, maxSpeed: number): string {
  const t = maxSpeed > minSpeed ? (speed - minSpeed) / (maxSpeed - minSpeed) : 0
  const c = Math.max(0, Math.min(1, t))
  const r = Math.round(c < 0.5 ? 0 : (c - 0.5) * 2 * 255)
  const g = Math.round(c < 0.5 ? c * 2 * 255 : (1 - (c - 0.5) * 2) * 255)
  const b = Math.round(c < 0.5 ? (1 - c * 2) * 255 : 0)
  return `rgb(${r},${g},${b})`
}

export default function TrackMap() {
  const { sessions, selectedLapKeys } = useSessionStore()
  const [points, setPoints] = useState<Point[]>([])
  const [loading, setLoading] = useState(false)

  const firstKey = selectedLapKeys[0]

  useEffect(() => {
    if (!firstKey || sessions.length === 0) return
    const { sessionId, lapNumber: lapNum } = parseLapKey(firstKey)
    const session = sessions.find(s => s.id === sessionId)
    if (!session) return

    const available = new Set(session.available_channels.map(c => c.name))
    if (!available.has('Lat') || !available.has('Lon')) return

    setLoading(true)

    Promise.all([
      invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNum], channel: 'Lat' }),
      invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNum], channel: 'Lon' }),
      available.has('Speed')
        ? invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNum], channel: 'Speed' })
        : Promise.resolve(null),
    ]).then(([latResults, lonResults, speedResults]) => {
      const latData = latResults[0]
      const lonData = lonResults[0]
      if (!latData || !lonData) { setLoading(false); return }
      const speeds = speedResults?.[0]?.samples ?? latData.samples.map(() => 0)
      setPoints(normalizePoints(latData.samples, lonData.samples, speeds))
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [firstKey, sessions.length])

  const { minSpeed, maxSpeed } = useMemo(() => {
    if (points.length === 0) return { minSpeed: 0, maxSpeed: 1 }
    const speeds = points.map(p => p.speed)
    return { minSpeed: Math.min(...speeds), maxSpeed: Math.max(...speeds) }
  }, [points])

  if (sessions.length === 0) return null

  const { sessionId } = firstKey ? parseLapKey(firstKey) : { sessionId: '' }
  const session = sessions.find(s => s.id === sessionId)
  const hasGps = session?.available_channels.some(c => c.name === 'Lat') ?? false

  if (!hasGps) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-xs text-muted-foreground">No GPS data in this session</p>
      </div>
    )
  }

  return (
    <div className="h-full flex items-center justify-center bg-background/50 relative">
      {loading && <p className="absolute text-xs text-muted-foreground">Loading map…</p>}
      {points.length > 0 && (
        <svg viewBox="0 0 500 240" className="w-full h-full" style={{ maxHeight: '100%' }}>
          {points.slice(0, -1).map((pt, i) => (
            <line
              key={i}
              x1={pt.x} y1={pt.y}
              x2={points[i + 1].x} y2={points[i + 1].y}
              stroke={speedToColor(pt.speed, minSpeed, maxSpeed)}
              strokeWidth={2}
              strokeLinecap="round"
            />
          ))}
          {points[0] && <circle cx={points[0].x} cy={points[0].y} r={4} fill="#ffffff" opacity={0.8} />}
        </svg>
      )}
      {points.length > 0 && (
        <div className="absolute bottom-2 right-3 flex items-center gap-1">
          <span className="text-xs text-muted-foreground">Slow</span>
          <div className="w-16 h-2 rounded" style={{ background: 'linear-gradient(to right, rgb(0,0,255), rgb(0,255,0), rgb(255,255,0), rgb(255,0,0))' }} />
          <span className="text-xs text-muted-foreground">Fast</span>
        </div>
      )}
    </div>
  )
}
