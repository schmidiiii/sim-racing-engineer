import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, lapKey, getLapColor } from '@/store/session'
import { useT } from '@/lib/i18n'
import {
  speedFromMps, speedUnit, fuelFromL, fuelUnit,
  tempFromC, tempUnit, pressureFromKpa, pressureUnit,
} from '@/lib/units'

interface TyreState {
  corner: string
  temp_l: number
  temp_m: number
  temp_r: number
  wear: number
  pressure: number
}

interface LapSummary {
  lap_number: number
  lap_time: number
  is_valid: boolean
  pit_time: number
  out_lap: boolean
  in_lap: boolean
  sectors: number[]
  fuel_used: number
  fuel_left: number
  max_speed: number
  avg_speed: number
  throttle_full_pct: number
  braking_pct: number
  coasting_pct: number
  overlap_pct: number
  max_brake: number
  steering_reversals: number
  off_track: number
  tyres: TyreState[]
  track_temp: number
  air_temp: number
}

/** Column groups the table can show or hide — twelve sector columns plus
 *  everything else does not fit on a screen, and which half matters depends
 *  entirely on what the engineer is chasing. */
type ColGroup = 'sectors' | 'fuel' | 'inputs' | 'tyres' | 'weather'
const COL_GROUPS: ColGroup[] = ['sectors', 'fuel', 'inputs', 'tyres', 'weather']
const GROUP_KEY = 'srLapTableCols'
const CORNERS = ['LF', 'RF', 'LR', 'RR'] as const

const fmtLap = (t: number) =>
  t > 0 ? `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}` : '–'

const fmtSector = (t: number) =>
  t >= 60 ? `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}` : t.toFixed(2)

const fmtGap = (d: number) => (d === 0 ? '' : `+${d.toFixed(3)}`)

/** A lap only says something about pace if it was driven end to end. */
const isPaceLap = (m: LapSummary) =>
  m.is_valid && m.lap_time > 10 && !m.out_lap && !m.in_lap

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const h = s.length >> 1
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}

function loadGroups(): Set<ColGroup> {
  try {
    const raw = localStorage.getItem(GROUP_KEY)
    if (raw) return new Set(JSON.parse(raw) as ColGroup[])
  } catch { /* fall through to the default */ }
  return new Set<ColGroup>(['sectors', 'fuel', 'inputs'])
}

// ── Summary cards ─────────────────────────────────────────────────────────────

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold text-foreground tabular-nums">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

export default function LapTable() {
  const t = useT()
  const { sessions, activeSessionId, selectedLapKeys, toggleLap, units } = useSessionStore()
  const [summaries, setSummaries] = useState<LapSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [groups, setGroups] = useState<Set<ColGroup>>(loadGroups)

  const session = sessions.find(s => s.id === activeSessionId) ?? sessions[0]

  const toggleGroup = (g: ColGroup) => {
    setGroups(prev => {
      const next = new Set(prev)
      next.has(g) ? next.delete(g) : next.add(g)
      localStorage.setItem(GROUP_KEY, JSON.stringify([...next]))
      return next
    })
  }

  useEffect(() => {
    if (!session) return
    let cancelled = false
    setLoading(true)
    setError(null)
    invoke<LapSummary[]>('get_lap_summaries', { sessionId: session.id })
      .then(rows => { if (!cancelled) setSummaries(rows) })
      .catch(e => { if (!cancelled) setError(String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [session?.id])

  const pace = useMemo(() => summaries.filter(isPaceLap), [summaries])

  const stint = useMemo(() => {
    const times = pace.map(m => m.lap_time)
    const best = times.length ? Math.min(...times) : 0
    // Consistency reads better without the one lap that went wrong: the spread
    // of the laps that were actually attempts at a lap time.
    const cut = best * 1.03
    const clean = times.filter(v => v <= cut)
    const fuelPer = pace.filter(m => m.fuel_used > 0).map(m => m.fuel_used)
    const avgFuel = fuelPer.length ? fuelPer.reduce((a, b) => a + b, 0) / fuelPer.length : 0
    // Worst case matters more than the average when deciding whether the fuel
    // lasts: a stint planned on the average runs dry on the heavy laps.
    const maxFuel = fuelPer.length ? Math.max(...fuelPer) : 0
    const last = summaries[summaries.length - 1]
    const tank = last?.fuel_left ?? 0
    return {
      best,
      median: median(times),
      spread: stdDev(clean),
      cleanCount: clean.length,
      avgFuel,
      maxFuel,
      tank,
      lapsLeft: avgFuel > 0 ? tank / avgFuel : 0,
      lapsLeftWorst: maxFuel > 0 ? tank / maxFuel : 0,
      offs: pace.reduce((a, m) => a + m.off_track, 0),
    }
  }, [pace, summaries])

  // Best time per sector across the pace laps — the "ideal lap" split by split
  const bestSectors = useMemo(() => {
    const n = Math.max(0, ...pace.map(m => m.sectors.length))
    return Array.from({ length: n }, (_, i) => {
      const vals = pace.map(m => m.sectors[i]).filter(v => typeof v === 'number' && v > 0)
      return vals.length ? Math.min(...vals) : 0
    })
  }, [pace])

  const idealLap = bestSectors.reduce((a, b) => a + b, 0)

  const exportCsv = () => {
    // The export ignores the column switches — hiding a column on screen is
    // about reading the table, not about what belongs in the file.
    const nSec = bestSectors.length
    const head = [
      'lap', 'time_s', 'valid', 'pit_s', 'out_lap', 'in_lap',
      ...Array.from({ length: nSec }, (_, i) => `sector_${i + 1}_s`),
      'fuel_used_l', 'fuel_left_l', 'max_speed_kph', 'avg_speed_kph',
      'full_throttle_pct', 'braking_pct', 'coasting_pct', 'overlap_pct',
      'max_brake_pct', 'steering_reversals_per_min', 'off_track',
      'track_temp_c', 'air_temp_c',
      ...CORNERS.flatMap(c => [`${c}_temp_l_c`, `${c}_temp_m_c`, `${c}_temp_r_c`, `${c}_wear_pct`, `${c}_pressure_kpa`]),
    ]
    const rows = summaries.map(m => [
      m.lap_number, m.lap_time.toFixed(3), m.is_valid, m.pit_time.toFixed(2), m.out_lap, m.in_lap,
      ...Array.from({ length: nSec }, (_, i) => (m.sectors[i] ?? 0).toFixed(3)),
      m.fuel_used.toFixed(3), m.fuel_left.toFixed(2),
      (m.max_speed * 3.6).toFixed(1), (m.avg_speed * 3.6).toFixed(1),
      m.throttle_full_pct.toFixed(1), m.braking_pct.toFixed(1),
      m.coasting_pct.toFixed(1), m.overlap_pct.toFixed(1),
      (m.max_brake * 100).toFixed(1), m.steering_reversals.toFixed(1), m.off_track,
      m.track_temp.toFixed(1), m.air_temp.toFixed(1),
      ...m.tyres.flatMap(y => [
        y.temp_l.toFixed(1), y.temp_m.toFixed(1), y.temp_r.toFixed(1),
        (y.wear * 100).toFixed(1), y.pressure.toFixed(1),
      ]),
    ])
    // Exported in SI throughout, whatever the display is set to — a file that
    // silently changes units depending on a screen toggle is a trap.
    const csv = [head, ...rows].map(r => r.join(',')).join('\r\n')
    const name = (session?.file_path.split(/[\\/]/).pop() ?? 'session').replace(/\.ibt$/i, '')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}-laps.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('noSessionLoaded')}</p>
      </div>
    )
  }

  if (loading && summaries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('lapTableLoading')}</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    )
  }

  const su = speedUnit(units)
  const fu = fuelUnit(units)
  const tu = tempUnit(units)
  const pu = pressureUnit(units)
  const nSec = bestSectors.length
  const show = (g: ColGroup) => groups.has(g)

  const cornerLabel: Record<typeof CORNERS[number], string> = {
    LF: t('cornerLF'), RF: t('cornerRF'), LR: t('cornerLR'), RR: t('cornerRR'),
  }

  const groupLabel: Record<ColGroup, string> = {
    sectors: t('lapTableColSectors'),
    fuel: t('lapTableColFuel'),
    inputs: t('lapTableColInputs'),
    tyres: t('lapTableColTyres'),
    weather: t('lapTableColWeather'),
  }

  const th = 'px-2 py-2 text-right font-semibold whitespace-nowrap'
  const td = 'px-2 py-1.5 text-right'

  return (
    <div className="flex-1 overflow-auto bg-background p-4 space-y-4">
      {/* Stint at a glance */}
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label={t('lapTablePaceLaps')} value={String(pace.length)}
              hint={`${summaries.length} ${t('lapTableTotal')}`} />
        <Stat label={t('lapTableBest')} value={fmtLap(stint.best)} />
        <Stat label={t('lapTableIdeal')} value={fmtLap(idealLap)}
              hint={idealLap > 0 && stint.best > 0 ? `−${(stint.best - idealLap).toFixed(3)}s` : undefined} />
        <Stat label={t('lapTableConsistency')} value={`±${stint.spread.toFixed(3)}s`}
              hint={`${stint.cleanCount} ${t('lapTableWithin3')}`} />
        <Stat label={t('lapTableFuelPerLap')}
              value={stint.avgFuel > 0 ? `${fuelFromL(stint.avgFuel, units).toFixed(2)} ${fu}` : '–'}
              hint={stint.maxFuel > 0 ? `${t('lapTableWorst')} ${fuelFromL(stint.maxFuel, units).toFixed(2)}` : undefined} />
        <Stat label={t('lapTableTank')}
              value={`${fuelFromL(stint.tank, units).toFixed(1)} ${fu}`}
              hint={stint.lapsLeft > 0
                ? `${stint.lapsLeftWorst.toFixed(1)}–${stint.lapsLeft.toFixed(1)} ${t('lapTableLapsLeft')}`
                : undefined} />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {COL_GROUPS.map(g => (
          <button
            key={g}
            onClick={() => toggleGroup(g)}
            className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
              show(g)
                ? 'border-primary text-primary bg-primary/10'
                : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            {groupLabel[g]}
          </button>
        ))}
        <button
          onClick={exportCsv}
          className="ml-auto text-xs font-semibold px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('lapTableExport')}
        </button>
      </div>

      <p className="text-[11px] text-muted-foreground">{t('lapTableHint')}</p>

      {/* The table scrolls on its own so the page never scrolls sideways */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="bg-card text-muted-foreground">
              <th className="px-2 py-2 text-left font-semibold">{t('lapTableLap')}</th>
              <th className={th}>{t('lapTableTime')}</th>
              <th className={th}>{t('lapTableGap')}</th>
              {show('sectors') && Array.from({ length: nSec }, (_, i) => (
                <th key={i} className={th}>S{i + 1}</th>
              ))}
              {show('fuel') && <th className={th} title={t('lapTableUsedHint')}>{t('lapTableUsed')}</th>}
              {show('fuel') && <th className={th} title={t('lapTableTankHint')}>{t('lapTableTank')}</th>}
              <th className={th}>{t('lapTableVmax')}</th>
              {show('inputs') && <>
                <th className={th} title={t('lapTableFullHint')}>{t('lapTableFull')}</th>
                <th className={th}>{t('lapTableBrake')}</th>
                <th className={th} title={t('lapTableCoastHint')}>{t('lapTableCoast')}</th>
                <th className={th} title={t('lapTableOverlapHint')}>{t('lapTableOverlap')}</th>
                <th className={th} title={t('lapTableReversalsHint')}>{t('lapTableReversals')}</th>
              </>}
              {show('tyres') && CORNERS.map(c => (
                <th key={c} className={th} title={t('lapTableTyreHint')}>{cornerLabel[c]}</th>
              ))}
              {show('weather') && <>
                <th className={th}>{t('lapTableTrackTemp')}</th>
                <th className={th}>{t('lapTableAirTemp')}</th>
              </>}
              <th className={th}>{t('lapTableOff')}</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map(m => {
              const key = lapKey(session.id, m.lap_number)
              const selIdx = selectedLapKeys.indexOf(key)
              const selected = selIdx >= 0
              const paceLap = isPaceLap(m)
              const isBest = paceLap && m.lap_time === stint.best
              return (
                <tr
                  key={m.lap_number}
                  onClick={() => toggleLap(session.id, m.lap_number)}
                  className={`border-t border-border cursor-pointer transition-colors ${
                    selected ? 'bg-secondary/60' : 'hover:bg-secondary/30'
                  } ${paceLap ? '' : 'text-muted-foreground'}`}
                >
                  <td className="px-2 py-1.5 text-left font-semibold">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="inline-block w-1.5 h-3 rounded-sm"
                        style={{ background: selected ? getLapColor(selIdx) : 'transparent' }}
                      />
                      {m.lap_number}
                      {m.out_lap && <span className="text-[9px] font-normal opacity-70">{t('lapTableOut')}</span>}
                      {m.in_lap && <span className="text-[9px] font-normal opacity-70">{t('lapTableIn')}</span>}
                    </span>
                  </td>
                  <td className={`${td} ${isBest ? 'font-bold text-primary' : ''}`}>{fmtLap(m.lap_time)}</td>
                  <td className={`${td} text-muted-foreground`}>
                    {paceLap && stint.best > 0 ? fmtGap(m.lap_time - stint.best) : ''}
                  </td>
                  {show('sectors') && Array.from({ length: nSec }, (_, i) => {
                    const v = m.sectors[i]
                    const best = paceLap && v > 0 && Math.abs(v - bestSectors[i]) < 1e-6
                    return (
                      <td key={i} className={`${td} ${best ? 'font-bold text-primary' : ''}`}>
                        {v > 0 ? fmtSector(v) : '–'}
                      </td>
                    )
                  })}
                  {show('fuel') && <td className={td}>
                    {m.fuel_used > 0 ? fuelFromL(m.fuel_used, units).toFixed(2) : '–'}
                  </td>}
                  {show('fuel') && <td className={td}>
                    {fuelFromL(m.fuel_left, units).toFixed(1)}
                  </td>}
                  <td className={td}>
                    {speedFromMps(m.max_speed, units).toFixed(0)} <span className="opacity-50">{su}</span>
                  </td>
                  {show('inputs') && <>
                    <td className={td}>{m.throttle_full_pct.toFixed(0)}%</td>
                    <td className={td}>{m.braking_pct.toFixed(0)}%</td>
                    <td className={td}>{m.coasting_pct.toFixed(0)}%</td>
                    <td className={td}>{m.overlap_pct.toFixed(1)}%</td>
                    <td className={td}>{m.steering_reversals.toFixed(0)}</td>
                  </>}
                  {show('tyres') && CORNERS.map(c => {
                    const y = m.tyres.find(x => x.corner === c)
                    if (!y) return <td key={c} className={td}>–</td>
                    return (
                      <td key={c} className={`${td} leading-tight`}>
                        <div>{tempFromC(y.temp_m, units).toFixed(0)}{tu} · {(y.wear * 100).toFixed(0)}%</div>
                        <div className="text-[10px] opacity-60">
                          {/* kPa runs to three digits and needs none; psi is
                              a two-digit number where a tenth still matters */}
                          {(v => v.toFixed(v >= 100 ? 0 : 1))(pressureFromKpa(y.pressure, units))} {pu}
                        </div>
                      </td>
                    )
                  })}
                  {show('weather') && <>
                    <td className={td}>{tempFromC(m.track_temp, units).toFixed(1)}{tu}</td>
                    <td className={td}>{tempFromC(m.air_temp, units).toFixed(1)}{tu}</td>
                  </>}
                  <td className={`${td} ${m.off_track > 0 ? 'text-rose-500 font-semibold' : ''}`}>
                    {m.off_track || ''}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
