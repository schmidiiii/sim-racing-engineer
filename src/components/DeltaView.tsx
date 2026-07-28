import { useEffect, useState, useMemo, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, parseLapKey, getLapColor } from '@/store/session'
import { useT } from '@/lib/i18n'

interface LapChannelData {
  lap_number: number
  channel: string
  samples: number[]
  timestamps: number[]
}

interface LapDist {
  key: string
  sessionId: string
  lapNumber: number
  colorIndex: number
  lapTime: number
  samples: number[]    // LapDistPct 0–1
  timestamps: number[] // absolute session timestamps
}

type DeltaEntry = {
  lap: LapDist
  deltaPoints: { pct: number; delta: number }[]
  sectorTimes: (number | null)[]
}

const SECTOR_BOUNDS = [1 / 3, 2 / 3] as const
const N_DELTA = 500

function interpTime(samples: number[], ts: number[], dist: number): number | null {
  for (let i = 0; i < samples.length - 1; i++) {
    if (samples[i] <= dist && samples[i + 1] > dist) {
      const f = (dist - samples[i]) / (samples[i + 1] - samples[i])
      return ts[i] + f * (ts[i + 1] - ts[i])
    }
  }
  return null
}

function computeDeltaPoints(ref: LapDist, other: LapDist): DeltaEntry['deltaPoints'] {
  const refT0 = ref.timestamps[0]
  const othT0 = other.timestamps[0]
  const pts: { pct: number; delta: number }[] = []
  for (let i = 0; i < N_DELTA; i++) {
    const dist = (i / (N_DELTA - 1)) * 0.998
    const refT = interpTime(ref.samples, ref.timestamps, dist)
    const othT = interpTime(other.samples, other.timestamps, dist)
    if (refT !== null && othT !== null)
      pts.push({ pct: dist * 100, delta: (othT - othT0) - (refT - refT0) })
  }
  return pts
}

function computeSectorTimes(lap: LapDist): (number | null)[] {
  const t0 = lap.timestamps[0]
  const tEnd = lap.timestamps[lap.timestamps.length - 1]
  const times: (number | null)[] = []
  let prevT = t0
  for (const b of SECTOR_BOUNDS) {
    const absT = interpTime(lap.samples, lap.timestamps, b)
    if (absT !== null) { times.push(absT - prevT); prevT = absT }
    else times.push(null)
  }
  times.push(tEnd - prevT)
  return times
}

function fmtT(t: number | null): string {
  if (t === null || t < 0.001) return '–'
  if (t >= 60) return `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`
  return t.toFixed(3)
}

// ── Chart ─────────────────────────────────────────────────────────────────────

const VW = 1000, VH = 140, PL = 48, PR = 8, PT = 8, PB = 22
const IW = VW - PL - PR, IH = VH - PT - PB

function DeltaChart({
  entries, refIdx, cursorPct, zoom, onHover, onZoomChange,
}: {
  entries: DeltaEntry[]
  refIdx: number
  cursorPct: number | null
  zoom: [number, number] | null
  onHover: (pct: number | null) => void
  onZoomChange: (z: [number, number] | null) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)

  // Stable refs so the wheel handler never captures stale zoom/callback values
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const onZoomRef = useRef(onZoomChange)
  onZoomRef.current = onZoomChange

  // Scroll-to-zoom — same logic as TraceChart but in pct space [0, 100]
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const [zMin, zMax] = zoomRef.current ?? [0, 100]
      const span = zMax - zMin
      const factor = e.deltaY > 0 ? 1.25 : 0.8
      const newSpan = Math.min(span * factor, 100)
      const rect = el.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left - rect.width * PL / VW) / (rect.width * IW / VW)))
      const center = zMin + ratio * span
      let lo = center - ratio * newSpan
      let hi = center + (1 - ratio) * newSpan
      if (lo < 0) { hi = Math.min(100, hi - lo); lo = 0 }
      if (hi > 100) { lo = Math.max(0, lo - (hi - 100)); hi = 100 }
      onZoomRef.current(hi - lo >= 99.9 ? null : [lo, hi])
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const nonRef = entries.filter((_, i) => i !== refIdx && entries[i].deltaPoints.length > 0)
  if (!nonRef.length) return null

  const [zMin, zMax] = zoom ?? [0, 100]
  const zRange = zMax - zMin

  // y-scale from visible points, fall back to all points
  const visibleD = nonRef.flatMap(e =>
    e.deltaPoints.filter(p => p.pct >= zMin && p.pct <= zMax).map(p => p.delta)
  )
  const allD = nonRef.flatMap(e => e.deltaPoints.map(p => p.delta))
  const scaleD = visibleD.length > 0 ? visibleD : allD
  const maxD = Math.max(...scaleD, 0.2)
  const minD = Math.min(...scaleD, 0)
  const vPad = Math.max((maxD - minD) * 0.12, 0.15)
  const yMax = maxD + vPad, yMin = minD - vPad, yRange = yMax - yMin

  const xS = (pct: number) => PL + ((pct - zMin) / zRange) * IW
  const yS = (d: number) => PT + ((yMax - d) / yRange) * IH
  const zY = yS(0)
  const buf = zRange * 0.01

  // Interpolated, not the nearest point: the series is sampled every fraction of
  // a percent and the nearest one can be several hundredths of a second away.
  const deltaAt = (pts: { pct: number; delta: number }[], pct: number): number | null => {
    if (pts.length === 0) return null
    if (pct <= pts[0].pct) return pts[0].delta
    if (pct >= pts[pts.length - 1].pct) return pts[pts.length - 1].delta
    let lo = 0, hi = pts.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (pts[mid].pct <= pct) lo = mid; else hi = mid
    }
    const a = pts[lo], b = pts[hi]
    const span = b.pct - a.pct
    return span > 0 ? a.delta + (b.delta - a.delta) * ((pct - a.pct) / span) : a.delta
  }

  const pctFromEvent = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const vbX = ((e.clientX - rect.left) / rect.width) * VW
    const clamped = Math.max(PL, Math.min(PL + IW, vbX))
    return zMin + ((clamped - PL) / IW) * zRange
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VW} ${VH}`}
      className="w-full cursor-crosshair select-none"
      style={{ display: 'block' }}
      onMouseMove={e => onHover(pctFromEvent(e))}
      onMouseLeave={() => onHover(null)}
    >
      <defs>
        <clipPath id="delta-clip">
          <rect x={PL} y={PT} width={IW} height={IH} />
        </clipPath>
      </defs>

      {/* Transparent hit area so wheel/mouse events fire over empty space */}
      <rect x={0} y={0} width={VW} height={VH} fill="transparent" />

      {/* Zero line */}
      <line x1={PL} y1={zY} x2={VW - PR} y2={zY}
        stroke="hsl(var(--foreground))" strokeWidth={1} opacity={0.3} />

      {/* Sector split lines */}
      {SECTOR_BOUNDS.map((b, i) => {
        const x = xS(b * 100)
        if (x < PL || x > VW - PR) return null
        return (
          <line key={i} x1={x} y1={PT} x2={x} y2={VH - PB}
            stroke="hsl(var(--muted-foreground))" strokeWidth={1}
            strokeDasharray="4 3" opacity={0.4} />
        )
      })}

      {/* Sector labels */}
      {[16.5, 50, 83].map((center, i) => {
        const x = xS(center)
        if (x < PL || x > VW - PR) return null
        return (
          <text key={i} x={x} y={PT + 11} textAnchor="middle" fontSize={11}
            fill="hsl(var(--muted-foreground))" opacity={0.6}>S{i + 1}</text>
        )
      })}

      {/* Y axis labels */}
      <text x={PL - 5} y={zY + 4} textAnchor="end" fontSize={10} fill="hsl(var(--muted-foreground))">0</text>
      <text x={PL - 5} y={yS(maxD) + 4} textAnchor="end" fontSize={10} fill="hsl(var(--muted-foreground))">
        +{maxD.toFixed(2)}
      </text>
      {minD < -0.05 && (
        <text x={PL - 5} y={yS(minD) + 4} textAnchor="end" fontSize={10} fill="hsl(var(--muted-foreground))">
          {minD.toFixed(2)}
        </text>
      )}

      {/* X axis labels — show actual pct values within zoom range */}
      {[0, 25, 50, 75, 100].map(v => {
        const actualPct = zMin + (v / 100) * zRange
        const x = xS(actualPct)
        if (x < PL - 5 || x > VW - PR + 5) return null
        return (
          <text key={v} x={x} y={VH - PB + 14}
            textAnchor="middle" fontSize={10} fill="hsl(var(--muted-foreground))">
            {actualPct.toFixed(0)}%
          </text>
        )
      })}

      {/* Delta fill + line split at zero: green = faster, red = slower */}
      <g clipPath="url(#delta-clip)">
        {nonRef.map(({ lap, deltaPoints }) => {
          const visible = deltaPoints.filter(p => p.pct >= zMin - buf && p.pct <= zMax + buf)
          if (visible.length < 2) return null

          // Split into contiguous segments, inserting zero-crossings as interpolated points
          type Pt = { pct: number; delta: number }
          const segments: { pts: Pt[]; positive: boolean }[] = []
          let current: Pt[] = [visible[0]]
          let isPos = visible[0].delta >= 0

          for (let i = 1; i < visible.length; i++) {
            const prev = visible[i - 1], cur = visible[i]
            const crossesZero = (prev.delta >= 0) !== (cur.delta >= 0)
            if (crossesZero) {
              // Interpolate exact zero crossing
              const t = prev.delta / (prev.delta - cur.delta)
              const crossPct = prev.pct + t * (cur.pct - prev.pct)
              current.push({ pct: crossPct, delta: 0 })
              segments.push({ pts: current, positive: isPos })
              isPos = !isPos
              current = [{ pct: crossPct, delta: 0 }, cur]
            } else {
              current.push(cur)
            }
          }
          segments.push({ pts: current, positive: isPos })

          return (
            <g key={lap.key}>
              {segments.map((seg, si) => {
                if (seg.pts.length < 2) return null
                const color = seg.positive ? '#ef4444' : '#22c55e'
                const lineD = seg.pts.map((p, i) =>
                  `${i === 0 ? 'M' : 'L'}${xS(p.pct).toFixed(1)} ${yS(p.delta).toFixed(1)}`
                ).join(' ')
                const fillD = [
                  `M${xS(seg.pts[0].pct).toFixed(1)} ${zY.toFixed(1)}`,
                  ...seg.pts.map(p => `L${xS(p.pct).toFixed(1)} ${yS(p.delta).toFixed(1)}`),
                  `L${xS(seg.pts[seg.pts.length - 1].pct).toFixed(1)} ${zY.toFixed(1)} Z`,
                ].join(' ')
                return (
                  <g key={si}>
                    <path d={fillD} fill={color} opacity={0.15} />
                    <path d={lineD} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
                  </g>
                )
              })}
            </g>
          )
        })}
      </g>

      {/* Crosshair cursor line (synced from crosshairTime via reference lap),
          with each lap's delta read off at that point. The line alone showed
          where you were but not what it was worth. */}
      {cursorPct !== null && cursorPct >= zMin && cursorPct <= zMax && (
        <g>
          <line
            x1={xS(cursorPct)} y1={PT}
            x2={xS(cursorPct)} y2={VH - PB}
            stroke="hsl(var(--foreground))" strokeWidth={1.5}
            opacity={0.5} strokeDasharray="3 2"
          />
          {nonRef.map((e, i) => {
            const d = deltaAt(e.deltaPoints, cursorPct)
            if (d === null) return null
            const y = yS(d)
            // Same red-slower / green-faster reading as the line itself
            const col = d >= 0 ? '#ef4444' : '#22c55e'
            // Flip the label to the left near the right edge so it stays inside
            const right = xS(cursorPct) > PL + IW * 0.8
            return (
              <g key={i}>
                <circle cx={xS(cursorPct)} cy={y} r={3} fill={col} />
                <text
                  x={xS(cursorPct) + (right ? -6 : 6)}
                  y={y - 5}
                  textAnchor={right ? 'end' : 'start'}
                  className="text-[9px] font-semibold"
                  fill={col}
                  style={{ paintOrder: 'stroke', stroke: 'hsl(var(--background))', strokeWidth: 3 }}
                >
                  {d >= 0 ? '+' : ''}{d.toFixed(3)}s
                </text>
              </g>
            )
          })}
        </g>
      )}
    </svg>
  )
}

// ── Delta map ──────────────────────────────────────────────────────────────────
//
// The chart says how much time is in it; this says where. Each piece of track is
// coloured by how fast the gap is opening or closing *there* — the slope of the
// delta, not its value. A lap that is half a second down all the way round is
// losing nothing through the last sector, and colouring by the raw gap would
// paint the whole of it red.
function DeltaMap({ path, points, cursorPct }: {
  path: { lat: number[]; lon: number[]; pct: number[] }
  points: { pct: number; delta: number }[]
  cursorPct: number | null
}) {
  const W = 560, H = 300, PAD = 18

  const geom = useMemo(() => {
    const { lat, lon } = path
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity
    for (let i = 0; i < lat.length; i++) {
      if (lat[i] < minLat) minLat = lat[i]
      if (lat[i] > maxLat) maxLat = lat[i]
      if (lon[i] < minLon) minLon = lon[i]
      if (lon[i] > maxLon) maxLon = lon[i]
    }
    // A degree of longitude is cos(latitude) as long as one of latitude — without
    // this the track comes out stretched east to west
    const cosLat = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180)
    const w = (maxLon - minLon) * cosLat || 1e-9
    const h = (maxLat - minLat) || 1e-9
    const scale = Math.min((W - PAD * 2) / w, (H - PAD * 2) / h)
    const ox = (W - w * scale) / 2, oy = (H - h * scale) / 2
    return {
      x: (lo: number) => ox + (lo - minLon) * cosLat * scale,
      y: (la: number) => H - oy - (la - minLat) * scale,
    }
  }, [path])

  // Slope of the delta over the lap, sampled on the same grid as the path
  const slope = useMemo(() => {
    if (points.length < 3) return null
    const at = (pct: number) => {
      if (pct <= points[0].pct) return points[0].delta
      if (pct >= points[points.length - 1].pct) return points[points.length - 1].delta
      let lo = 0, hi = points.length - 1
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (points[m].pct <= pct) lo = m; else hi = m }
      const a = points[lo], b = points[hi], span = b.pct - a.pct
      return span > 0 ? a.delta + (b.delta - a.delta) * ((pct - a.pct) / span) : a.delta
    }
    // Over a window rather than point to point: at this sampling the difference
    // between neighbours is mostly noise
    const WIN = 1.5
    const vals = path.pct.map(p => at(Math.min(100, p + WIN)) - at(Math.max(0, p - WIN)))
    const mag = vals.map(Math.abs).sort((a, b) => a - b)
    const strong = mag[Math.floor(mag.length * 0.92)] || 1e-6
    return { vals, strong }
  }, [points, path])

  const segs: { d: string; col: string }[] = []
  const STEP = Math.max(1, Math.round(path.lat.length / 400))
  for (let i = STEP; i < path.lat.length; i += STEP) {
    const a = i - STEP
    const x1 = geom.x(path.lon[a]), y1 = geom.y(path.lat[a])
    const x2 = geom.x(path.lon[i]), y2 = geom.y(path.lat[i])
    let col = 'hsl(var(--muted-foreground))'
    if (slope) {
      const v = slope.vals[i] / slope.strong
      const t = Math.max(-1, Math.min(1, v))
      // Grey where nothing is happening, so the places that matter stand out
      col = Math.abs(t) < 0.18 ? 'hsl(var(--muted-foreground) / 0.35)'
          : t > 0 ? `rgba(239, 68, 68, ${(0.35 + Math.abs(t) * 0.65).toFixed(2)})`
                  : `rgba(34, 197, 94, ${(0.35 + Math.abs(t) * 0.65).toFixed(2)})`
    }
    segs.push({ d: `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`, col })
  }

  // Where the chart's crosshair sits, on the track. The lap position is the one
  // thing both views share, so it is what ties them together.
  let marker: { x: number; y: number } | null = null
  if (cursorPct !== null && path.pct.length > 1) {
    let lo = 0, hi = path.pct.length - 1
    if (cursorPct <= path.pct[0]) hi = 1
    else if (cursorPct >= path.pct[hi]) lo = hi - 1
    else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (path.pct[m] <= cursorPct) lo = m; else hi = m }
    const span = path.pct[hi] - path.pct[lo]
    const t = span > 0 ? Math.max(0, Math.min(1, (cursorPct - path.pct[lo]) / span)) : 0
    const x1 = geom.x(path.lon[lo]), y1 = geom.y(path.lat[lo])
    const x2 = geom.x(path.lon[hi]), y2 = geom.y(path.lat[hi])
    marker = { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t }
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" style={{ maxHeight: 320 }}>
      {segs.map((sg, i) => (
        <path key={i} d={sg.d} stroke={sg.col} strokeWidth={5} strokeLinecap="round" fill="none" />
      ))}
      {marker && (
        <g>
          {/* Ringed in the background colour so it stays visible whichever
              colour the track happens to be underneath it */}
          <circle cx={marker.x} cy={marker.y} r={6} fill="hsl(var(--background))" opacity={0.9} />
          <circle cx={marker.x} cy={marker.y} r={4} fill="hsl(var(--foreground))" />
        </g>
      )}
    </svg>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function DeltaView() {
  const t = useT()
  const { sessions, selectedLapKeys, crosshairTime, setCrosshairTime } = useSessionStore()
  const [entries, setEntries] = useState<DeltaEntry[]>([])
  // Position of the reference lap, for the map. Fetched separately because the
  // delta itself needs only lap distance.
  const [refPath, setRefPath] = useState<{ lat: number[]; lon: number[]; pct: number[] } | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'nodata'>('idle')
  const [zoom, setZoom] = useState<[number, number] | null>(null)

  const lapKeyStr = selectedLapKeys.join(',')

  useEffect(() => {
    setZoom(null)
  }, [lapKeyStr])

  useEffect(() => {
    if (!selectedLapKeys.length) { setStatus('idle'); return }
    setStatus('loading')

    const fetchAll = async () => {
      for (const key of selectedLapKeys) {
        const { sessionId } = parseLapKey(key)
        const session = sessions.find(s => s.id === sessionId)
        if (session && !session.available_channels.some(c => c.name === 'LapDistPct')) {
          setStatus('nodata'); setEntries([]); return
        }
      }

      const raw = await Promise.all(
        selectedLapKeys.map(async (key, i) => {
          const { sessionId, lapNumber } = parseLapKey(key)
          const session = sessions.find(s => s.id === sessionId)
          if (!session) return null
          const lap = session.laps.find(l => l.lap_number === lapNumber)
          if (!lap || !lap.is_valid || lap.lap_time < 10) return null
          try {
            const res = await invoke<LapChannelData[]>('get_lap_channel_data', {
              sessionId, lapNumbers: [lapNumber], channel: 'LapDistPct',
            })
            const d = res[0]
            if (!d) return null
            return {
              key, sessionId, lapNumber, colorIndex: i,
              lapTime: lap.lap_time, samples: d.samples, timestamps: d.timestamps,
            } satisfies LapDist
          } catch { return null }
        })
      )

      const laps = raw.filter((l): l is LapDist => l !== null)
      if (laps.length < 2) {
        setStatus(laps.length ? 'ok' : 'nodata')
        setEntries(laps.length === 1
          ? [{ lap: laps[0], deltaPoints: [], sectorTimes: computeSectorTimes(laps[0]) }]
          : [])
        return
      }

      const refIdx = laps.reduce((bi, l, i) => l.lapTime < laps[bi].lapTime ? i : bi, 0)
      const ref = laps[refIdx]

      setEntries(laps.map((lap, i) => ({
        lap,
        deltaPoints: i !== refIdx ? computeDeltaPoints(ref, lap) : [],
        sectorTimes: computeSectorTimes(lap),
      })))
      setStatus('ok')

      try {
        const [la, lo] = await Promise.all(['Lat', 'Lon'].map(ch =>
          invoke<LapChannelData[]>('get_lap_channel_data',
            { sessionId: ref.sessionId, lapNumbers: [ref.lapNumber], channel: ch })))
        if (la[0] && lo[0] && la[0].samples.length === ref.samples.length)
          setRefPath({ lat: la[0].samples, lon: lo[0].samples, pct: ref.samples.map(v => v * 100) })
        else setRefPath(null)
      } catch { setRefPath(null) }
    }

    fetchAll()
  }, [lapKeyStr, sessions.length])

  // Derive refIdx (non-hook, safe before early returns)
  const refIdx = entries.length >= 2
    ? entries.reduce((bi, e, i) => e.lap.lapTime < entries[bi].lap.lapTime ? i : bi, 0)
    : 0

  // Convert crosshairTime → LapDistPct via binary search on reference lap timestamps
  const cursorPct = useMemo(() => {
    if (crosshairTime == null || entries.length < 2) return null
    const ref = entries[refIdx]
    if (!ref) return null
    const { timestamps, samples } = ref.lap
    let lo = 0, hi = timestamps.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (timestamps[mid] <= crosshairTime) lo = mid
      else hi = mid
    }
    const idx = Math.abs(timestamps[lo] - crosshairTime) <= Math.abs(timestamps[hi] - crosshairTime) ? lo : hi
    return samples[idx] * 100
  }, [crosshairTime, entries, refIdx])

  // Hovered LapDistPct → timestamp → sync crosshairTime (drives track map + telemetry charts)
  const handleHover = (pct: number | null) => {
    if (pct === null || entries.length < 2) return
    const ref = entries[refIdx]
    if (!ref) return
    const time = interpTime(ref.lap.samples, ref.lap.timestamps, pct / 100)
    if (time !== null) setCrosshairTime(time)
  }

  if (!selectedLapKeys.length)
    return <div className="flex-1 flex items-center justify-center"><p className="text-sm text-muted-foreground">{t('selectLapsCompare')}</p></div>
  if (status === 'loading')
    return <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted-foreground">{t('loading')}</p></div>
  if (status === 'nodata' || !entries.length)
    return <div className="flex-1 flex items-center justify-center"><p className="text-sm text-muted-foreground">{t('noLapDistData')}</p></div>
  if (entries.length < 2)
    return <div className="flex-1 flex items-center justify-center"><p className="text-sm text-muted-foreground">{t('selectLapsCompare')}</p></div>

  const bestSector = [0, 1, 2].map(si =>
    Math.min(...entries.map(e => e.sectorTimes[si] ?? Infinity))
  )
  const fastestTotal = Math.min(...entries.map(e => e.lap.lapTime))

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-background">

      {/* Delta chart card */}
      <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="flex items-center px-4 py-2.5 border-b border-border gap-4">
          <p className="flex-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Delta</p>
          {entries.map((e, i) => (
            <span key={e.lap.key} className="text-[10px] font-bold flex items-center gap-1"
              style={{ color: getLapColor(e.lap.colorIndex) }}>
              L{e.lap.lapNumber}{i === refIdx ? ' ★' : ''}
            </span>
          ))}
        </div>
        <div className="px-3 py-2">
          <DeltaChart
            entries={entries}
            refIdx={refIdx}
            cursorPct={cursorPct}
            zoom={zoom}
            onHover={handleHover}
            onZoomChange={setZoom}
          />
        </div>
        <p className="text-[10px] text-muted-foreground/50 px-4 pb-2">
          ★ = {t('refLap')} · {t('deltaHint')}
        </p>
      </div>

      {/* Where the time went, on the track itself */}
      {refPath && entries.some(e => e.deltaPoints.length > 0) && (
        <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
          <div className="flex items-center px-4 py-2.5 border-b border-border">
            <p className="flex-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('deltaMap')}
            </p>
            <span className="text-[9px] text-muted-foreground/60">
              <span className="text-red-500">■</span> {t('losing')}
              {'  '}
              <span className="text-green-500">■</span> {t('gaining')}
            </span>
          </div>
          <div className="p-3">
            <DeltaMap
              path={refPath}
              points={(entries.find(e => e.deltaPoints.length > 0) ?? entries[0]).deltaPoints}
              cursorPct={cursorPct}
            />
          </div>
          <p className="text-[10px] text-muted-foreground/50 px-4 pb-2">{t('deltaMapHint')}</p>
        </div>
      )}

      {/* Sector table card */}
      <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="flex items-center px-4 py-2.5 border-b border-border">
          <p className="flex-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('sectors')}</p>
          {entries.map((e, i) => (
            <span key={e.lap.key} className="w-28 text-right text-[10px] font-bold"
              style={{ color: getLapColor(e.lap.colorIndex) }}>
              L{e.lap.lapNumber}{i === refIdx ? ' ★' : ''}
            </span>
          ))}
        </div>

        {[0, 1, 2].map(si => {
          const best = bestSector[si]
          return (
            <div key={si} className="flex items-center px-4 py-1.5 border-b border-border/20 last:border-0">
              <span className="flex-1 text-xs font-semibold text-muted-foreground">S{si + 1}</span>
              {entries.map(e => {
                const st = e.sectorTimes[si]
                const isBest = st !== null && best !== Infinity && Math.abs(st - best) < 0.0005
                const delta = st !== null && best !== Infinity ? st - best : null
                return (
                  <div key={e.lap.key} className="w-28 text-right">
                    <span className={`block text-xs font-mono tabular-nums ${isBest ? 'text-emerald-500 font-bold' : 'text-foreground'}`}>
                      {fmtT(st)}
                    </span>
                    {!isBest && delta !== null && delta > 0.0005 && (
                      <span className="block text-[10px] font-mono text-destructive/70">+{delta.toFixed(3)}</span>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}

        {/* Total row */}
        <div className="flex items-center px-4 py-2 border-t border-border">
          <span className="flex-1 text-xs font-semibold text-foreground">{t('lapTotal')}</span>
          {entries.map(e => {
            const isFastest = Math.abs(e.lap.lapTime - fastestTotal) < 0.0005
            const delta = !isFastest ? e.lap.lapTime - fastestTotal : null
            return (
              <div key={e.lap.key} className="w-28 text-right">
                <span className={`block text-xs font-mono tabular-nums ${isFastest ? 'text-emerald-500 font-bold' : 'text-foreground'}`}>
                  {fmtT(e.lap.lapTime)}
                </span>
                {delta !== null && delta > 0.0005 && (
                  <span className="block text-[10px] font-mono text-destructive/70">+{delta.toFixed(3)}</span>
                )}
              </div>
            )
          })}
        </div>
      </div>

    </div>
  )
}
