import { useState, useEffect } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, getLapColor, lapKey, type Session } from '@/store/session'
import SidebarTrackMap from '@/components/SidebarTrackMap'
import { useT } from '@/lib/i18n'
import { Spinner } from '@/components/LoadingIndicator'

function LapRow({ sessionId, lapNumber, lapTime, isValid, colorIndex, fastestTime, disabled }: {
  sessionId: string
  lapNumber: number
  lapTime: number
  isValid: boolean
  colorIndex: number
  fastestTime: number
  disabled: boolean
}) {
  const t = useT()
  const { selectedLapKeys, toggleLap } = useSessionStore()
  const key = lapKey(sessionId, lapNumber)
  const selected = selectedLapKeys.includes(key)
  const color = getLapColor(colorIndex)

  const mins = Math.floor(lapTime / 60)
  const secs = (lapTime % 60).toFixed(3).padStart(6, '0')
  const timeStr = lapTime > 10 ? `${mins}:${secs}` : '–'
  const delta = isValid && lapTime > 10 && fastestTime < Infinity && lapTime !== fastestTime
    ? `+${(lapTime - fastestTime).toFixed(2)}`
    : null
  const isBest = isValid && lapTime > 10 && lapTime === fastestTime

  return (
    <label
      className={`flex items-center gap-2.5 py-1 pl-3 pr-3 select-none transition-colors ${
        disabled ? 'opacity-30 cursor-not-allowed'
          : selected ? 'bg-secondary/60 cursor-pointer'
          : 'hover:bg-secondary/40 cursor-pointer'
      }`}
      title={disabled ? t('notComparable') : undefined}
    >
      {/* No colour bar down the edge: the card already carries one there for the
          active session, and a second stripe beside it read as a stray mark —
          on a lap whose colour happens to be the accent, as one thick bar. The
          swatch below says the same thing where the eye is already looking. */}
      <span
        className="w-3 h-3 rounded shrink-0 border-2 transition-colors"
        style={{
          backgroundColor: selected ? color : 'transparent',
          borderColor: selected ? color : 'hsl(var(--border))',
        }}
      />
      <input type="checkbox" className="sr-only" checked={selected} disabled={disabled} onChange={() => !disabled && toggleLap(sessionId, lapNumber)} />
      <span className="text-[11px] font-mono text-muted-foreground/70 w-6 shrink-0">L{lapNumber}</span>
      <span className={`text-xs font-mono tabular-nums flex-1 ${
        !isValid ? 'text-muted-foreground/40' : selected ? 'text-foreground font-semibold' : 'text-foreground'
      }`}>
        {timeStr}
      </span>
      {/* One column for both, so BEST and a gap sit on the same right edge
          instead of each ending wherever its own text does */}
      <span className="w-12 shrink-0 text-right text-[10px] font-mono tabular-nums">
        {isBest
          ? <span className="text-emerald-500 font-bold tracking-wide">BEST</span>
          : delta ? <span className="text-muted-foreground/70">{delta}</span> : null}
      </span>
    </label>
  )
}

function SessionCard({ session, active, showFile, onActivate, onRemove, children }: {
  session: Session
  active: boolean
  /** Another loaded session shares this track and car, so the file name is the
   *  only thing that tells them apart and has to be on show. */
  showFile: boolean
  onActivate: () => void
  onRemove: () => void
  /** Its laps, inside the card. They are part of the session, and sitting under
   *  it in the open they read as a second, unattached list. */
  children?: React.ReactNode
}) {
  const t = useT()
  const openTrackGuide = (e: React.MouseEvent) => {
    e.stopPropagation()
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(`iRacing "${session.car}" "${session.track}" track guide`)}`
    invoke('open_url', { url })
  }
  return (
    <div
      className={`relative mx-2 rounded-xl border overflow-hidden transition-colors ${
        active ? 'bg-secondary/40 border-border' : 'border-border/50 hover:border-border'
      }`}
    >
      {/* Which session the app is working on, as a bar rather than a dot: it
          marks the card and everything in it */}
      {active && <span className="absolute left-0 inset-y-0 w-[3px] bg-primary z-10" />}

      {/* Only the head activates the session — a click on a lap row must not,
          since switching sessions can clear the selection being built */}
      <div
        onClick={onActivate}
        className={`group/card flex items-start gap-2 pl-3 pr-2 py-2 cursor-pointer transition-colors ${
          active ? '' : 'hover:bg-secondary/30'
        }`}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] font-semibold text-foreground truncate leading-tight">{session.track}</span>
            <span className="ml-auto text-[10px] text-muted-foreground/60 shrink-0 tabular-nums">
              {session.date.slice(0, 10)}
            </span>
          </div>
          <div className="text-[10px] text-muted-foreground truncate leading-tight mt-0.5">
            {session.car}{session.driver ? ` · ${session.driver}` : ''}
          </div>
          <div className="flex items-center gap-2 mt-1 min-w-0">
            <button
              onClick={openTrackGuide}
              className="shrink-0 text-[9px] font-semibold rounded-full px-2 py-0.5 border border-border/70 text-muted-foreground hover:text-primary hover:border-primary/50 transition-colors flex items-center gap-1"
              title={t('trackGuide')}
            >
              ▶ {t('trackGuide')}
            </button>
            {showFile && (
              <span className="text-[9px] text-muted-foreground/50 truncate leading-tight"
                title={session.file_path}>
                {session.file_path.split(/[\\/]/).pop()}
              </span>
            )}
          </div>
        </div>
        {/* Out of the way until wanted — it deletes what you just loaded */}
        <button
          onClick={e => { e.stopPropagation(); onRemove() }}
          className="shrink-0 p-1 rounded-lg text-muted-foreground/40 opacity-0 group-hover/card:opacity-100 focus:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-all"
          title={t('removeSession')}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M2 2l8 8M10 2l-8 8"/>
          </svg>
        </button>
      </div>

      {children && (
        <div className="border-t border-border/50 py-0.5 bg-card">{children}</div>
      )}
    </div>
  )
}

function fmtTime(t: number): string {
  if (t <= 0 || !isFinite(t)) return '–'
  const m = Math.floor(t / 60)
  const s = (t % 60).toFixed(3).padStart(6, '0')
  return `${m}:${s}`
}

/** What the selected laps add up to — and only that. The track, the car and the
 *  driver are on the session card above, so repeating them here said the same
 *  thing three times over; the best lap used to be printed twice within this
 *  strip alone. */
function SelectionPanel() {
  const t = useT()
  const { sessions, selectedLapKeys } = useSessionStore()
  const [idealTime, setIdealTime] = useState<number | null>(null)

  const selectedLaps = selectedLapKeys
    .map(key => {
      const idx = key.lastIndexOf(':')
      const sessionId = key.slice(0, idx)
      const lapNum = parseInt(key.slice(idx + 1))
      const sess = sessions.find(s => s.id === sessionId)
      return sess?.laps.find(l => l.lap_number === lapNum)
    })
    .filter((l): l is NonNullable<typeof l> => !!l && l.is_valid && l.lap_time > 10)

  // Compute ideal lap when selection changes (only within a single session)
  useEffect(() => {
    setIdealTime(null)
    if (selectedLapKeys.length < 2) return
    const bySession: Record<string, number[]> = {}
    selectedLapKeys.forEach(key => {
      const idx = key.lastIndexOf(':')
      const sid = key.slice(0, idx)
      const num = parseInt(key.slice(idx + 1))
      ;(bySession[sid] ??= []).push(num)
    })
    const sids = Object.keys(bySession)
    if (sids.length !== 1 || bySession[sids[0]].length < 2) return
    invoke<number>('compute_ideal_lap', { sessionId: sids[0], lapNumbers: bySession[sids[0]] })
      .then(setIdealTime)
      .catch(() => setIdealTime(null))
  }, [selectedLapKeys.join(',')])

  if (selectedLaps.length === 0) return null

  const times = selectedLaps.map(l => l.lap_time)
  const best = Math.min(...times)
  const mean = times.reduce((a, b) => a + b, 0) / times.length
  const stddev = Math.sqrt(times.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / times.length)
  // Scale: 0.3s spread → ~98%, 1s spread → ~95%, 3s spread → ~85%, 5s spread → ~76%
  const consistency = Math.max(0, Math.min(100, 100 - (stddev / best) * 800))
  const spread = Math.max(...times) - best

  const scoreColor =
    consistency >= 95 ? 'text-emerald-400' :
    consistency >= 85 ? 'text-amber-400' :
    'text-red-400'

  const barColor =
    consistency >= 95 ? 'bg-emerald-400' :
    consistency >= 85 ? 'bg-amber-400' :
    'bg-red-400'

  const idealDelta = idealTime != null ? best - idealTime : null
  const multiple = selectedLaps.length > 1

  return (
    <div className="shrink-0 border-t border-border px-3 py-2 bg-secondary/20 space-y-1.5">

      {/* The number being read, and what it is the best of */}
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/70 whitespace-nowrap">
          {t('fastestSelected')}
        </span>
        <span className="text-sm font-bold font-mono tabular-nums text-foreground leading-none">
          {fmtTime(best)}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground/70 whitespace-nowrap">
          {selectedLapKeys.length} {t('lapsSelected')}
        </span>
      </div>

      {/* How the laps sat together. One lap has nothing to be consistent with,
          so the row waits until there are two. */}
      {multiple && (
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] text-muted-foreground/60">Consistency</span>
            <span className={`text-[11px] font-bold tabular-nums ${scoreColor}`}>{consistency.toFixed(1)}%</span>
            <span className="w-16 h-1.5 bg-secondary rounded-full overflow-hidden">
              <span className={`block h-full rounded-full transition-all ${barColor}`} style={{ width: `${consistency}%` }} />
            </span>
          </span>
          <span className="text-[10px] text-muted-foreground/60 shrink-0">
            {t('lapSpread')} <span className="text-foreground font-mono tabular-nums">+{spread.toFixed(3)}s</span>
          </span>
          <span className="text-[10px] text-muted-foreground/60 shrink-0">
            {t('idealLap')} {idealTime != null ? (
              <span className="text-foreground font-mono tabular-nums">
                {fmtTime(idealTime)}
                {idealDelta != null && Math.abs(idealDelta) > 0.01 && (
                  <span className="text-sky-500 ml-1">-{Math.abs(idealDelta).toFixed(3)}s</span>
                )}
              </span>
            ) : <span className="text-muted-foreground/40">–</span>}
          </span>
        </div>
      )}
    </div>
  )
}

export default function LapSidebar() {
  const t = useT()
  const { sessions, activeSessionId, setActiveSessionId, removeSession, loading, error, loadFiles, autoLoad, setAutoLoad, sidebarMapExpanded } = useSessionStore()

  // The lap each gap is measured against, per track and car.
  //
  // Taking the fastest lap of everything loaded compares across circuits: with
  // a Nurburgring session and an Imola one open, every Nurburgring lap showed a
  // gap of about +373 s to a lap of Imola, and no lap was marked as the best
  // because the best one belonged to the other session. Sessions of the same
  // track and car still share a reference, which is the case where comparing
  // across sessions means something.
  //
  // Still per car, even though laps of two cars can now be selected together: a
  // GT3 and a Cup car round the same circuit are seconds apart by class, and
  // measuring the slower one's laps against the faster car's best would bury
  // what the list is for — which of *its own* laps was the good one. Each car
  // keeps its own best, and the delta view compares them against each other.
  const fastestByGroup = new Map<string, number>()
  for (const s of sessions) {
    const key = `${s.track}|${s.car}`
    for (const l of s.laps) {
      if (!l.is_valid || l.lap_time <= 10) continue
      const cur = fastestByGroup.get(key)
      if (cur == null || l.lap_time < cur) fastestByGroup.set(key, l.lap_time)
    }
  }
  const fastestFor = (s: typeof sessions[0]) =>
    fastestByGroup.get(`${s.track}|${s.car}`) ?? Infinity

  const handleOpen = async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: 'iRacing Telemetry', extensions: ['ibt'] }],
    })
    if (!selected) return
    const paths = Array.isArray(selected) ? selected : [selected]
    if (paths.length > 0) await loadFiles(paths)
  }

  const { selectedLapKeys } = useSessionStore()
  const keyColorIndex: Record<string, number> = {}
  selectedLapKeys.forEach((k, i) => { keyColorIndex[k] = i })

  // Determine compatibility: a session is incompatible only if it was driven on
  // a different circuit. The car may differ — two cars round the same track is
  // a comparison worth having, and everything the app compares by is lap
  // distance, which they share.
  const selectedSessionIds = new Set(selectedLapKeys.map(k => {
    const idx = k.lastIndexOf(':')
    return k.slice(0, idx)
  }))
  const selectedSessions = sessions.filter(s => selectedSessionIds.has(s.id))
  const refTrack = selectedSessions[0]?.track ?? null
  const isSessionCompatible = (s: typeof sessions[0]) =>
    !refTrack || s.track === refTrack

  // Laps are listed for the active session, for any session laps are already
  // selected from, and for every session on the active session's circuit —
  // those are exactly the ones that can be compared against it
  const activeSession = sessions.find(s => s.id === activeSessionId)
  const showsLaps = (s: typeof sessions[0]) =>
    s.id === activeSessionId
    || selectedSessionIds.has(s.id)
    || (!!activeSession && s.track === activeSession.track)

  return (
    <aside
      className="shrink-0 border-r border-border bg-card flex flex-col overflow-hidden transition-[width] duration-200"
      style={{ width: sidebarMapExpanded ? '35vw' : 320 }}
    >

      {/* Header */}
      <div className="px-3 pt-2.5 pb-2 border-b border-border shrink-0 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">{t('sessions')}</p>
          {loading && (
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <Spinner size={11} /> {t('loading')}
            </span>
          )}
          {error && <p className="text-[10px] text-destructive truncate" title={error}>{t('errorLoadingFile')}</p>}
          {sessions.length === 0 && !loading && (
            <p className="text-[10px] text-muted-foreground/50">{t('noSessionLoaded')}</p>
          )}
        </div>
        {/* Auto-load toggle */}
        <button
          onClick={() => setAutoLoad(!autoLoad)}
          title={t('autoLoadFiles')}
          className="flex items-center gap-1.5 shrink-0 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <span className="hidden sm:inline">Auto</span>
          <span className={`relative inline-flex w-7 h-3.5 rounded-full transition-colors shrink-0 ${autoLoad ? 'bg-primary' : 'bg-muted'}`}>
            <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-transform ${autoLoad ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
          </span>
        </button>
        {/* Load files button */}
        <button
          onClick={handleOpen}
          title={t('loadFiles')}
          className="shrink-0 flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground border border-border hover:border-foreground/30 rounded-md px-2 py-1 transition-colors"
        >
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M5 1v8M1 5h8"/>
          </svg>
          Load
        </button>
      </div>

      {/* Sessions, each with its own laps inside it */}
      <div className="overflow-y-auto py-2 space-y-2 flex-1 min-h-0">
        {sessions.map(session => {
          const rows = showsLaps(session)
            ? session.laps.filter(lap => lap.is_valid).map(lap => {
                const k = lapKey(session.id, lap.lap_number)
                const ci = keyColorIndex[k] ?? -1
                const isSelected = selectedLapKeys.includes(k)
                return (
                  <LapRow
                    key={k}
                    sessionId={session.id}
                    lapNumber={lap.lap_number}
                    lapTime={lap.lap_time}
                    isValid={lap.is_valid}
                    colorIndex={ci >= 0 ? ci : selectedLapKeys.length}
                    fastestTime={fastestFor(session)}
                    disabled={!isSelected && !isSessionCompatible(session)}
                  />
                )
              })
            : []
          return (
            <SessionCard
              key={session.id}
              session={session}
              active={activeSessionId === session.id}
              showFile={sessions.some(o =>
                o.id !== session.id && o.track === session.track && o.car === session.car)}
              onActivate={() => setActiveSessionId(session.id)}
              onRemove={() => removeSession(session.id)}
            >
              {rows.length ? rows : null}
            </SessionCard>
          )
        })}
      </div>

      <SelectionPanel />

      <SidebarTrackMap />
    </aside>
  )
}
