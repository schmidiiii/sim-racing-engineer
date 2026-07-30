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
/** Which groups a fresh start shows. Not remembered between runs: a column
 *  switch and a race length are where the reader happens to be looking, not a
 *  preference, and an app that reopens mid-thought is confusing. Theme and
 *  units are preferences, and those do persist. */
const DEFAULT_GROUPS: ColGroup[] = ['sectors', 'fuel', 'inputs']
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

// ── Summary cards ─────────────────────────────────────────────────────────────

/** Same card as the telemetry tabs use, so the Laps tab does not look like a
 *  different application. */
function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm p-3 min-w-0">
      <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide truncate">{label}</p>
      <p className="font-bold text-base mt-0.5 leading-tight text-foreground tabular-nums truncate" title={value}>{value}</p>
      {hint && <p className="text-muted-foreground text-[10px] mt-0.5 truncate">{hint}</p>}
    </div>
  )
}

/** Header cell. `edge` draws the divider that separates one column group from
 *  the next. */
function Th({ label, title, edge }: { label: string; title?: string; edge?: boolean }) {
  return (
    <th
      title={title}
      className={`px-2 py-2 text-right text-[11px] font-semibold whitespace-nowrap text-foreground/80 ${
        edge ? 'border-l border-border' : ''
      }`}
    >
      {label}
    </th>
  )
}

/** The unit that follows a number, dimmed so the column still reads as a column
 *  of figures. Times, gaps and sector splits carry none: seconds are obvious
 *  from the shape of the number and the label would only crowd them. */
const U = ({ children }: { children: string }) => (
  <span className="opacity-45 text-[10px] ml-0.5">{children}</span>
)

export default function LapTable() {
  const t = useT()
  const { sessions, activeSessionId, selectedLapKeys, toggleLap, units } = useSessionStore()
  const [summaries, setSummaries] = useState<LapSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [groups, setGroups] = useState<Set<ColGroup>>(() => new Set(DEFAULT_GROUPS))
  /** Name of the file just written, so the export confirms it did something */
  const [exported, setExported] = useState<string | null>(null)
  const [raceLen, setRaceLen] = useState('')
  const [raceUnit, setRaceUnit] = useState<'laps' | 'min'>('laps')

  const session = sessions.find(s => s.id === activeSessionId) ?? sessions[0]

  const toggleGroup = (g: ColGroup) => {
    setGroups(prev => {
      const next = new Set(prev)
      next.has(g) ? next.delete(g) : next.add(g)
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
    return {
      best,
      median: median(times),
      spread: stdDev(clean),
      cleanCount: clean.length,
      avgFuel,
      maxFuel,
      offs: pace.reduce((a, m) => a + m.off_track, 0),
    }
  }, [pace])

  // Best time per sector across the pace laps — the "ideal lap" split by split
  const bestSectors = useMemo(() => {
    const n = Math.max(0, ...pace.map(m => m.sectors.length))
    return Array.from({ length: n }, (_, i) => {
      const vals = pace.map(m => m.sectors[i]).filter(v => typeof v === 'number' && v > 0)
      return vals.length ? Math.min(...vals) : 0
    })
  }, [pace])

  const idealLap = bestSectors.reduce((a, b) => a + b, 0)

  // Fuel plan. Two figures, not one: the average is what the stint will most
  // likely take and the heaviest lap is what it might, and a plan built on the
  // average runs dry on the heavy laps. Racers add a lap on top of that, which
  // is what the reserve is.
  const plan = useMemo(() => {
    const cap = session?.fuel_capacity ?? 0
    const n = Number(raceLen)
    if (!(n > 0) || stint.avgFuel <= 0) return null
    // A race given in minutes has to be turned into laps, and at the median
    // pace rather than the best lap — nobody laps a whole race on their best
    const pace = stint.median > 10 ? stint.median : stint.best
    const laps = raceUnit === 'laps' ? Math.ceil(n) : (pace > 10 ? Math.ceil(n * 60 / pace) : 0)
    if (!laps) return null
    const need = laps * stint.avgFuel
    const needSafe = laps * (stint.maxFuel || stint.avgFuel)
    const reserve = stint.maxFuel || stint.avgFuel   // one lap in hand
    const heavy = stint.maxFuel || stint.avgFuel
    const lapsPerTank = cap > 0 ? Math.floor(cap / heavy) : 0
    const stops = cap > 0 ? Math.max(0, Math.ceil((needSafe + reserve) / cap) - 1) : 0

    // Two answers, because there are two questions. Splitting the race into
    // equal stints is what a team plans; running the tank dry is the deadline
    // that cannot be moved. Both assume the car starts full.
    const stints = stops + 1
    const schedule = Array.from({ length: stops }, (_, i) => {
      const latest = Math.min(laps - 1, lapsPerTank * (i + 1))
      // Never later than the deadline: rounding an even split can land a lap
      // past where the tank runs dry, and a plan that says to stop after
      // running out is worse than no plan
      const even = Math.min(Math.round(laps * (i + 1) / stints), latest)
      const after = laps - even            // laps still to run after this stop
      return {
        even,
        latest,
        // Enough for what is left, or a full tank when what is left needs more
        add: Math.min(cap, after * heavy + reserve),
      }
    })

    return {
      laps,
      pace,
      need,
      needSafe: needSafe + reserve,
      cap,
      lapsPerTank,
      stops,
      schedule,
      // What to leave the pits with at the start
      startFuel: cap > 0 ? Math.min(cap, needSafe + reserve) : needSafe + reserve,
    }
  }, [session?.fuel_capacity, raceLen, raceUnit, stint])

  const exportCsv = async () => {
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
    // The byte order mark is for Excel, which otherwise reads the file as the
    // system code page and mangles anything that is not ASCII.
    const csv = '﻿' + [head, ...rows].map(r => r.join(',')).join('\r\n')
    const name = (session?.file_path.split(/[\\/]/).pop() ?? 'session').replace(/\.ibt$/i, '')
    const file = `${name}-laps.csv`

    if ('__TAURI_INTERNALS__' in window) {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const path = await save({
        defaultPath: file,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      })
      if (!path) return                       // the user cancelled
      try {
        await invoke('save_text_file', { path, contents: csv })
        setExported(path.split(/[\\/]/).pop() ?? file)
        setTimeout(() => setExported(null), 4000)
      } catch (e) {
        setError(String(e))
      }
      return
    }

    // Outside Tauri — the browser route still works there
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = file
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

  // `edge` marks the first column of a group, which carries the heavier
  // divider. With two dozen numbers a row, the eye needs somewhere to rest.
  const td = 'px-2 py-1.5 text-right'
  const edge = 'border-l border-border'

  return (
    <div className="flex-1 overflow-auto bg-background p-4 space-y-4">
      {/* Stint at a glance */}
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label={t('lapTablePaceLaps')} value={String(pace.length)}
              hint={`${summaries.length} ${t('lapTableTotal')}`} />
        <Stat label={t('lapTableBest')} value={fmtLap(stint.best)} />
        <Stat label={t('lapTableIdeal')} value={fmtLap(idealLap)}
              hint={idealLap > 0 && stint.best > 0 ? `−${(stint.best - idealLap).toFixed(3)}s` : undefined} />
        <Stat label={t('lapTableConsistency')} value={`±${stint.spread.toFixed(3)}s`}
              hint={`${stint.cleanCount} ${t('lapTableWithin3')}`} />
        <Stat label={t('lapTableFuelPerLap')}
              value={stint.avgFuel > 0 ? `Ø ${fuelFromL(stint.avgFuel, units).toFixed(2)} ${fu}` : '–'}
              hint={stint.maxFuel > 0 ? `${t('lapTableWorst')} ${fuelFromL(stint.maxFuel, units).toFixed(2)}` : undefined} />
      </div>

      {/* Fuel plan. Only where the tank size is known — the ratio of the two
          fuel channels gives it, but a session that never reported a percentage
          leaves nothing to plan with. */}
      <div className="bg-card rounded-xl border border-border shadow-sm px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mr-1">
            {t('planTitle')}
          </p>
          <input
            type="number" min="1" inputMode="numeric"
            value={raceLen}
            onChange={e => setRaceLen(e.target.value)}
            placeholder={raceUnit === 'laps' ? '20' : '45'}
            className="w-20 text-xs tabular-nums bg-transparent border border-border rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {(['laps', 'min'] as const).map(u => (
            <button
              key={u}
              onClick={() => setRaceUnit(u)}
              className={`text-xs font-semibold px-2.5 py-1 rounded-lg border transition-colors ${
                raceUnit === u
                  ? 'border-primary text-primary bg-primary/10'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {u === 'laps' ? t('planLaps') : t('planMinutes')}
            </button>
          ))}
        </div>

        {!plan ? (
          <p className="text-[11px] text-muted-foreground mt-2">
            {stint.avgFuel > 0 ? t('planPrompt') : t('planNoFuel')}
          </p>
        ) : (
          <div className="mt-2.5 grid gap-2 grid-cols-2 sm:grid-cols-4">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('planRaceLaps')}</p>
              <p className="text-sm font-semibold tabular-nums text-foreground">
                {plan.laps}
                {raceUnit === 'min' && (
                  <span className="text-[10px] font-normal text-muted-foreground ml-1">
                    {t('planAtPace').replace('%t%', fmtLap(plan.pace))}
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('planNeed')}</p>
              <p className="text-sm font-semibold tabular-nums text-foreground">
                {fuelFromL(plan.needSafe, units).toFixed(1)} {fu}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {t('planOnAverage').replace('%v%', fuelFromL(plan.need, units).toFixed(1))}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('planPerTank')}</p>
              <p className="text-sm font-semibold tabular-nums text-foreground">
                {plan.cap > 0 ? `${plan.lapsPerTank}` : '–'}
              </p>
              {plan.cap > 0 && (
                <p className="text-[10px] text-muted-foreground">
                  {t('planTank').replace('%v%', fuelFromL(plan.cap, units).toFixed(0))} {fu}
                </p>
              )}
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('planStops')}</p>
              <p className={`text-sm font-semibold tabular-nums ${plan.cap > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                {plan.cap > 0 ? plan.stops : '–'}
              </p>
              {plan.cap <= 0 && (
                <p className="text-[10px] text-muted-foreground">{t('planNoTank')}</p>
              )}
            </div>
          </div>
        )}

        {plan && plan.cap > 0 && (
          <div className="mt-3 pt-2.5 border-t border-border/50">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              {t('planSchedule')}
            </p>
            <p className="text-xs text-foreground">
              {t('planStart').replace('%v%', `${fuelFromL(plan.startFuel, units).toFixed(1)} ${fu}`)}
            </p>
            {plan.stops === 0 ? (
              <p className="text-xs text-muted-foreground mt-0.5">{t('planNoStop')}</p>
            ) : plan.schedule.map((st, i) => (
              <p key={i} className="text-xs text-foreground mt-0.5 tabular-nums">
                {t('planStopLine')
                  .replace('%n%', String(i + 1))
                  .replace('%lap%', String(st.even))
                  .replace('%latest%', String(st.latest))
                  .replace('%add%', `${fuelFromL(st.add, units).toFixed(1)} ${fu}`)}
              </p>
            ))}
            <p className="text-[10px] text-muted-foreground mt-1">{t('planAssume')}</p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {COL_GROUPS.map(g => (
          <button
            key={g}
            onClick={() => toggleGroup(g)}
            className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors ${
              show(g)
                ? 'border-primary text-primary bg-primary/10'
                : 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60'
            }`}
          >
            {groupLabel[g]}
          </button>
        ))}
        <button
          onClick={exportCsv}
          className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-border bg-secondary/60 text-foreground hover:bg-secondary transition-colors shadow-sm"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v12M7 11l5 5 5-5M4 20h16" />
          </svg>
          {t('lapTableExport')}
        </button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {exported ? `${t('lapTableExported')} ${exported}` : t('lapTableHint')}
      </p>

      {/* A card like every other panel, with the table scrolling inside it so
          the page never scrolls sideways */}
      <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums border-collapse">
          <thead>
            <tr className="bg-secondary/40 border-b border-border">
              <th className="px-2 py-1.5 text-left font-semibold align-bottom">
                <span className="block text-[11px] leading-tight text-foreground/80">{t('lapTableLap')}</span>
              </th>
              <Th label={t('lapTableTime')} />
              <Th label={t('lapTableGap')} />
              {show('sectors') && Array.from({ length: nSec }, (_, i) => (
                <Th key={i} label={`S${i + 1}`} edge={i === 0} />
              ))}
              {show('fuel') && <>
                <Th label={t('lapTableUsed')} title={t('lapTableUsedHint')} edge />
                <Th label={t('lapTableTank')} title={t('lapTableTankHint')} />
              </>}
              <Th label={t('lapTableVmax')} edge />
              {show('inputs') && <>
                <Th label={t('lapTableFull')} title={t('lapTableFullHint')} edge />
                <Th label={t('lapTableBrake')} />
                <Th label={t('lapTableCoast')} title={t('lapTableCoastHint')} />
                <Th label={t('lapTableOverlap')} title={t('lapTableOverlapHint')} />
                <Th label={t('lapTableReversals')} title={t('lapTableReversalsHint')} />
              </>}
              {show('tyres') && CORNERS.map((c, i) => (
                <Th key={c} label={cornerLabel[c]} title={t('lapTableTyreHint')} edge={i === 0} />
              ))}
              {show('weather') && <>
                <Th label={t('lapTableTrackTemp')} edge />
                <Th label={t('lapTableAirTemp')} />
              </>}
              <Th label={t('lapTableOff')} edge />
            </tr>
          </thead>
          <tbody>
            {summaries.map(m => {
              const key = lapKey(session.id, m.lap_number)
              const selIdx = selectedLapKeys.indexOf(key)
              const selected = selIdx >= 0
              const paceLap = isPaceLap(m)
              const isBest = paceLap && m.lap_time === stint.best
              // The rest of the app only compares laps iRacing timed in full —
              // the sidebar does not even list the others. Letting them be
              // picked here just leaves the delta view with nothing to compare.
              const selectable = m.is_valid
              return (
                <tr
                  key={m.lap_number}
                  onClick={() => selectable && toggleLap(session.id, m.lap_number)}
                  title={selectable ? undefined : t('lapTableNotTimed')}
                  className={`border-b border-border/40 last:border-0 transition-colors ${
                    selectable ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
                  } ${
                    // Selection is a plain highlight, not a colour: purple is
                    // reserved for the best time, the way a timing screen uses
                    // it, and two meanings in one colour read as one meaning
                    selected ? 'bg-secondary'
                      : `odd:bg-secondary/15 ${selectable ? 'hover:bg-secondary/40' : ''}`
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
                  <td className={`${td} ${isBest ? 'font-bold text-violet-500' : ''}`}>{fmtLap(m.lap_time)}</td>
                  <td className={`${td} text-muted-foreground`}>
                    {paceLap && stint.best > 0 ? fmtGap(m.lap_time - stint.best) : ''}
                  </td>
                  {show('sectors') && Array.from({ length: nSec }, (_, i) => {
                    const v = m.sectors[i]
                    const best = paceLap && v > 0 && Math.abs(v - bestSectors[i]) < 1e-6
                    return (
                      <td key={i} className={`${td} ${i === 0 ? edge : ''} ${best ? 'font-bold text-violet-500' : ''}`}>
                        {v > 0 ? fmtSector(v) : '–'}
                      </td>
                    )
                  })}
                  {show('fuel') && <>
                    <td className={`${td} ${edge}`}>
                      {m.fuel_used > 0 ? <>{fuelFromL(m.fuel_used, units).toFixed(2)}<U>{fu}</U></> : '–'}
                    </td>
                    <td className={td}>{fuelFromL(m.fuel_left, units).toFixed(1)}<U>{fu}</U></td>
                  </>}
                  <td className={`${td} ${edge}`}>
                    {speedFromMps(m.max_speed, units).toFixed(0)}<U>{su}</U>
                  </td>
                  {show('inputs') && <>
                    <td className={`${td} ${edge}`}>{m.throttle_full_pct.toFixed(0)}<U>%</U></td>
                    <td className={td}>{m.braking_pct.toFixed(0)}<U>%</U></td>
                    <td className={td}>{m.coasting_pct.toFixed(0)}<U>%</U></td>
                    <td className={td}>{m.overlap_pct.toFixed(1)}<U>%</U></td>
                    <td className={td}>{m.steering_reversals.toFixed(0)}<U>/min</U></td>
                  </>}
                  {show('tyres') && CORNERS.map((c, i) => {
                    const y = m.tyres.find(x => x.corner === c)
                    const cls = `${td} ${i === 0 ? edge : ''}`
                    if (!y) return <td key={c} className={cls}>–</td>
                    return (
                      <td key={c} className={`${cls} whitespace-nowrap`}>
                        {tempFromC(y.temp_m, units).toFixed(0)}<U>{tu}</U>
                        <span className="opacity-30"> · </span>
                        {(y.wear * 100).toFixed(0)}<U>%</U>
                        <span className="opacity-30"> · </span>
                        {/* kPa runs to three digits and needs none; psi is a
                            two-digit number where a tenth still matters */}
                        {(v => v.toFixed(v >= 100 ? 0 : 1))(pressureFromKpa(y.pressure, units))}<U>{pu}</U>
                      </td>
                    )
                  })}
                  {show('weather') && <>
                    <td className={`${td} ${edge}`}>{tempFromC(m.track_temp, units).toFixed(1)}<U>{tu}</U></td>
                    <td className={td}>{tempFromC(m.air_temp, units).toFixed(1)}<U>{tu}</U></td>
                  </>}
                  <td className={`${td} ${edge} ${m.off_track > 0 ? 'text-rose-500 font-semibold' : ''}`}>
                    {m.off_track || ''}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}
