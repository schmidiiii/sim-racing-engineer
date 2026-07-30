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

const PAD = 34

function paint(
  canvas: HTMLCanvasElement,
  laps: LapGg[],
  size: number,
  limit: number,
  dark: boolean,
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, size, size)
  const R = (size - PAD * 2) / 2
  const cx = PAD + R, cy = PAD + R
  // Positive LatAccel is a LEFT turn — measured earlier against yaw rate and
  // steering, which agree 99% of the time. Negated here so right-hand corners
  // land on the right of the picture, which is the only arrangement a reader
  // will not have to think about.
  const px = (g: number) => cx - (g / limit) * R
  // Acceleration upwards, braking down — the way every g-g plot is drawn
  const py = (g: number) => cy - (g / limit) * R

  // Grip rings at whole and half g, labelled on the horizontal
  ctx.font = '10px system-ui,sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (let g = 0.5; g <= limit + 1e-9; g += 0.5) {
    const whole = Math.abs(g - Math.round(g)) < 1e-9
    ctx.strokeStyle = dark
      ? `rgba(255,255,255,${whole ? 0.16 : 0.08})`
      : `rgba(0,0,0,${whole ? 0.16 : 0.07})`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(cx, cy, (g / limit) * R, 0, Math.PI * 2)
    ctx.stroke()
    if (whole) {
      ctx.fillStyle = dark ? 'rgba(210,215,230,0.7)' : 'rgba(50,55,70,0.65)'
      ctx.fillText(`${g}g`, px(-g) + 3, cy - 7)
    }
  }

  // Axes
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)'
  ctx.beginPath()
  ctx.moveTo(PAD, cy); ctx.lineTo(size - PAD, cy)
  ctx.moveTo(cx, PAD); ctx.lineTo(cx, size - PAD)
  ctx.stroke()

  // The cloud. Small and translucent so density reads as density — where the
  // tyre spends its time is the whole point, and opaque dots hide it.
  for (const lap of laps) {
    ctx.fillStyle = getLapColor(lap.colorIndex)
    ctx.globalAlpha = dark ? 0.30 : 0.24
    const n = Math.min(lap.lat.length, lap.lon.length)
    for (let i = 0; i < n; i++) {
      const lat = lap.lat[i], lon = lap.lon[i]
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
      if (Math.hypot(lat, lon) > IMPACT_G) continue
      ctx.fillRect(px(lat) - 1, py(lon) - 1, 2, 2)
    }
    ctx.globalAlpha = 1
  }

  // Direction labels
  ctx.fillStyle = dark ? 'rgba(210,215,230,0.75)' : 'rgba(50,55,70,0.7)'
  ctx.textAlign = 'center'
  ctx.fillText('▲', cx, PAD - 14)
  ctx.fillText('▼', cx, size - PAD + 14)
  ctx.textAlign = 'right'
  ctx.fillText('◀', PAD - 6, cy)
  ctx.textAlign = 'left'
  ctx.fillText('▶', size - PAD + 6, cy)
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
  const sizeRef = useRef(420)

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

  // Axis limit from a high percentile, not the peak. Rounded to a half g so the
  // rings stay on whole numbers.
  const limit = useMemo(() => {
    const mags: number[] = []
    for (const lap of laps) {
      const n = Math.min(lap.lat.length, lap.lon.length)
      for (let i = 0; i < n; i++) {
        const m = Math.hypot(lap.lat[i], lap.lon[i])
        if (m <= IMPACT_G) mags.push(m)
      }
    }
    const p = quantile(mags, 0.999)
    return Math.max(1, Math.ceil((p * 1.1) * 2) / 2)
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

  // Square canvas: a circle drawn on a stretched one is an ellipse, and the
  // shape of the envelope is the thing being read.
  useEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current
    if (!wrap || !canvas) return
    const dpr = window.devicePixelRatio || 1

    const redraw = () => {
      const s = sizeRef.current
      canvas.width = Math.round(s * dpr)
      canvas.height = Math.round(s * dpr)
      canvas.style.width = `${s}px`
      canvas.style.height = `${s}px`
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      paint(canvas, lapsRef.current, s,
        limit, document.documentElement.classList.contains('dark'))
    }

    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect()
      sizeRef.current = Math.max(240, Math.min(520, Math.round(rect.width)))
      redraw()
    })
    ro.observe(wrap)
    redraw()
    return () => ro.disconnect()
  }, [laps, limit])

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
          <div ref={wrapRef} className="w-[min(46vw,460px)] min-w-[240px]">
            <canvas ref={canvasRef} style={{ display: 'block' }} />
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mt-2 text-[10px] text-muted-foreground">
            <span>▲ {t('ggUp')}</span>
            <span>▼ {t('ggDown')}</span>
            <span>◀ {t('ggLeft')}</span>
            <span>▶ {t('ggRight')}</span>
          </div>
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
