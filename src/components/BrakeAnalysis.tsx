import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, parseLapKey, getLapColor } from '@/store/session'

interface LapChannelData {
  lap_number: number
  channel: string
  samples: number[]
  timestamps: number[]
  lap_dist_pct: number[]
}

interface BrakeZone {
  entryDist: number
  exitDist: number
  entryIdx: number
  peakPressure: number  // 0–100 %
  speedAtEntry: number  // km/h
}

interface LapData {
  lapKey: string
  lapNumber: number
  colorIndex: number
  zones: BrakeZone[]
  lat: number[]
  lon: number[]
}

const BRAKE_THRESHOLD = 3
const MIN_PEAK        = 15
const MIN_DURATION    = 0.008

function detectBrakeZones(brake: number[], lapDistPct: number[], speed: number[]): BrakeZone[] {
  const zones: BrakeZone[] = []
  let inZone = false, entryIdx = 0, peak = 0

  for (let i = 0; i < brake.length; i++) {
    const b = brake[i]
    if (!inZone && b > BRAKE_THRESHOLD) {
      inZone = true; entryIdx = i; peak = b
    } else if (inZone) {
      if (b > peak) peak = b
      if (b <= BRAKE_THRESHOLD || i === brake.length - 1) {
        const zone: BrakeZone = {
          entryDist: lapDistPct[entryIdx] ?? 0,
          exitDist: lapDistPct[Math.min(i, lapDistPct.length - 1)] ?? 0,
          entryIdx,
          peakPressure: peak,
          speedAtEntry: speed[entryIdx] ?? 0,
        }
        if (zone.exitDist - zone.entryDist > MIN_DURATION && zone.peakPressure > MIN_PEAK) {
          zones.push(zone)
        }
        inZone = false; peak = 0
      }
    }
  }
  return zones
}

interface MatchedZone {
  refDist: number
  entries: { lapKey: string; zone: BrakeZone }[]
}

function matchZones(lapDataArr: LapData[]): MatchedZone[] {
  if (lapDataArr.length === 0) return []
  return lapDataArr[0].zones.map(refZone => {
    const entries: { lapKey: string; zone: BrakeZone }[] = []
    for (const ld of lapDataArr) {
      const match = ld.zones.find(z => Math.abs(z.entryDist - refZone.entryDist) < 0.04)
      if (match) entries.push({ lapKey: ld.lapKey, zone: match })
    }
    return { refDist: refZone.entryDist, entries }
  }).filter(m => m.entries.length > 0)
}

function computeTransform(lats: number[], lons: number[]) {
  const minLat = Math.min(...lats), maxLat = Math.max(...lats)
  const minLon = Math.min(...lons), maxLon = Math.max(...lons)
  const latRange = maxLat - minLat || 1, lonRange = maxLon - minLon || 1
  const scale = Math.min(180 / lonRange, 180 / latRange)
  const ox = (200 - lonRange * scale) / 2, oy = (200 - latRange * scale) / 2
  return { minLat, minLon, scale, ox, oy }
}

function project(lat: number, lon: number, tf: ReturnType<typeof computeTransform>) {
  return { x: (lon - tf.minLon) * tf.scale + tf.ox, y: 200 - (lat - tf.minLat) * tf.scale - tf.oy }
}

export default function BrakeAnalysis() {
  const { sessions, selectedLapKeys } = useSessionStore()
  const [lapDataArr, setLapDataArr] = useState<LapData[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (selectedLapKeys.length === 0 || sessions.length === 0) { setLapDataArr([]); return }
    setLoading(true)

    const fetchData = async () => {
      const results: LapData[] = []

      for (let ci = 0; ci < selectedLapKeys.length; ci++) {
        const key = selectedLapKeys[ci]
        const { sessionId, lapNumber: lapNum } = parseLapKey(key)
        const sess = sessions.find(s => s.id === sessionId)
        if (!sess) continue
        const available = new Set(sess.available_channels.map(c => c.name))
        if (!available.has('Brake')) continue

        try {
          const wantGps = available.has('Lat') && available.has('Lon')
          const channels = ['Brake', 'Speed', ...(wantGps ? ['Lat', 'Lon'] : [])]
          const fetched = await Promise.all(
            channels.map(ch => invoke<LapChannelData[]>('get_lap_channel_data', { sessionId, lapNumbers: [lapNum], channel: ch }))
          )
          const byChannel: Record<string, LapChannelData> = {}
          channels.forEach((ch, i) => { if (fetched[i][0]) byChannel[ch] = fetched[i][0] })

          const brakeData = byChannel['Brake']
          if (!brakeData) continue

          const brake = brakeData.samples.map(v => v * 100)
          const lapDistPct = brakeData.lap_dist_pct
          const speed = (byChannel['Speed']?.samples ?? []).map(v => v * 3.6)
          const zones = detectBrakeZones(brake, lapDistPct, speed)

          results.push({
            lapKey: key, lapNumber: lapNum, colorIndex: ci,
            zones,
            lat: byChannel['Lat']?.samples ?? [],
            lon: byChannel['Lon']?.samples ?? [],
          })
        } catch { continue }
      }

      setLapDataArr(results)
      setLoading(false)
    }

    fetchData()
  }, [selectedLapKeys.join(','), sessions.length])

  if (loading) return (
    <div className="flex-1 flex items-center justify-center">
      <p className="text-sm text-muted-foreground">Lade Bremsdaten…</p>
    </div>
  )
  if (lapDataArr.length === 0) return (
    <div className="flex-1 flex items-center justify-center">
      <p className="text-sm text-muted-foreground">Keine Bremsdaten verfügbar</p>
    </div>
  )

  const matched = matchZones(lapDataArr)
  const gpsLap = lapDataArr.find(l => l.lat.length > 10)
  const tf = gpsLap ? computeTransform(gpsLap.lat, gpsLap.lon) : null
  const STEP = 8  // downsample track outline

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-background">

      {/* Bremsdruckverlauf strips — one zone rect per detected zone (fast) */}
      <div className="bg-card rounded-xl border border-border shadow-sm p-4">
        <h3 className="text-sm font-semibold text-foreground mb-3">Bremsdruckverlauf</h3>
        <div className="space-y-2">
          {lapDataArr.map(ld => (
            <div key={ld.lapKey} className="flex items-center gap-2">
              <span className="text-xs font-mono w-6 shrink-0" style={{ color: getLapColor(ld.colorIndex) }}>
                L{ld.lapNumber}
              </span>
              <div className="flex-1 relative h-5 rounded overflow-hidden bg-secondary">
                <svg width="100%" height="100%" viewBox="0 0 1000 1" preserveAspectRatio="none">
                  {ld.zones.map((z, i) => (
                    <rect
                      key={i}
                      x={z.entryDist * 1000}
                      y={0}
                      width={Math.max(2, (z.exitDist - z.entryDist) * 1000)}
                      height={1}
                      fill={`rgba(239,68,68,${0.4 + (z.peakPressure / 100) * 0.6})`}
                    />
                  ))}
                  {/* Brake zone entry markers */}
                  {ld.zones.map((z, i) => (
                    <rect key={`m${i}`} x={z.entryDist * 1000} y={0} width={1.5} height={1} fill="white" opacity={0.8} />
                  ))}
                </svg>
              </div>
              <span className="text-[10px] text-muted-foreground w-14 text-right shrink-0">
                {ld.zones.length} Zonen
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1.5 mt-3">
          <span className="text-[10px] text-muted-foreground">0%</span>
          <div className="flex-1 h-1 rounded" style={{
            background: 'linear-gradient(to right, hsl(var(--secondary)) 0%, rgba(239,68,68,0.4) 40%, rgba(239,68,68,1) 100%)'
          }} />
          <span className="text-[10px] text-muted-foreground">100% Strecke</span>
        </div>
      </div>

      {/* Track map + zone table */}
      <div className={`grid gap-4 ${tf ? 'grid-cols-[200px_1fr]' : 'grid-cols-1'}`}>

        {tf && gpsLap && (
          <div className="bg-card rounded-xl border border-border shadow-sm p-3">
            <h3 className="text-xs font-semibold text-foreground mb-2">Bremspunkte</h3>
            <svg viewBox="0 0 200 200" className="w-full" style={{ aspectRatio: '1' }}>
              {/* Downsampled track outline */}
              {Array.from({ length: Math.floor((gpsLap.lat.length - 1) / STEP) }, (_, k) => {
                const i = k * STEP
                const p1 = project(gpsLap.lat[i], gpsLap.lon[i], tf)
                const p2 = project(gpsLap.lat[i + STEP] ?? gpsLap.lat[i], gpsLap.lon[i + STEP] ?? gpsLap.lon[i], tf)
                return <line key={i} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                  stroke="rgba(150,150,150,0.3)" strokeWidth={2.5} strokeLinecap="round" />
              })}
              {/* Brake zone start circles per lap */}
              {lapDataArr.map(ld => {
                if (ld.lat.length === 0) return null
                return ld.zones.map((z, zi) => {
                  const latVal = ld.lat[z.entryIdx] ?? gpsLap.lat[0]
                  const lonVal = ld.lon[z.entryIdx] ?? gpsLap.lon[0]
                  const pt = project(latVal, lonVal, tf)
                  return (
                    <circle key={`${ld.lapKey}z${zi}`}
                      cx={pt.x} cy={pt.y} r={3.5}
                      fill={getLapColor(ld.colorIndex)}
                      stroke="white" strokeWidth={0.8} opacity={0.9}
                    />
                  )
                })
              })}
            </svg>
            <div className="flex flex-wrap gap-2 mt-1.5">
              {lapDataArr.map(ld => (
                <span key={ld.lapKey} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span className="w-2 h-2 rounded-full inline-block shrink-0"
                    style={{ background: getLapColor(ld.colorIndex) }} />
                  L{ld.lapNumber}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Zone comparison table */}
        <div className="bg-card rounded-xl border border-border shadow-sm p-4 min-w-0">
          <h3 className="text-sm font-semibold text-foreground mb-3">Zonevergleich</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-muted-foreground font-medium pb-2 pr-3">Zone</th>
                  <th className="text-left text-muted-foreground font-medium pb-2 pr-4">Pos.</th>
                  {lapDataArr.map(ld => (
                    <th key={ld.lapKey} className="text-right pb-2 pr-3 font-semibold"
                      style={{ color: getLapColor(ld.colorIndex) }}>
                      L{ld.lapNumber}
                    </th>
                  ))}
                  {lapDataArr.length >= 2 && (
                    <th className="text-right pb-2 text-muted-foreground font-medium">Δ</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {matched.map((mz, zi) => {
                  const entries = lapDataArr.map(ld => mz.entries.find(e => e.lapKey === ld.lapKey)?.zone ?? null)
                  const delta = entries[0] && entries[1]
                    ? ((entries[0].entryDist - entries[1].entryDist) * 100)
                    : null

                  return (
                    <tr key={zi} className="border-b border-border/40 last:border-0">
                      <td className="py-1.5 pr-3 text-muted-foreground font-mono">#{zi + 1}</td>
                      <td className="py-1.5 pr-4 text-muted-foreground font-mono">
                        {(mz.refDist * 100).toFixed(1)}%
                      </td>
                      {lapDataArr.map(ld => {
                        const e = mz.entries.find(l => l.lapKey === ld.lapKey)?.zone
                        return (
                          <td key={ld.lapKey} className="py-1.5 pr-3 text-right font-mono tabular-nums">
                            {e ? (
                              <span className="space-x-1">
                                <span style={{ color: getLapColor(ld.colorIndex) }}>
                                  {(e.entryDist * 100).toFixed(1)}%
                                </span>
                                <span className="text-muted-foreground/50">
                                  {e.speedAtEntry.toFixed(0)}&thinsp;km/h
                                </span>
                              </span>
                            ) : (
                              <span className="text-muted-foreground/30">–</span>
                            )}
                          </td>
                        )
                      })}
                      {lapDataArr.length >= 2 && delta !== null && (
                        <td className={`py-1.5 text-right font-mono tabular-nums text-xs ${
                          delta > 0.05 ? 'text-amber-400' : delta < -0.05 ? 'text-emerald-400' : 'text-muted-foreground'
                        }`}>
                          {delta > 0 ? '+' : ''}{delta.toFixed(2)}%
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-muted-foreground/40 mt-3">
            Δ = Differenz Bremspunkt in % der Rundenlänge · positiv = früher · negativ = später gebremst
          </p>
        </div>
      </div>
    </div>
  )
}
