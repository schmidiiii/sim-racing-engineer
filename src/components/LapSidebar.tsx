import { useState, useEffect } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, getLapColor, lapKey, type Session } from '@/store/session'
import TrackMap from '@/components/TrackMap'
import { useT } from '@/lib/i18n'

function LapRow({ sessionId, lapNumber, lapTime, isValid, colorIndex, fastestTime, disabled }: {
  sessionId: string
  lapNumber: number
  lapTime: number
  isValid: boolean
  colorIndex: number
  fastestTime: number
  disabled: boolean
}) {
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
      className={`flex items-center gap-2.5 py-1.5 px-3 select-none transition-colors group ${
        disabled ? 'opacity-30 cursor-not-allowed' : 'hover:bg-secondary/50 cursor-pointer'
      }`}
      title={disabled ? 'Andere Strecke oder Auto — nicht vergleichbar' : undefined}
    >
      <span
        className="w-3 h-3 rounded shrink-0 border-2 transition-colors"
        style={{
          backgroundColor: selected ? color : 'transparent',
          borderColor: selected ? color : 'hsl(var(--border))',
        }}
      />
      <input type="checkbox" className="sr-only" checked={selected} disabled={disabled} onChange={() => !disabled && toggleLap(sessionId, lapNumber)} />
      <span className="text-xs font-mono text-muted-foreground w-6 shrink-0">L{lapNumber}</span>
      <span className={`text-xs font-mono tabular-nums flex-1 ${isValid ? 'text-foreground' : 'text-muted-foreground/40'}`}>
        {timeStr}
      </span>
      {isBest && <span className="text-[10px] text-emerald-500 font-semibold">BEST</span>}
      {delta && <span className="text-[10px] text-muted-foreground font-mono tabular-nums">{delta}</span>}
    </label>
  )
}

function SessionCard({ session, active, onActivate, onRemove }: {
  session: Session
  active: boolean
  onActivate: () => void
  onRemove: () => void
}) {
  const t = useT()
  const openTrackGuide = (e: React.MouseEvent) => {
    e.stopPropagation()
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(`iRacing "${session.car}" "${session.track}" track guide`)}`
    invoke('open_url', { url })
  }
  return (
    <div
      className={`group/card mx-2 mb-1 rounded-lg border transition-colors cursor-pointer ${
        active
          ? 'bg-secondary/70 border-border'
          : 'bg-transparent border-transparent hover:bg-secondary/30 hover:border-border/50'
      }`}
      onClick={onActivate}
    >
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-1.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            {active && (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
            )}
            <span className="text-xs font-semibold text-foreground truncate leading-tight">{session.track}</span>
          </div>
          <span className="text-[11px] text-muted-foreground truncate block leading-tight">{session.car}</span>
          <div className="flex items-center justify-between mt-0.5">
            <span className="text-[10px] text-muted-foreground/60">{session.date.slice(0, 10)}</span>
            <button
              onClick={openTrackGuide}
              className="text-[10px] font-medium text-muted-foreground hover:text-primary transition-colors flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-primary/10"
              title={t('trackGuide')}
            >
              ▶ {t('trackGuide')}
            </button>
          </div>
        </div>
        <button
          onClick={e => { e.stopPropagation(); onRemove() }}
          className="text-muted-foreground/40 hover:text-destructive transition-colors mt-0.5 shrink-0 p-0.5 rounded hover:bg-destructive/10"
          title={t('removeSession')}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M2 2l8 8M10 2l-8 8"/>
          </svg>
        </button>
      </div>
    </div>
  )
}

function fmtTime(t: number): string {
  if (t <= 0 || !isFinite(t)) return '–'
  const m = Math.floor(t / 60)
  const s = (t % 60).toFixed(3).padStart(6, '0')
  return `${m}:${s}`
}

function ConsistencyPanel() {
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

  if (selectedLaps.length < 2) return null

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

  return (
    <div className="shrink-0 border-t border-border px-3 py-2.5 bg-secondary/20">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">{t('consistencyScore')}</p>
        <p className={`text-sm font-bold tabular-nums ${scoreColor}`}>{consistency.toFixed(1)}%</p>
      </div>
      <div className="h-1 bg-secondary rounded-full mb-2 overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${consistency}%` }} />
      </div>
      <div className="grid grid-cols-3 gap-x-2">
        <div>
          <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">Best</p>
          <p className="text-xs font-mono text-foreground tabular-nums">{fmtTime(best)}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">{t('lapSpread')}</p>
          <p className="text-xs font-mono text-foreground tabular-nums">+{spread.toFixed(3)}s</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">{t('idealLap')}</p>
          {idealTime != null ? (
            <>
              <p className="text-xs font-mono text-foreground tabular-nums">{fmtTime(idealTime)}</p>
              {idealDelta != null && Math.abs(idealDelta) > 0.01 && (
                <p className="text-[10px] font-mono text-amber-400 tabular-nums">-{Math.abs(idealDelta).toFixed(3)}s</p>
              )}
            </>
          ) : (
            <p className="text-xs font-mono text-muted-foreground/40">–</p>
          )}
        </div>
      </div>
    </div>
  )
}

export default function LapSidebar() {
  const t = useT()
  const { sessions, activeSessionId, setActiveSessionId, removeSession, loading, error, loadFiles } = useSessionStore()

  const fastestTime = sessions.flatMap(s => s.laps)
    .filter(l => l.is_valid && l.lap_time > 10)
    .reduce((min, l) => l.lap_time < min ? l.lap_time : min, Infinity)

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

  // Determine compatibility: a session is incompatible if track OR car differs
  // from any already-selected session. Compatible sessions can be added manually.
  const selectedSessionIds = new Set(selectedLapKeys.map(k => {
    const idx = k.lastIndexOf(':')
    return k.slice(0, idx)
  }))
  const selectedSessions = sessions.filter(s => selectedSessionIds.has(s.id))
  const refTrack = selectedSessions[0]?.track ?? null
  const refCar = selectedSessions[0]?.car ?? null
  const isSessionCompatible = (s: typeof sessions[0]) =>
    !refTrack || !refCar || (s.track === refTrack && s.car === refCar)

  return (
    <aside className="w-72 shrink-0 border-r border-border bg-card flex flex-col overflow-hidden">

      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-border shrink-0">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1">{t('sessions')}</p>
        {loading && <p className="text-xs text-muted-foreground">{t('loading')}</p>}
        {error && <p className="text-xs text-destructive truncate" title={error}>{t('errorLoadingFile')}</p>}
        {sessions.length === 0 && !loading && (
          <p className="text-xs text-muted-foreground/60">{t('noSessionLoaded')}</p>
        )}
      </div>

      {/* Sessions + laps */}
      <div className="flex-1 overflow-y-auto py-2">
        {sessions.map((session, si) => (
          <div key={session.id} className="group">
            <SessionCard
              session={session}
              active={activeSessionId === session.id}
              onActivate={() => setActiveSessionId(session.id)}
              onRemove={() => removeSession(session.id)}
            />
            <div className="mb-1">
              {session.laps.filter(lap => lap.is_valid).map(lap => {
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
                    fastestTime={fastestTime}
                    disabled={!isSelected && !isSessionCompatible(session)}
                  />
                )
              })}
            </div>
            {si < sessions.length - 1 && <div className="border-t border-border/50 mx-3 my-1" />}
          </div>
        ))}
      </div>

      {/* Consistency score */}
      <ConsistencyPanel />

      {/* Track map */}
      <div className="shrink-0 border-t border-border p-2" style={{ height: 280 }}>
        <TrackMap />
      </div>

      {/* Load button */}
      <div className="px-3 py-3 border-t border-border shrink-0">
        <button
          onClick={handleOpen}
          className="w-full text-xs text-muted-foreground hover:text-foreground border border-border hover:border-foreground/30 rounded-lg px-3 py-2 text-center transition-colors"
        >
          {t('loadFiles')}
        </button>
      </div>
    </aside>
  )
}
