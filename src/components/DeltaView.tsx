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

/** Fallback for a session that declared no sectors of its own. Even thirds are
 *  a guess, and it is better to say so by only using them when there is nothing
 *  else — iRacing's real lines are in the file for every normal session. */
const EVEN_THIRDS = [1 / 3, 2 / 3]
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

/** How far round the lap the car was, in percent, `t` seconds in — the inverse
 *  of `interpTime`, and what turns a time domain into a distance one. */
function pctAtTime(lap: LapDist, t: number): number {
  const { timestamps, samples } = lap
  const last = timestamps.length - 1
  if (last < 0) return 0
  if (t <= timestamps[0]) return samples[0] * 100
  if (t >= timestamps[last]) return samples[last] * 100
  let lo = 0, hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (timestamps[mid] <= t) lo = mid; else hi = mid
  }
  const span = timestamps[hi] - timestamps[lo]
  const f = span > 0 ? (t - timestamps[lo]) / span : 0
  return (samples[lo] + (samples[hi] - samples[lo]) * f) * 100
}

/** And back again. Clamped at both ends: the first sample is already a little
 *  past the line and the last a little short of it, and a zoom that runs to
 *  either edge must not come back as "no crossing found". */
function timeAtPct(lap: LapDist, pct: number): number {
  const t = interpTime(lap.samples, lap.timestamps, pct / 100)
  if (t !== null) return t
  return pct <= 0 ? lap.timestamps[0] : lap.timestamps[lap.timestamps.length - 1]
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

/** `bounds` are the interior sector lines — the crossings between the start and
 *  the finish, so a track with twelve sectors passes eleven of them. */
function computeSectorTimes(lap: LapDist, bounds: number[]): (number | null)[] {
  const t0 = lap.timestamps[0]
  const tEnd = lap.timestamps[lap.timestamps.length - 1]
  const times: (number | null)[] = []
  let prevT = t0
  for (const b of bounds) {
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

// Drawn in real pixels rather than a fixed viewBox that stretches to the
// container: scaled, the chart grew with the window and stood a third taller
// than the trace charts under it, with labels to match. `PL`/`PR` are the
// TraceChart paddings, so both axes stand on the same line down the page.
const PL = 44, PR = 8, PT = 8, PB = 22

/** The next round number up from `raw` — 1, 2, 2.5 or 5 times a power of ten. */
function niceStep(raw: number): number {
  if (!isFinite(raw) || raw <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const n = raw / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p
}

function DeltaChart({
  entries, refIdx, cursorPct, zoom, bounds, width, height, onHover, onZoomChange,
}: {
  entries: DeltaEntry[]
  refIdx: number
  cursorPct: number | null
  zoom: [number, number] | null
  /** Interior sector lines as lap fractions */
  bounds: number[]
  width: number
  height: number
  onHover: (pct: number | null) => void
  onZoomChange: (z: [number, number] | null) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const IW = Math.max(1, width - PL - PR)
  const IH = Math.max(1, height - PT - PB)

  // Stable refs so the wheel handler never captures stale zoom/size/callback values
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const onZoomRef = useRef(onZoomChange)
  onZoomRef.current = onZoomChange
  const geomRef = useRef({ width, IW })
  geomRef.current = { width, IW }

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
      const g = geomRef.current
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left - rect.width * PL / g.width) / (rect.width * g.IW / g.width)))
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

  // Left-click drag → pan when zoomed in, as on the trace charts. Zoomed to a
  // corner, the way to the next one was to zoom out and back in again.
  const draggingRef = useRef(false)
  useEffect(() => {
    const el = svgRef.current
    if (!el) return

    let drag: { x: number; lo: number; hi: number } | null = null

    const move = (e: MouseEvent) => {
      if (!drag) return
      const g = geomRef.current
      const rect = el.getBoundingClientRect()
      // The plot area in screen pixels — the viewBox may be scaled to fit
      const W = rect.width * g.IW / g.width
      if (W <= 0) return
      const span = drag.hi - drag.lo
      const d = -(e.clientX - drag.x) / W * span
      let lo = drag.lo + d, hi = drag.hi + d
      if (lo < 0) { lo = 0; hi = span }
      if (hi > 100) { hi = 100; lo = 100 - span }
      onZoomRef.current([lo, hi])
    }

    const up = () => {
      drag = null
      draggingRef.current = false
      el.style.cursor = zoomRef.current ? 'grab' : 'crosshair'
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }

    const down = (e: MouseEvent) => {
      if (e.button !== 0 || !zoomRef.current) return
      e.preventDefault()
      drag = { x: e.clientX, lo: zoomRef.current[0], hi: zoomRef.current[1] }
      draggingRef.current = true
      el.style.cursor = 'grabbing'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    }

    el.addEventListener('mousedown', down)
    return () => {
      el.removeEventListener('mousedown', down)
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
  }, [])

  // Set imperatively, not as a style prop: panning changes the zoom on every
  // mouse move, and a re-render would put "grab" back under a hand that is
  // already dragging
  useEffect(() => {
    const el = svgRef.current
    if (el && !draggingRef.current) el.style.cursor = zoom ? 'grab' : 'crosshair'
  }, [zoom])

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

  // Gridlines on round values — a quarter of a second, half a second — rather
  // than four even splits of whatever the range happens to be. Zero always lands
  // on one of them, so the line that separates faster from slower is a gridline
  // and not something drawn across them.
  const step = niceStep(yRange / 4)
  const decimals = step >= 1 ? 1 : step >= 0.1 ? 2 : 3
  const yTicks: number[] = []
  for (let v = Math.ceil(yMin / step) * step; v <= yMax + step * 1e-6; v += step)
    yTicks.push(Math.abs(v) < step * 1e-6 ? 0 : v)

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
    const vbX = ((e.clientX - rect.left) / rect.width) * width
    const clamped = Math.max(PL, Math.min(PL + IW, vbX))
    return zMin + ((clamped - PL) / IW) * zRange
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      className="w-full select-none"
      style={{ display: 'block', height }}
      onMouseMove={e => { if (!draggingRef.current) onHover(pctFromEvent(e)) }}
      onMouseLeave={() => { if (!draggingRef.current) onHover(null) }}
    >
      <defs>
        <clipPath id="delta-clip">
          <rect x={PL} y={PT} width={IW} height={IH} />
        </clipPath>
      </defs>

      {/* Transparent hit area so wheel/mouse events fire over empty space */}
      <rect x={0} y={0} width={width} height={height} fill="transparent" />

      {/* Horizontal grid, as on the trace charts */}
      {yTicks.map(v => (
        <line key={`g${v}`} x1={PL} y1={yS(v)} x2={width - PR} y2={yS(v)}
          stroke="hsl(var(--foreground))" strokeWidth={1} opacity={0.08} />
      ))}

      {/* Zero line, drawn over the grid: it is the one the eye reads against */}
      <line x1={PL} y1={zY} x2={width - PR} y2={zY}
        stroke="hsl(var(--foreground))" strokeWidth={1} opacity={0.3} />

      {/* Sector split lines */}
      {bounds.map((b, i) => {
        const x = xS(b * 100)
        if (x < PL || x > width - PR) return null
        return (
          <line key={i} x1={x} y1={PT} x2={x} y2={height - PB}
            stroke="hsl(var(--muted-foreground))" strokeWidth={1}
            strokeDasharray="4 3" opacity={0.4} />
        )
      })}

      {/* Sector labels, centred in their own sector. On a track with twelve of
          them the narrow ones have no room for a label and go without rather
          than overprinting their neighbours. */}
      {[0, ...bounds, 1].slice(0, -1).map((from, i) => {
        const to = [0, ...bounds, 1][i + 1]
        const x = xS((from + to) / 2 * 100)
        if (x < PL || x > width - PR) return null
        if (Math.abs(xS(to * 100) - xS(from * 100)) < 26) return null
        return (
          <text key={i} x={x} y={PT + 9} textAnchor="middle" fontSize={10}
            fill="hsl(var(--muted-foreground))" opacity={0.6}>S{i + 1}</text>
        )
      })}

      {/* Y axis labels — one per gridline, signed, because which side of zero a
          value is on is the whole reading */}
      {yTicks.map(v => (
        <text key={`l${v}`} x={PL - 5} y={yS(v) + 3.5} textAnchor="end" fontSize={10}
          fill="hsl(var(--muted-foreground))">
          {v > 0 ? '+' : ''}{v.toFixed(decimals)}
        </text>
      ))}

      {/* X axis labels — show actual pct values within zoom range */}
      {[0, 25, 50, 75, 100].map(v => {
        const actualPct = zMin + (v / 100) * zRange
        const x = xS(actualPct)
        if (x < PL - 5 || x > width - PR + 5) return null
        return (
          <text key={v} x={x} y={height - PB + 14}
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
            x2={xS(cursorPct)} y2={height - PB}
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

// ── Data ───────────────────────────────────────────────────────────────────────

/** Everything the delta views read: the laps, which one is the reference, and
 *  the two-way link between the chart's x position and the shared crosshair.
 *  Split out from the view because the chart card is shown in two places. */
function useDeltaData(withPath = true) {
  const { sessions, selectedLapKeys, crosshairTime, setCrosshairTime } = useSessionStore()
  const [entries, setEntries] = useState<DeltaEntry[]>([])
  // Position of the reference lap, for the map. Fetched separately because the
  // delta itself needs only lap distance.
  const [refPath, setRefPath] = useState<{ lat: number[]; lon: number[]; pct: number[] } | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'nodata'>('idle')

  const lapKeyStr = selectedLapKeys.join(',')

  // iRacing's own sector lines, taken from the session the first selected lap
  // came from. The leading 0 is a start point, not a crossing, so it goes.
  //
  // Keyed on a string rather than the sessions array: the bounds feed the
  // loading effect below, and an array that is rebuilt on every render would
  // restart that effect on every render with it.
  const sectorKey = (() => {
    const first = selectedLapKeys[0]
    const session = first ? sessions.find(s => s.id === parseLapKey(first).sessionId) : undefined
    return (session?.sector_starts ?? []).filter(v => v > 1e-4 && v < 1).join(',')
  })()
  const sectorBounds = useMemo(
    () => (sectorKey ? sectorKey.split(',').map(Number) : EVEN_THIRDS),
    [sectorKey],
  )

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
          ? [{ lap: laps[0], deltaPoints: [], sectorTimes: computeSectorTimes(laps[0], sectorBounds) }]
          : [])
        return
      }

      const refIdx = laps.reduce((bi, l, i) => l.lapTime < laps[bi].lapTime ? i : bi, 0)
      const ref = laps[refIdx]

      setEntries(laps.map((lap, i) => ({
        lap,
        deltaPoints: i !== refIdx ? computeDeltaPoints(ref, lap) : [],
        sectorTimes: computeSectorTimes(lap, sectorBounds),
      })))
      setStatus('ok')

      // Only the delta map reads the reference lap's position, so the chart on
      // its own does not pay for two more channel fetches
      if (!withPath) return

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
  }, [lapKeyStr, sessions.length, sectorKey])

  // Derive refIdx (non-hook, safe before early returns)
  const refIdx = entries.length >= 2
    ? entries.reduce((bi, e, i) => e.lap.lapTime < entries[bi].lap.lapTime ? i : bi, 0)
    : 0

  // The lap the trace charts scale their x axis by: TraceChart takes whichever
  // selected lap has the most samples, and every channel of a lap is sampled
  // together, so counting LapDistPct picks the same one. Both the crosshair and
  // the zoom convert through it — through any other lap they would land a slice
  // of a lap time out from the traces, and from each other.
  const baseLap = entries.length
    ? entries.reduce((a, b) =>
        a.lap.timestamps.length >= b.lap.timestamps.length ? a : b).lap
    : null

  // crosshairTime (seconds into the lap) → LapDistPct
  const cursorPct = useMemo(
    () => (crosshairTime == null || !baseLap || entries.length < 2
      ? null
      : pctAtTime(baseLap, crosshairTime)),
    [crosshairTime, baseLap, entries.length],
  )

  // Hovered LapDistPct → timestamp → sync crosshairTime (drives track map + telemetry charts)
  const handleHover = (pct: number | null) => {
    if (pct === null || !baseLap || entries.length < 2) return
    setCrosshairTime(timeAtPct(baseLap, pct))
  }

  return {
    selectedLapKeys, lapKeyStr, entries, refIdx, refPath, status,
    sectorBounds, cursorPct, handleHover, baseLap,
  }
}

// ── Chart card ─────────────────────────────────────────────────────────────────

/** The delta chart with its header and legend. Built like a TraceChart card —
 *  same padding, same header, same plot height — so a row of them reads as one
 *  stack. The zoom is the caller's: on the Delta tab it is the card's own, on
 *  the General tab it is the one the traces share. */
export function DeltaChartCard({
  entries, refIdx, cursorPct, bounds, zoom, height = 130, showHint = false, onHover, onZoomChange,
}: {
  entries: DeltaEntry[]
  refIdx: number
  cursorPct: number | null
  bounds: number[]
  zoom: [number, number] | null
  height?: number
  showHint?: boolean
  onHover: (pct: number | null) => void
  onZoomChange: (z: [number, number] | null) => void
}) {
  const t = useT()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  // The chart draws in pixels, so it has to be told how many it has
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() =>
      setWidth(Math.max(1, Math.round(el.getBoundingClientRect().width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="bg-card rounded-xl border border-border shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">
          Delta<span className="text-xs font-normal text-muted-foreground ml-1">(s)</span>
        </h3>
        <div className="flex items-center gap-3">
          {entries.map((e, i) => (
            <span key={e.lap.key} className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="inline-block w-3 h-0.5 rounded"
                style={{ background: getLapColor(e.lap.colorIndex) }} />
              L{e.lap.lapNumber}{i === refIdx ? ' ★' : ''}
            </span>
          ))}
        </div>
      </div>
      <div ref={wrapRef} style={{ height }}>
        {width > 0 && (
          <DeltaChart
            entries={entries}
            refIdx={refIdx}
            cursorPct={cursorPct}
            zoom={zoom}
            bounds={bounds}
            width={width}
            height={height}
            onHover={onHover}
            onZoomChange={onZoomChange}
          />
        )}
      </div>
      {showHint && (
        <p className="text-[10px] text-muted-foreground/50 mt-2">
          ★ = {t('refLap')} · {t('deltaHint')}
        </p>
      )}
    </div>
  )
}

/** The same card for tabs that are about something else — it sits above the
 *  traces there, so it stays quiet: no placeholders, nothing at all until there
 *  are two laps to compare.
 *
 *  Its zoom is the traces' zoom, converted at the edges: they scale in seconds
 *  into the lap, the delta in distance round it, and scrolling one without the
 *  other left two charts above each other showing different corners. */
export function DeltaOverviewCard({ onZoomTime }: {
  onZoomTime: (domain: [number, number] | null) => void
}) {
  const { entries, refIdx, status, sectorBounds, cursorPct, handleHover, baseLap } = useDeltaData(false)
  const zoomDomain = useSessionStore(s => s.zoomDomain)

  if (status !== 'ok' || entries.length < 2 || !baseLap) return null

  const zoom: [number, number] | null = zoomDomain
    ? [pctAtTime(baseLap, zoomDomain[0]), pctAtTime(baseLap, zoomDomain[1])]
    : null

  const handleZoom = (z: [number, number] | null) => {
    if (!z) { onZoomTime(null); return }
    const lo = timeAtPct(baseLap, z[0]), hi = timeAtPct(baseLap, z[1])
    onZoomTime(hi > lo ? [lo, hi] : null)
  }

  return (
    <DeltaChartCard
      entries={entries}
      refIdx={refIdx}
      cursorPct={cursorPct}
      bounds={sectorBounds}
      zoom={zoom}
      onHover={handleHover}
      onZoomChange={handleZoom}
    />
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function DeltaView() {
  const t = useT()
  const {
    selectedLapKeys, lapKeyStr, entries, refIdx, refPath, status,
    sectorBounds, cursorPct, handleHover,
  } = useDeltaData()

  // This tab has no traces to keep in step, so the zoom is the chart's own
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  useEffect(() => { setZoom(null) }, [lapKeyStr])

  if (!selectedLapKeys.length)
    return <div className="flex-1 flex items-center justify-center"><p className="text-sm text-muted-foreground">{t('selectLapsCompare')}</p></div>
  if (status === 'loading')
    return <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted-foreground">{t('loading')}</p></div>
  if (status === 'nodata' || !entries.length)
    return <div className="flex-1 flex items-center justify-center"><p className="text-sm text-muted-foreground">{t('noLapDistData')}</p></div>
  if (entries.length < 2)
    return <div className="flex-1 flex items-center justify-center"><p className="text-sm text-muted-foreground">{t('selectLapsCompare')}</p></div>

  const nSectors = sectorBounds.length + 1
  const bestSector = Array.from({ length: nSectors }, (_, si) =>
    Math.min(...entries.map(e => e.sectorTimes[si] ?? Infinity))
  )
  const fastestTotal = Math.min(...entries.map(e => e.lap.lapTime))

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-background">

      {/* Delta chart card */}
      <DeltaChartCard
        entries={entries}
        refIdx={refIdx}
        cursorPct={cursorPct}
        bounds={sectorBounds}
        zoom={zoom}
        height={200}
        showHint
        onHover={handleHover}
        onZoomChange={setZoom}
      />

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

        {Array.from({ length: nSectors }, (_, si) => {
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
