import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, lapKey } from '@/store/session'
import { useT } from '@/lib/i18n'
import { speedFromMps, speedUnit } from '@/lib/units'

interface LapEvent {
  lap_number: number
  at: number
  session_time: number
  lap_dist_pct: number
  kind: string
  corner: string | null
  magnitude: number
  duration: number
  speed: number
}

type Kind = 'lockup' | 'wheelspin' | 'offTrack' | 'abs' | 'missedShift'
const KINDS: Kind[] = ['lockup', 'wheelspin', 'offTrack', 'abs', 'missedShift']
const HIDDEN_KEY = 'srEventHidden'

function loadHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch { /* fall through */ }
  return new Set()
}

/** Colour per kind, dark and light. Kept away from the lap colours so an event
 *  is never mistaken for a lap. */
const TINT: Record<string, string> = {
  lockup: 'text-rose-500',
  wheelspin: 'text-amber-500',
  offTrack: 'text-violet-500',
  abs: 'text-teal-500',
  missedShift: 'text-sky-500',
}

const fmtAt = (t: number) =>
  `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`

export default function EventLog() {
  const t = useT()
  const {
    sessions, activeSessionId, selectedLapKeys, toggleLap,
    setCrosshairTime, units,
  } = useSessionStore()
  const [events, setEvents] = useState<LapEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(loadHidden)

  const session = sessions.find(s => s.id === activeSessionId) ?? sessions[0]

  useEffect(() => {
    if (!session) return
    let cancelled = false
    setLoading(true)
    setError(null)
    invoke<LapEvent[]>('get_lap_events', { sessionId: session.id })
      .then(rows => { if (!cancelled) setEvents(rows) })
      .catch(e => { if (!cancelled) setError(String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [session?.id])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const e of events) c[e.kind] = (c[e.kind] ?? 0) + 1
    return c
  }, [events])

  const shown = useMemo(
    () => events.filter(e => !hidden.has(e.kind)),
    [events, hidden],
  )

  // Places the driver hits repeatedly are worth more than one-offs: anything
  // within a percent of the lap counts as the same corner.
  const repeats = useMemo(() => {
    const buckets = new Map<string, LapEvent[]>()
    for (const e of shown) {
      const key = `${e.kind}|${Math.round(e.lap_dist_pct * 100)}`
      const arr = buckets.get(key)
      arr ? arr.push(e) : buckets.set(key, [e])
    }
    return [...buckets.values()]
      .filter(g => g.length > 1)
      .sort((a, b) => b.length - a.length)
      .slice(0, 3)
  }, [shown])

  const toggleKind = (k: string) => setHidden(prev => {
    const next = new Set(prev)
    next.has(k) ? next.delete(k) : next.add(k)
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]))
    return next
  })

  const jumpTo = (e: LapEvent) => {
    // Show the lap the event belongs to, then put the crosshair on it. The
    // crosshair is measured from the start of a lap, not from the session, so
    // `at` is the one that lines up with the traces.
    const key = lapKey(session!.id, e.lap_number)
    if (!selectedLapKeys.includes(key)) toggleLap(session!.id, e.lap_number)
    setCrosshairTime(e.at)
  }

  if (!session) {
    return <div className="flex-1 flex items-center justify-center">
      <p className="text-sm text-muted-foreground">{t('noSessionLoaded')}</p>
    </div>
  }
  if (loading && !events.length) {
    return <div className="flex-1 flex items-center justify-center">
      <p className="text-sm text-muted-foreground">{t('lapTableLoading')}</p>
    </div>
  }
  if (error) {
    return <div className="flex-1 flex items-center justify-center">
      <p className="text-sm text-muted-foreground">{error}</p>
    </div>
  }

  const su = speedUnit(units)
  const label = (k: string) => t(`event_${k}` as never) as string

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-background">

      {/* One card per kind, doubling as the filter */}
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {KINDS.map(k => (
          <button
            key={k}
            onClick={() => toggleKind(k)}
            className={`bg-card rounded-xl border shadow-sm p-3 min-w-0 text-left transition-colors ${
              hidden.has(k) ? 'border-border opacity-40' : 'border-border hover:bg-secondary/40'
            }`}
          >
            <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide truncate">
              {label(k)}
            </p>
            <p className={`font-bold text-base mt-0.5 leading-tight tabular-nums ${TINT[k]}`}>
              {counts[k] ?? 0}
            </p>
          </button>
        ))}
      </div>

      {/* Somewhere the same thing keeps happening */}
      {repeats.length > 0 && (
        <div className="bg-card rounded-xl border border-border shadow-sm px-4 py-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1.5">
            {t('eventRepeats')}
          </p>
          <div className="space-y-1">
            {repeats.map(g => (
              <button
                key={`${g[0].kind}-${g[0].lap_dist_pct}`}
                onClick={() => jumpTo(g[0])}
                className="w-full flex items-center gap-2 text-xs hover:bg-secondary/40 rounded px-1.5 py-1 transition-colors text-left"
              >
                <span className={`font-semibold ${TINT[g[0].kind]}`}>{label(g[0].kind)}</span>
                <span className="text-muted-foreground">
                  {t('eventAtPct').replace('%pct%', (g[0].lap_dist_pct * 100).toFixed(0))}
                </span>
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {t('eventTimes').replace('%n%', String(g.length))}
                  {' · '}
                  {g.map(e => `L${e.lap_number}`).join(' ')}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="bg-card rounded-xl border border-border shadow-sm px-4 py-8 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">{t('eventNone')}</p>
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs tabular-nums">
              <thead>
                <tr className="bg-secondary/40 border-b border-border text-[11px] text-foreground/80">
                  <th className="px-2 py-2 text-left font-semibold">{t('lapTableLap')}</th>
                  <th className="px-2 py-2 text-right font-semibold">{t('eventAt')}</th>
                  <th className="px-2 py-2 text-right font-semibold border-l border-border">{t('eventRound')}</th>
                  <th className="px-2 py-2 text-left font-semibold border-l border-border">{t('eventWhat')}</th>
                  <th className="px-2 py-2 text-left font-semibold">{t('eventWheel')}</th>
                  <th className="px-2 py-2 text-right font-semibold border-l border-border">{t('eventHow')}</th>
                  <th className="px-2 py-2 text-right font-semibold">{t('eventFor')}</th>
                  <th className="px-2 py-2 text-right font-semibold border-l border-border">{t('lapTableVmax')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e, i) => (
                  <tr
                    key={`${e.session_time}-${e.kind}-${i}`}
                    onClick={() => jumpTo(e)}
                    title={t('eventJump')}
                    className="border-b border-border/40 last:border-0 cursor-pointer odd:bg-secondary/15 hover:bg-secondary/40 transition-colors"
                  >
                    <td className="px-2 py-1.5 text-left font-semibold">{e.lap_number}</td>
                    <td className="px-2 py-1.5 text-right">{fmtAt(e.at)}</td>
                    <td className="px-2 py-1.5 text-right border-l border-border">
                      {(e.lap_dist_pct * 100).toFixed(1)}<span className="opacity-45 text-[10px] ml-0.5">%</span>
                    </td>
                    <td className={`px-2 py-1.5 text-left font-semibold border-l border-border ${TINT[e.kind]}`}>
                      {label(e.kind)}
                    </td>
                    <td className="px-2 py-1.5 text-left text-muted-foreground">{e.corner ?? ''}</td>
                    <td className="px-2 py-1.5 text-right border-l border-border">
                      {/* Slip for a wheel, seconds for an excursion — the unit
                          differs by kind, so it is spelled out on every row */}
                      {e.kind === 'offTrack' || e.kind === 'abs'
                        ? <>{e.magnitude.toFixed(1)}<span className="opacity-45 text-[10px] ml-0.5">s</span></>
                        : <>{e.magnitude.toFixed(0)}<span className="opacity-45 text-[10px] ml-0.5">%</span></>}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {e.duration.toFixed(2)}<span className="opacity-45 text-[10px] ml-0.5">s</span>
                    </td>
                    <td className="px-2 py-1.5 text-right border-l border-border">
                      {speedFromMps(e.speed, units).toFixed(0)}
                      <span className="opacity-45 text-[10px] ml-0.5">{su}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">{t('eventHint')}</p>
    </div>
  )
}
