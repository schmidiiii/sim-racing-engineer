import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, parseLapKey, getLapColor } from '@/store/session'
import { useT } from '@/lib/i18n'

interface LapChannelData {
  lap_number: number
  channel: string
  samples: number[]
  timestamps: number[]
}

interface LapGg {
  key: string
  lapNumber: number
  colorIndex: number
  /** Lateral g, positive one way and negative the other */
  lat: number[]
  /** Longitudinal g, positive under acceleration and negative under braking */
  lon: number[]
}

const G = 9.81

/** An impact registers double figures — the Nürburgring session peaks at 21 g
 *  lateral and 27 g braking where the car met something. Nothing standing on
 *  tyres does that, and one crash left in the data pulls the axes so wide that
 *  the lap itself becomes a dot in the middle. */
const IMPACT_G = 4

/** Both axes are loaded past this before a sample counts as combined */
const COMBINED_G = 0.5

function quantile(xs: number[], p: number): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

// ── Drawing ───────────────────────────────────────────────────────────────────

const PADL = 42, PADR = 14, PADT = 16, PADB = 30

/** Percentile the envelope and the axes are built from. Not the peak: raw
 *  maxima on the Nürburgring session read 21 g lateral and 27 g braking, which
 *  are impacts, and one of those widens the axes until the lap is a dot. */
const EDGE_Q = 0.995

interface Limits { lat: number; up: number; down: number }

function paint(
  canvas: HTMLCanvasElement,
  laps: LapGg[],
  w: number,
  h: number,
  lim: Limits,
  labels: Record<string, string>,
  dark: boolean,
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, w, h)
  const IW = w - PADL - PADR, IH = h - PADT - PADB
  if (IW <= 0 || IH <= 0) return

  // Axes scale independently, the way the textbook plot does: a car has far
  // more grip sideways than the engine has forwards, and one shared scale
  // leaves the top of the picture empty.
  const xMax = lim.lat, yUp = lim.up, yDown = lim.down
  const cx = PADL + IW / 2
  const cy = PADT + (yUp / (yUp + yDown)) * IH
  const px = (g: number) => cx + (g / xMax) * (IW / 2)
  const py = (g: number) => g >= 0
    ? cy - (g / yUp) * (cy - PADT)
    : cy + (-g / yDown) * (PADT + IH - cy)

  const grid = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
  const axis = dark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.26)'
  const text = dark ? 'rgba(210,215,230,0.8)' : 'rgba(50,55,70,0.75)'
  const faint = dark ? 'rgba(210,215,230,0.5)' : 'rgba(50,55,70,0.5)'

  ctx.font = '10px system-ui,sans-serif'
  ctx.lineWidth = 1

  // Grid and numbers, one line per half g
  ctx.strokeStyle = grid
  ctx.fillStyle = text
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (let g = -Math.floor(xMax * 2) / 2; g <= xMax; g += 0.5) {
    const x = px(g)
    if (x < PADL || x > w - PADR) continue
    ctx.beginPath(); ctx.moveTo(x, PADT); ctx.lineTo(x, PADT + IH); ctx.stroke()
    if (Math.abs(g - Math.round(g)) < 1e-9) ctx.fillText(g.toFixed(0), x, PADT + IH + 4)
  }
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let g = -Math.floor(yDown * 2) / 2; g <= yUp; g += 0.5) {
    const y = py(g)
    if (y < PADT || y > PADT + IH) continue
    ctx.beginPath(); ctx.moveTo(PADL, y); ctx.lineTo(PADL + IW, y); ctx.stroke()
    if (Math.abs(g - Math.round(g)) < 1e-9) ctx.fillText(g.toFixed(0), PADL - 5, y)
  }

  // Zero lines
  ctx.strokeStyle = axis
  ctx.beginPath()
  ctx.moveTo(PADL, cy); ctx.lineTo(PADL + IW, cy)
  ctx.moveTo(cx, PADT); ctx.lineTo(cx, PADT + IH)
  ctx.stroke()

  // The cloud, translucent so density reads as density
  for (const lap of laps) {
    ctx.fillStyle = getLapColor(lap.colorIndex)
    ctx.globalAlpha = dark ? 0.32 : 0.26
    const n = Math.min(lap.lat.length, lap.lon.length)
    for (let i = 0; i < n; i++) {
      const lat = lap.lat[i], lon = lap.lon[i]
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
      if (Math.hypot(lat, lon) > IMPACT_G) continue
      ctx.fillRect(px(lat) - 1, py(lon) - 1, 2, 2)
    }
    ctx.globalAlpha = 1
  }

  // The envelope: two half ellipses, since braking reaches further than the
  // engine does. It is the shape the grip budget allows — points short of it
  // are grip left unspent.
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.34)' : 'rgba(0,0,0,0.30)'
  ctx.lineWidth = 1.5
  ctx.setLineDash([4, 3])
  ctx.beginPath()
  ctx.ellipse(cx, cy, px(xMax) - cx, cy - py(yUp), 0, Math.PI, 0)
  ctx.stroke()
  ctx.beginPath()
  ctx.ellipse(cx, cy, px(xMax) - cx, py(-yDown) - cy, 0, 0, Math.PI)
  ctx.stroke()
  ctx.setLineDash([])

  // Region names. Placed inside the frame at the eight points a reader looks,
  // and skipped when the frame is too small to hold them without overlapping.
  if (IW > 300 && IH > 220) {
    ctx.fillStyle = faint
    ctx.font = '9px system-ui,sans-serif'
    const put = (s: string, x: number, y: number, align: CanvasTextAlign, base: CanvasTextBaseline) => {
      ctx.textAlign = align; ctx.textBaseline = base; ctx.fillText(s, x, y)
    }
    put(labels.pureAccel, cx, PADT + 3, 'center', 'top')
    put(labels.pureBrake, cx, PADT + IH - 3, 'center', 'bottom')
    put(labels.pureRight, PADL + 4, cy - 5, 'left', 'bottom')
    put(labels.pureLeft, PADL + IW - 4, cy - 5, 'right', 'bottom')
    put(labels.outRight, PADL + 4, PADT + 3, 'left', 'top')
    put(labels.outLeft, PADL + IW - 4, PADT + 3, 'right', 'top')
    put(labels.inRight, PADL + 4, PADT + IH - 3, 'left', 'bottom')
    put(labels.inLeft, PADL + IW - 4, PADT + IH - 3, 'right', 'bottom')
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function GgDiagram() {
  const t = useT()
  const { sessions, selectedLapKeys } = useSessionStore()
  const [laps, setLaps] = useState<LapGg[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'nodata'>('idle')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const lapsRef = useRef<LapGg[]>([])
  const sizeRef = useRef({ w: 560, h: 380 })

  const lapKeyStr = selectedLapKeys.join(',')

  useEffect(() => {
    if (!selectedLapKeys.length) { setStatus('idle'); setLaps([]); return }
    let cancelled = false
    setStatus('loading')

    const load = async () => {
      const out: LapGg[] = []
      for (const [i, key] of selectedLapKeys.entries()) {
        const { sessionId, lapNumber } = parseLapKey(key)
        const session = sessions.find(s => s.id === sessionId)
        if (!session) continue
        const has = new Set(session.available_channels.map(c => c.name))
        if (!has.has('LatAccel') || !has.has('LongAccel')) continue
        try {
          const [la, lo] = await Promise.all(
            ['LatAccel', 'LongAccel'].map(ch =>
              invoke<LapChannelData[]>('get_lap_channel_data',
                { sessionId, lapNumbers: [lapNumber], channel: ch, stride: 2 })),
          )
          if (!la[0] || !lo[0]) continue
          out.push({
            key, lapNumber, colorIndex: i,
            lat: la[0].samples.map(v => v / G),
            lon: lo[0].samples.map(v => v / G),
          })
        } catch { /* a lap that will not load is simply not plotted */ }
      }
      if (cancelled) return
      setLaps(out)
      setStatus(out.length ? 'ok' : 'nodata')
    }
    load()
    return () => { cancelled = true }
  }, [lapKeyStr, sessions.length])

  useEffect(() => { lapsRef.current = laps }, [laps])

  // One limit per direction. Sideways a car reaches much further than the engine
  // does forwards, so a single shared scale would leave the top of the frame
  // empty and squash everything else.
  const limit = useMemo(() => {
    const latA: number[] = [], upA: number[] = [], downA: number[] = []
    for (const lap of laps) {
      const n = Math.min(lap.lat.length, lap.lon.length)
      for (let i = 0; i < n; i++) {
        const lat = lap.lat[i], lon = lap.lon[i]
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
        if (Math.hypot(lat, lon) > IMPACT_G) continue
        latA.push(Math.abs(lat))
        if (lon >= 0) upA.push(lon); else downA.push(-lon)
      }
    }
    const up = (q: number) => Math.max(0.5, Math.ceil(q * 1.12 * 2) / 2)
    return {
      lat: up(quantile(latA, EDGE_Q)),
      up: up(quantile(upA, EDGE_Q)),
      down: up(quantile(downA, EDGE_Q)),
    }
  }, [laps])

  const stats = useMemo(() => laps.map(lap => {
    const n = Math.min(lap.lat.length, lap.lon.length)
    const latA: number[] = [], brkA: number[] = [], accA: number[] = []
    let combined = 0, used = 0
    for (let i = 0; i < n; i++) {
      const lat = lap.lat[i], lon = lap.lon[i]
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
      if (Math.hypot(lat, lon) > IMPACT_G) continue
      used++
      latA.push(Math.abs(lat))
      if (lon < 0) brkA.push(-lon); else accA.push(lon)
      if (Math.abs(lat) > COMBINED_G && Math.abs(lon) > COMBINED_G) combined++
    }
    return {
      key: lap.key,
      lapNumber: lap.lapNumber,
      colorIndex: lap.colorIndex,
      lateral: quantile(latA, 0.90),
      braking: quantile(brkA, 0.90),
      traction: quantile(accA, 0.99),
      combined: used ? combined / used * 100 : 0,
    }
  }), [laps])

  const regionLabels = useMemo(() => ({
    pureAccel: t('ggRegionAccel'),
    pureBrake: t('ggRegionBrake'),
    pureRight: t('ggRegionRight'),
    pureLeft: t('ggRegionLeft'),
    outRight: t('ggRegionOutRight'),
    outLeft: t('ggRegionOutLeft'),
    inRight: t('ggRegionInRight'),
    inLeft: t('ggRegionInLeft'),
  }), [t])

  useEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current
    if (!wrap || !canvas) return
    const dpr = window.devicePixelRatio || 1

    const redraw = () => {
      const { w, h } = sizeRef.current
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      paint(canvas, lapsRef.current, w, h, limit, regionLabels,
        document.documentElement.classList.contains('dark'))
    }

    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect()
      const w = Math.max(320, Math.min(760, Math.round(rect.width)))
      // Taller than half its width: braking reaches down about twice as far as
      // the engine reaches up, so the vertical needs the room
      sizeRef.current = { w, h: Math.round(w * 0.68) }
      redraw()
    })
    ro.observe(wrap)
    redraw()
    return () => ro.disconnect()
  }, [laps, limit, regionLabels])

  if (!selectedLapKeys.length)
    return <div className="flex-1 flex items-center justify-center">
      <p className="text-sm text-muted-foreground">{t('selectLapsCompare')}</p>
    </div>
  if (status === 'loading')
    return <div className="flex-1 flex items-center justify-center">
      <p className="text-xs text-muted-foreground">{t('loading')}</p>
    </div>
  if (status === 'nodata')
    return <div className="flex-1 flex items-center justify-center">
      <p className="text-sm text-muted-foreground">{t('ggNoData')}</p>
    </div>

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-background">
      <div className="grid gap-4 lg:grid-cols-[auto_1fr] items-start">

        <div className="bg-card rounded-xl border border-border shadow-sm p-4">
          <div className="flex items-center justify-between mb-2 gap-4">
            <h3 className="text-sm font-semibold text-foreground">{t('ggTitle')}</h3>
            <div className="flex items-center gap-3">
              {laps.map(l => (
                <span key={l.key} className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span className="inline-block w-3 h-0.5 rounded"
                    style={{ background: getLapColor(l.colorIndex) }} />
                  L{l.lapNumber}
                </span>
              ))}
            </div>
          </div>
          <div ref={wrapRef} className="w-[min(60vw,700px)] min-w-[320px]">
            <canvas ref={canvasRef} style={{ display: 'block' }} />
          </div>
          <p className="text-[10px] text-muted-foreground mt-1 text-center">{t('ggAxes')}</p>
        </div>

        <div className="space-y-4">
          <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs tabular-nums">
                <thead>
                  <tr className="bg-secondary/40 border-b border-border text-[11px] text-foreground/80">
                    <th className="px-3 py-2 text-left font-semibold">{t('lapTableLap')}</th>
                    <th className="px-3 py-2 text-right font-semibold" title={t('ggLateralHint')}>{t('ggLateral')}</th>
                    <th className="px-3 py-2 text-right font-semibold">{t('ggBraking')}</th>
                    <th className="px-3 py-2 text-right font-semibold" title={t('ggTractionHint')}>{t('ggTraction')}</th>
                    <th className="px-3 py-2 text-right font-semibold" title={t('ggCombinedHint')}>{t('ggCombined')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map(s => (
                    <tr key={s.key} className="border-b border-border/40 last:border-0 odd:bg-secondary/15">
                      <td className="px-3 py-1.5 text-left font-semibold"
                          style={{ color: getLapColor(s.colorIndex) }}>L{s.lapNumber}</td>
                      <td className="px-3 py-1.5 text-right">{s.lateral.toFixed(2)}<span className="opacity-45 text-[10px] ml-0.5">g</span></td>
                      <td className="px-3 py-1.5 text-right">{s.braking.toFixed(2)}<span className="opacity-45 text-[10px] ml-0.5">g</span></td>
                      <td className="px-3 py-1.5 text-right">{s.traction.toFixed(2)}<span className="opacity-45 text-[10px] ml-0.5">g</span></td>
                      <td className="px-3 py-1.5 text-right">{s.combined.toFixed(1)}<span className="opacity-45 text-[10px] ml-0.5">%</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-card rounded-xl border border-border shadow-sm px-4 py-3 space-y-1.5">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('ggReadTitle')}</p>
            <p className="text-xs text-muted-foreground leading-relaxed">{t('ggReadShape')}</p>
            <p className="text-xs text-muted-foreground leading-relaxed">{t('ggReadCorner')}</p>
            <p className="text-xs text-muted-foreground leading-relaxed">{t('ggReadTraction')}</p>
            <p className="text-[10px] text-muted-foreground/70 leading-relaxed pt-1">{t('ggCaveat')}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
