import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { useSessionStore, parseLapKey, getLapColor } from '@/store/session'
import { useT } from '@/lib/i18n'

interface LapChannelData {
  lap_number: number
  channel: string
  samples: number[]
  lap_dist_pct: number[]
}

interface Corner {
  dist: number      // 0–1 lap distance
  minSpeed: number  // km/h
  sampleIdx: number // index in speed sample array
}

interface LapCorners {
  lapKey: string
  lapNumber: number
  colorIndex: number
  corners: Corner[]
  lat: number[]
  lon: number[]
  lapDistPct: number[] // lap_dist_pct from Speed channel
}

// Find local speed minima — these are the corners
function detectCorners(speedKmh: number[], lapDist: number[]): Corner[] {
  if (speedKmh.length < 10) return []

  const maxSpeed = Math.max(...speedKmh)
  const threshold = maxSpeed * 0.92  // balance: catches sweepers but filters straight wiggles
  const MIN_SEP = 0.02               // 2% lap distance minimum between corners
  const WINDOW = 5                   // smaller window → sharper peaks survive smoothing

  // Smooth speed with simple moving average
  const smooth = speedKmh.map((_, i) => {
    const start = Math.max(0, i - WINDOW)
    const end = Math.min(speedKmh.length - 1, i + WINDOW)
    let sum = 0
    for (let j = start; j <= end; j++) sum += speedKmh[j]
    return sum / (end - start + 1)
  })

  // Collect every true local minimum below threshold
  const candidates: Corner[] = []
  for (let i = 1; i < smooth.length - 1; i++) {
    if (smooth[i] < threshold && smooth[i] <= smooth[i - 1] && smooth[i] <= smooth[i + 1]) {
      candidates.push({ dist: lapDist[i] ?? 0, minSpeed: smooth[i], sampleIdx: i })
    }
  }

  // Merge candidates within MIN_SEP — keep the deepest (slowest) one
  const corners: Corner[] = []
  for (const c of candidates) {
    const idx = corners.findIndex(e => Math.abs(e.dist - c.dist) < MIN_SEP)
    if (idx >= 0) {
      if (c.minSpeed < corners[idx].minSpeed) corners[idx] = c
    } else {
      corners.push(c)
    }
  }

  return corners.sort((a, b) => a.dist - b.dist)
}

// Match corners across laps by proximity
function buildChartData(
  allLaps: LapCorners[],
): { label: string; dist: number; [key: string]: number | string }[] {
  if (allLaps.length === 0) return []

  // Use the lap with most corners as reference
  const ref = allLaps.reduce((a, b) => a.corners.length >= b.corners.length ? a : b)

  return ref.corners.map((refCorner, idx) => {
    const row: { label: string; dist: number; [key: string]: number | string } = {
      label: `T${idx + 1}`,
      dist: refCorner.dist,
    }
    for (const lap of allLaps) {
      const match = lap.corners.find(c => Math.abs(c.dist - refCorner.dist) < 0.08)
      if (match) row[lap.lapKey] = Math.round(match.minSpeed)
    }
    return row
  })
}

function computeTransform(lats: number[], lons: number[]) {
  const minLat = Math.min(...lats), maxLat = Math.max(...lats)
  const minLon = Math.min(...lons), maxLon = Math.max(...lons)
  const latRange = maxLat - minLat || 1, lonRange = maxLon - minLon || 1
  const scale = Math.min(200 / lonRange, 200 / latRange)
  const ox = (200 - lonRange * scale) / 2, oy = (200 - latRange * scale) / 2
  return { minLat, minLon, scale, ox, oy }
}

function project(lat: number, lon: number, tf: ReturnType<typeof computeTransform>) {
  return { x: (lon - tf.minLon) * tf.scale + tf.ox, y: 200 - (lat - tf.minLat) * tf.scale - tf.oy }
}

// Find GPS position for a given lap_dist_pct value
function gpsAtDist(dist: number, lapDistPct: number[], lat: number[], lon: number[]) {
  if (lat.length === 0) return null
  let best = 0, bestDiff = Infinity
  for (let i = 0; i < lapDistPct.length; i++) {
    const d = Math.abs(lapDistPct[i] - dist)
    if (d < bestDiff) { bestDiff = d; best = i }
  }
  if (best >= lat.length) return null
  return { lat: lat[best], lon: lon[best] }
}

const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 text-xs shadow-lg">
      <p className="font-semibold text-foreground mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color }} className="font-mono">{p.name}: {p.value} km/h</p>
      ))}
    </div>
  )
}

const STEP = 8

export default function CornerSpeed() {
  const t = useT()
  const { sessions, selectedLapKeys } = useSessionStore()
  const [lapCorners, setLapCorners] = useState<LapCorners[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (selectedLapKeys.length === 0 || sessions.length === 0) { setLapCorners([]); return }
    setLoading(true)

    const fetchAll = async () => {
      const results: LapCorners[] = []

      for (let ci = 0; ci < selectedLapKeys.length; ci++) {
        const key = selectedLapKeys[ci]
        const { sessionId, lapNumber } = parseLapKey(key)
        const sess = sessions.find(s => s.id === sessionId)
        if (!sess) continue
        const available = new Set(sess.available_channels.map(c => c.name))
        if (!available.has('Speed')) continue

        try {
          const wantGps = available.has('Lat') && available.has('Lon')
          const channels = ['Speed', ...(wantGps ? ['Lat', 'Lon'] : [])]
          const fetched = await Promise.all(
            channels.map(ch => invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNumber], channel: ch }))
          )
          const byChannel: Record<string, LapChannelData> = {}
          channels.forEach((ch, i) => { if (fetched[i][0]) byChannel[ch] = fetched[i][0] })

          const speedData = byChannel['Speed']
          if (!speedData) continue

          const speedKmh = speedData.samples.map(v => v * 3.6)
          const corners = detectCorners(speedKmh, speedData.lap_dist_pct)

          results.push({
            lapKey: key,
            lapNumber,
            colorIndex: ci,
            corners,
            lat: byChannel['Lat']?.samples ?? [],
            lon: byChannel['Lon']?.samples ?? [],
            lapDistPct: speedData.lap_dist_pct,
          })
        } catch { continue }
      }

      setLapCorners(results)
      setLoading(false)
    }

    fetchAll()
  }, [selectedLapKeys.join(','), sessions.length])

  if (loading) return (
    <div className="flex-1 flex items-center justify-center">
      <p className="text-sm text-muted-foreground">{t('loadingCorners')}</p>
    </div>
  )

  if (lapCorners.length === 0) return (
    <div className="flex-1 flex items-center justify-center">
      <p className="text-sm text-muted-foreground">{t('noCornerData')}</p>
    </div>
  )

  const chartData = buildChartData(lapCorners)
  const allSpeeds = lapCorners.flatMap(l => l.corners.map(c => c.minSpeed))
  const yMin = Math.max(0, Math.floor((Math.min(...allSpeeds) - 20) / 10) * 10)
  const yMax = Math.ceil((Math.max(...allSpeeds) + 10) / 10) * 10

  // Reference lap for track map (most corners, prefer one with GPS)
  const ref = lapCorners.reduce((a, b) => a.corners.length >= b.corners.length ? a : b)
  const gpsLap = lapCorners.find(l => l.lat.length > 10) ?? null
  const tf = gpsLap ? computeTransform(gpsLap.lat, gpsLap.lon) : null

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-background">

      {/* Bar chart card */}
      <div className="bg-card rounded-xl border border-border shadow-sm p-4">
        <h3 className="text-sm font-semibold text-foreground mb-1">{t('cornerSpeedTitle')}</h3>
        <div className="flex items-center gap-4 mb-4">
          {lapCorners.map(ld => (
            <span key={ld.lapKey} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: getLapColor(ld.colorIndex) }} />
              L{ld.lapNumber}
            </span>
          ))}
        </div>

        <div style={{ height: Math.max(240, chartData.length * 14 + 60) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 4 }} barCategoryGap="20%">
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={[yMin, yMax]}
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                axisLine={false}
                tickLine={false}
                width={38}
                tickFormatter={v => `${v}`}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: 'hsl(var(--secondary))' }} />
              {lapCorners.map(ld => (
                <Bar key={ld.lapKey} dataKey={ld.lapKey} name={`L${ld.lapNumber}`} fill={getLapColor(ld.colorIndex)} radius={[3, 3, 0, 0]} maxBarSize={32}>
                  {chartData.map((_, i) => (
                    <Cell key={i} fill={getLapColor(ld.colorIndex)} fillOpacity={0.85} />
                  ))}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Track map + detail table */}
      <div className={`grid gap-4 ${tf ? 'grid-cols-[220px_1fr]' : 'grid-cols-1'}`}>

        {/* Track map with turn markers */}
        {tf && gpsLap && (
          <div className="bg-card rounded-xl border border-border shadow-sm p-3">
            <h3 className="text-xs font-semibold text-foreground mb-2">Track Map</h3>
            <svg viewBox="0 0 200 200" className="w-full" style={{ aspectRatio: '1' }}>
              {/* Track outline */}
              {Array.from({ length: Math.floor((gpsLap.lat.length - 1) / STEP) }, (_, k) => {
                const i = k * STEP
                const p1 = project(gpsLap.lat[i], gpsLap.lon[i], tf)
                const p2 = project(gpsLap.lat[i + STEP] ?? gpsLap.lat[i], gpsLap.lon[i + STEP] ?? gpsLap.lon[i], tf)
                return <line key={i} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                  stroke="rgba(150,150,150,0.35)" strokeWidth={3} strokeLinecap="round" />
              })}
              {/* Corner markers from reference lap */}
              {ref.corners.map((corner, idx) => {
                const gps = gpsAtDist(corner.dist, ref.lapDistPct, gpsLap.lat, gpsLap.lon)
                if (!gps) return null
                const pt = project(gps.lat, gps.lon, tf)
                return (
                  <g key={idx}>
                    <circle cx={pt.x} cy={pt.y} r={5} fill="hsl(var(--primary))" opacity={0.9} />
                    <text
                      x={pt.x} y={pt.y - 7}
                      textAnchor="middle"
                      fontSize={6}
                      fontWeight="bold"
                      fill="hsl(var(--foreground))"
                      stroke="hsl(var(--background))"
                      strokeWidth={2}
                      paintOrder="stroke"
                    >
                      T{idx + 1}
                    </text>
                  </g>
                )
              })}
            </svg>
          </div>
        )}

        {/* Per-corner detail table */}
        <div className="bg-card rounded-xl border border-border shadow-sm p-4 min-w-0">
          <h3 className="text-sm font-semibold text-foreground mb-3">Corner Detail</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-muted-foreground font-medium pb-1.5 pr-4">Corner</th>
                  <th className="text-left text-muted-foreground font-medium pb-1.5 pr-4">Pos.</th>
                  {lapCorners.map(ld => (
                    <th key={ld.lapKey} className="text-right pb-1.5 pr-3 font-semibold" style={{ color: getLapColor(ld.colorIndex) }}>
                      L{ld.lapNumber}
                    </th>
                  ))}
                  {lapCorners.length >= 2 && (
                    <th className="text-right pb-1.5 text-muted-foreground font-medium">Δ km/h</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {chartData.map((row, i) => {
                  const speeds = lapCorners.map(ld => row[ld.lapKey] as number | undefined)
                  const validSpeeds = speeds.filter((s): s is number => s !== undefined)
                  const delta = validSpeeds.length >= 2 ? validSpeeds[0] - validSpeeds[1] : null

                  return (
                    <tr key={i} className="border-b border-border/40 last:border-0">
                      <td className="py-1.5 pr-4 font-mono text-muted-foreground">{row.label}</td>
                      <td className="py-1.5 pr-4 font-mono text-muted-foreground">{((row.dist as number) * 100).toFixed(1)}%</td>
                      {lapCorners.map(ld => (
                        <td key={ld.lapKey} className="py-1.5 pr-3 text-right font-mono tabular-nums"
                          style={{ color: getLapColor(ld.colorIndex) }}>
                          {row[ld.lapKey] !== undefined ? `${row[ld.lapKey]} km/h` : '–'}
                        </td>
                      ))}
                      {lapCorners.length >= 2 && delta !== null && (
                        <td className={`py-1.5 text-right font-mono tabular-nums ${delta > 1 ? 'text-emerald-400' : delta < -1 ? 'text-red-400' : 'text-muted-foreground'}`}>
                          {delta > 0 ? '+' : ''}{delta.toFixed(0)}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="text-[10px] text-muted-foreground/40 mt-2">
              Δ km/h: positive = faster through corner · negative = slower
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
