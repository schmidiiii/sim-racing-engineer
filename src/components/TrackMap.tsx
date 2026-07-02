import { useEffect, useState, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore } from '@/store/session'

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
  const clamped = Math.max(0, Math.min(1, t))
  // Blue (slow) → Green → Yellow → Red (fast)
  const r = Math.round(clamped < 0.5 ? 0 : (clamped - 0.5) * 2 * 255)
  const g = Math.round(clamped < 0.5 ? clamped * 2 * 255 : (1 - (clamped - 0.5) * 2) * 255)
  const b = Math.round(clamped < 0.5 ? (1 - clamped * 2) * 255 : 0)
  return `rgb(${r},${g},${b})`
}

export default function TrackMap() {
  const { session, selectedLaps } = useSessionStore()
  const [points, setPoints] = useState<Point[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!session || selectedLaps.length === 0) return

    const lapNum = selectedLaps[0]
    const lap = session.laps.find(l => l.lap_number === lapNum)
    if (!lap) return

    const available = new Set(session.available_channels.map(c => c.name))
    if (!available.has('Lat') || !available.has('Lon')) return

    setLoading(true)

    Promise.all([
      invoke<LapChannelData>('get_lap_channel_data', { sessionId: session.id, lapNumber: lapNum, channel: 'Lat' }),
      invoke<LapChannelData>('get_lap_channel_data', { sessionId: session.id, lapNumber: lapNum, channel: 'Lon' }),
      available.has('Speed')
        ? invoke<LapChannelData>('get_lap_channel_data', { sessionId: session.id, lapNumber: lapNum, channel: 'Speed' })
        : Promise.resolve(null),
    ]).then(([latData, lonData, speedData]) => {
      const speeds = speedData?.samples ?? latData.samples.map(() => 0)
      setPoints(normalizePoints(latData.samples, lonData.samples, speeds))
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [session?.id, selectedLaps[0]])

  const { minSpeed, maxSpeed } = useMemo(() => {
    if (points.length === 0) return { minSpeed: 0, maxSpeed: 1 }
    const speeds = points.map(p => p.speed)
    return { minSpeed: Math.min(...speeds), maxSpeed: Math.max(...speeds) }
  }, [points])

  if (!session) return null

  const hasGps = session.available_channels.some(c => c.name === 'Lat')

  if (!hasGps) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-xs text-muted-foreground">No GPS data in this session</p>
      </div>
    )
  }

  return (
    <div className="h-full flex items-center justify-center bg-background/50 relative">
      {loading && (
        <p className="absolute text-xs text-muted-foreground">Loading map…</p>
      )}
      {points.length > 0 && (
        <svg
          viewBox="0 0 500 240"
          className="w-full h-full"
          style={{ maxHeight: '100%' }}
        >
          {points.slice(0, -1).map((pt, i) => {
            const next = points[i + 1]
            return (
              <line
                key={i}
                x1={pt.x}
                y1={pt.y}
                x2={next.x}
                y2={next.y}
                stroke={speedToColor(pt.speed, minSpeed, maxSpeed)}
                strokeWidth={2}
                strokeLinecap="round"
              />
            )
          })}
          {/* Start marker */}
          {points[0] && (
            <circle cx={points[0].x} cy={points[0].y} r={4} fill="#ffffff" opacity={0.8} />
          )}
        </svg>
      )}
      {/* Speed legend */}
      {points.length > 0 && (
        <div className="absolute bottom-2 right-3 flex items-center gap-1">
          <span className="text-xs text-muted-foreground">Slow</span>
          <div
            className="w-16 h-2 rounded"
            style={{
              background: 'linear-gradient(to right, rgb(0,0,255), rgb(0,255,0), rgb(255,255,0), rgb(255,0,0))',
            }}
          />
          <span className="text-xs text-muted-foreground">Fast</span>
        </div>
      )}
    </div>
  )
}
