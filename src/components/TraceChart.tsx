import { useCallback, useEffect, useMemo, useRef } from 'react'
import { getLapColor } from '@/store/session'
import { channelLabel } from '@/lib/channelGroups'

export interface LapTrace {
  lapNumber: number
  colorIndex: number
  samples: number[]
  timestamps: number[]
  lapDistPct?: number[]
}

type DataPt = Record<string, number>

// ── Data preparation ──────────────────────────────────────────────────────────

const MAX_PTS = 1200

// Binary search: index of sample in `distArr` closest to `target`
function nearestDistIdx(distArr: number[], target: number): number {
  let lo = 0, hi = distArr.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (distArr[mid] < target) lo = mid + 1; else hi = mid
  }
  if (lo > 0 && Math.abs(distArr[lo - 1] - target) < Math.abs(distArr[lo] - target)) return lo - 1
  return lo
}

function buildData(traces: LapTrace[]): DataPt[] {
  if (!traces.length) return []
  // Use the lap with the most samples as the X-axis reference
  const base = traces.reduce((a, b) => a.timestamps.length >= b.timestamps.length ? a : b)
  const n = base.timestamps.length
  const step = n <= MAX_PTS ? 1 : Math.ceil(n / MAX_PTS)
  const hasDistPct = !!base.lapDistPct && traces.every(tr => !!tr.lapDistPct)
  const out: DataPt[] = []
  for (let i = 0; i < n; i += step) {
    const pt: DataPt = { t: base.timestamps[i] }
    const baseDist = hasDistPct ? base.lapDistPct![i] : undefined
    for (const tr of traces) {
      let idx: number
      if (tr === base) {
        idx = i
      } else if (baseDist !== undefined && tr.lapDistPct) {
        // Align by actual track position — no drift from speed differences
        idx = nearestDistIdx(tr.lapDistPct, baseDist)
      } else {
        // Fallback: proportional mapping
        idx = tr.samples.length <= 1
          ? 0
          : Math.min(Math.round(i * (tr.samples.length - 1) / (n - 1)), tr.samples.length - 1)
      }
      pt[`t_${tr.colorIndex}`] = tr.samples[idx]
    }
    out.push(pt)
  }
  return out
}

function sliceVisible(data: DataPt[], domain: [number, number] | null): DataPt[] {
  if (!domain || data.length < 2) return data
  const [lo, hi] = domain
  let l = 0, r = data.length - 1
  while (l < r) { const m = (l + r) >> 1; if (data[m].t < lo) l = m + 1; else r = m }
  const first = Math.max(0, l - 1)
  l = 0; r = data.length - 1
  while (l < r) { const m = (l + r + 1) >> 1; if (data[m].t > hi) r = m - 1; else l = m }
  return data.slice(first, Math.min(data.length, l + 2))
}

// ── Canvas drawing ────────────────────────────────────────────────────────────

const PAD = { l: 44, r: 8, t: 12, b: 10 }

function computeYRange(
  data: DataPt[],
  traces: LapTrace[],
  yDomain?: [number | 'auto', number | 'auto']
): [number, number] {
  let lo = typeof yDomain?.[0] === 'number' ? yDomain[0] : Infinity
  let hi = typeof yDomain?.[1] === 'number' ? yDomain[1] : -Infinity
  if (!isFinite(lo) || !isFinite(hi)) {
    for (const pt of data) {
      for (const tr of traces) {
        const v = pt[`t_${tr.colorIndex}`]
        if (typeof v === 'number') { if (v < lo) lo = v; if (v > hi) hi = v }
      }
    }
  }
  if (!isFinite(lo)) lo = 0
  if (!isFinite(hi)) hi = 1
  if (lo === hi) { lo -= 0.5; hi += 0.5 }
  return [lo, hi]
}

function paintChart(
  ctx: CanvasRenderingContext2D,
  data: DataPt[],
  traces: LapTrace[],
  yDomain: [number | 'auto', number | 'auto'] | undefined,
  dark: boolean,
  w: number,
  h: number
) {
  ctx.clearRect(0, 0, w, h)
  if (data.length < 2) return
  const W = w - PAD.l - PAD.r, H = h - PAD.t - PAD.b
  if (W <= 0 || H <= 0) return

  const tMin = data[0].t, tMax = data[data.length - 1].t
  const tSpan = tMax - tMin || 1
  const [yLo, yHi] = computeYRange(data, traces, yDomain)
  const ySpan = yHi - yLo || 1

  const tx = (t: number) => PAD.l + (t - tMin) / tSpan * W
  const ty = (v: number) => PAD.t + (1 - (v - yLo) / ySpan) * H

  // Grid
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.09)'
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const y = Math.round(PAD.t + i / 4 * H) + 0.5
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(w - PAD.r, y); ctx.stroke()
  }

  // Y labels
  ctx.fillStyle = dark ? 'rgba(210,215,230,0.85)' : 'rgba(50,55,70,0.75)'
  ctx.font = '10px system-ui,sans-serif'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let i = 0; i <= 4; i++) {
    const v = yHi - i / 4 * ySpan
    ctx.fillText(
      Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2),
      PAD.l - 4,
      PAD.t + i / 4 * H
    )
  }

  // Clip + trace lines — expand by 1px so lines exactly at 0%/100% aren't half-clipped
  ctx.save()
  ctx.beginPath(); ctx.rect(PAD.l, PAD.t - 1, W, H + 2); ctx.clip()
  for (const tr of traces) {
    ctx.strokeStyle = getLapColor(tr.colorIndex)
    ctx.lineWidth = 1.5
    ctx.beginPath()
    let pen = false
    for (const pt of data) {
      const v = pt[`t_${tr.colorIndex}`]
      if (typeof v !== 'number') { pen = false; continue }
      const x = tx(pt.t), y = ty(v)
      pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
      pen = true
    }
    ctx.stroke()
  }
  ctx.restore()
}

function paintCrosshair(
  ctx: CanvasRenderingContext2D,
  data: DataPt[],
  t: number | null,
  dark: boolean,
  w: number,
  h: number
) {
  ctx.clearRect(0, 0, w, h)
  if (t == null || data.length < 2) return
  const tMin = data[0].t, tMax = data[data.length - 1].t
  if (t < tMin || t > tMax) return
  const W = w - PAD.l - PAD.r
  const x = PAD.l + (t - tMin) / (tMax - tMin || 1) * W
  ctx.strokeStyle = dark ? 'rgba(200,205,220,0.35)' : 'rgba(50,55,70,0.35)'
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, h - PAD.b); ctx.stroke()
  ctx.setLineDash([])
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface Props {
  channel: string
  unit?: string
  yDomain?: [number | 'auto', number | 'auto']
  traces: LapTrace[]
  crosshairTime: number | null
  onMouseMove: (t: number | null) => void
  zoomRef: React.MutableRefObject<[number, number] | null>
  onZoom: (domain: [number, number] | null) => void
  registerRedraw: (fn: () => void) => () => void
  height?: number
}

function nearestValue(trace: LapTrace, t: number): number | null {
  if (!trace.timestamps.length) return null
  let best = 0, bestD = Infinity
  for (let i = 0; i < trace.timestamps.length; i++) {
    const d = Math.abs(trace.timestamps[i] - t)
    if (d < bestD) { bestD = d; best = i }
  }
  return trace.samples[best] ?? null
}

export default function TraceChart({
  channel, unit, yDomain, traces, crosshairTime, onMouseMove,
  zoomRef, onZoom, registerRedraw, height = 130,
}: Props) {
  const dataCanvasRef = useRef<HTMLCanvasElement>(null)
  const xhairCanvasRef = useRef<HTMLCanvasElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const sizeRef = useRef({ w: 1, h: height })

  // Always-current refs (read during imperative draw, never stale)
  const tracesRef = useRef(traces); tracesRef.current = traces
  const yDomainRef = useRef(yDomain); yDomainRef.current = yDomain
  const crosshairRef = useRef(crosshairTime); crosshairRef.current = crosshairTime

  const data = useMemo(() => buildData(traces), [traces])
  const dataRef = useRef(data); dataRef.current = data

  const getVisible = useCallback(
    () => sliceVisible(dataRef.current, zoomRef.current),
    [zoomRef]
  )

  // ── Core imperative redraw (no React, called directly) ──────────────────────

  const redraw = useCallback(() => {
    const dc = dataCanvasRef.current, xc = xhairCanvasRef.current
    if (!dc || !xc) return
    const dark = document.documentElement.classList.contains('dark')
    const { w, h } = sizeRef.current
    const vis = sliceVisible(dataRef.current, zoomRef.current)
    const dcCtx = dc.getContext('2d')
    const xcCtx = xc.getContext('2d')
    if (dcCtx) paintChart(dcCtx, vis, tracesRef.current, yDomainRef.current, dark, w, h)
    if (xcCtx) paintCrosshair(xcCtx, vis, crosshairRef.current, dark, w, h)
  }, [zoomRef])

  const redrawRef = useRef(redraw); redrawRef.current = redraw

  // Register with parent so zoom triggers redraws across all charts
  useEffect(() => registerRedraw(() => redrawRef.current()), [registerRedraw])

  // Redraw when traces / data change
  useEffect(() => { redrawRef.current() }, [data])

  // Crosshair-only repaint (just one overlay canvas — very cheap)
  useEffect(() => {
    const xc = xhairCanvasRef.current
    if (!xc) return
    const dark = document.documentElement.classList.contains('dark')
    const { w, h } = sizeRef.current
    const xcCtx = xc.getContext('2d')
    if (xcCtx) paintCrosshair(xcCtx, getVisible(), crosshairTime, dark, w, h)
  }, [crosshairTime, getVisible])

  // Canvas sizing via ResizeObserver
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const dpr = window.devicePixelRatio || 1

    const resize = () => {
      const rect = wrapper.getBoundingClientRect()
      const pw = Math.max(1, Math.round(rect.width))
      const ph = height
      sizeRef.current = { w: pw, h: ph }
      for (const c of [dataCanvasRef.current, xhairCanvasRef.current]) {
        if (!c) continue
        c.width = pw * dpr
        c.height = ph * dpr
        c.style.width = `${pw}px`
        c.style.height = `${ph}px`
        const ctx = c.getContext('2d')
        if (ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(dpr, dpr) }
      }
      redrawRef.current()
    }

    const ro = new ResizeObserver(resize)
    ro.observe(wrapper)
    return () => ro.disconnect()
  }, [height])

  // Wheel → zoom (fully imperative, zero React re-renders during scroll)
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const d = dataRef.current
      if (d.length < 2) return
      const fullMin = d[0].t, fullMax = d[d.length - 1].t
      const [curMin, curMax] = zoomRef.current ?? [fullMin, fullMax]
      const span = curMax - curMin
      const factor = e.deltaY > 0 ? 1.25 : 0.8
      const newSpan = Math.min(span * factor, fullMax - fullMin)
      const rect = el.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const center = curMin + ratio * span
      let lo = center - ratio * newSpan
      let hi = center + (1 - ratio) * newSpan
      if (lo < fullMin) { hi = Math.min(fullMax, hi + fullMin - lo); lo = fullMin }
      if (hi > fullMax) { lo = Math.max(fullMin, lo - (hi - fullMax)); hi = fullMax }
      const domain: [number, number] | null = hi - lo >= (fullMax - fullMin) * 0.999 ? null : [lo, hi]
      onZoom(domain)
      // Update cursor hint: grab = zoomed-in and pannable
      el.style.cursor = domain ? 'grab' : 'crosshair'
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomRef, onZoom])

  // Left-click drag → pan when zoomed in
  const isDraggingRef = useRef(false)
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return

    let drag: { x: number; lo: number; hi: number } | null = null

    const down = (e: MouseEvent) => {
      if (e.button !== 0 || !zoomRef.current) return
      e.preventDefault()
      drag = { x: e.clientX, lo: zoomRef.current[0], hi: zoomRef.current[1] }
      isDraggingRef.current = true
      el.style.cursor = 'grabbing'
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    }

    const move = (e: MouseEvent) => {
      if (!drag) return
      const d = dataRef.current
      if (d.length < 2) return
      const fullMin = d[0].t, fullMax = d[d.length - 1].t
      const span = drag.hi - drag.lo
      const rect = el.getBoundingClientRect()
      const W = rect.width - PAD.l - PAD.r
      if (W <= 0) return
      const dt = -(e.clientX - drag.x) / W * span
      let lo = drag.lo + dt, hi = drag.hi + dt
      if (lo < fullMin) { lo = fullMin; hi = Math.min(fullMax, fullMin + span) }
      if (hi > fullMax) { hi = fullMax; lo = Math.max(fullMin, fullMax - span) }
      const domain: [number, number] | null = hi - lo >= (fullMax - fullMin) * 0.999 ? null : [lo, hi]
      onZoom(domain)
    }

    const up = () => {
      drag = null
      isDraggingRef.current = false
      el.style.cursor = zoomRef.current ? 'grab' : 'crosshair'
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }

    el.addEventListener('mousedown', down)
    return () => {
      el.removeEventListener('mousedown', down)
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
  }, [zoomRef, onZoom])

  // Mouse → shared crosshair time (suppressed while dragging)
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isDraggingRef.current) return
    const dc = dataCanvasRef.current
    if (!dc) return
    const rect = dc.getBoundingClientRect()
    const relX = e.clientX - rect.left - PAD.l
    const W = rect.width - PAD.l - PAD.r
    if (relX < 0 || relX > W) return
    const vis = getVisible()
    if (!vis.length) return
    onMouseMove(vis[0].t + relX / W * (vis[vis.length - 1].t - vis[0].t))
  }

  return (
    <div className="bg-card rounded-xl border border-border shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">
          {channelLabel(channel)}
          {unit && <span className="text-xs font-normal text-muted-foreground ml-1">({unit})</span>}
        </h3>
        <div className="flex items-center gap-3">
          {traces.map(tr => {
            const val = crosshairTime != null ? nearestValue(tr, crosshairTime) : null
            return val != null ? (
              <span key={tr.colorIndex} className="text-xs font-bold font-mono tabular-nums"
                style={{ color: getLapColor(tr.colorIndex) }}>
                {val.toFixed(1)}{unit && <span className="font-normal opacity-60 ml-0.5">{unit}</span>}
              </span>
            ) : (
              <span key={tr.colorIndex} className="flex items-center gap-1 text-xs text-muted-foreground">
                <span className="inline-block w-3 h-0.5 rounded" style={{ background: getLapColor(tr.colorIndex) }} />
                L{tr.lapNumber}
              </span>
            )
          })}
        </div>
      </div>
      <div
        ref={wrapperRef}
        style={{ position: 'relative', height, userSelect: 'none', cursor: 'crosshair' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => { if (!isDraggingRef.current) onMouseMove(null) }}
      >
        <canvas ref={dataCanvasRef} style={{ position: 'absolute', top: 0, left: 0, display: 'block' }} />
        <canvas ref={xhairCanvasRef} style={{ position: 'absolute', top: 0, left: 0, display: 'block' }} />
      </div>
    </div>
  )
}
