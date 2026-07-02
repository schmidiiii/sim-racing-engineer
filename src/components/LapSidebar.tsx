import { open } from '@tauri-apps/plugin-dialog'
import { useSessionStore, getLapColor, lapKey } from '@/store/session'

function LapRow({ sessionId, lapNumber, lapTime, isValid, colorIndex, fastestTime }: {
  sessionId: string
  lapNumber: number
  lapTime: number
  isValid: boolean
  colorIndex: number
  fastestTime: number
}) {
  const { selectedLapKeys, toggleLap } = useSessionStore()
  const key = lapKey(sessionId, lapNumber)
  const selected = selectedLapKeys.includes(key)
  const color = getLapColor(colorIndex)

  const mins = Math.floor(lapTime / 60)
  const secs = (lapTime % 60).toFixed(3).padStart(6, '0')
  const timeStr = lapTime > 10 ? `${mins}:${secs}` : '–'

  return (
    <label className="flex items-center gap-2 py-1 px-3 hover:bg-secondary/60 cursor-pointer select-none transition-colors">
      <span
        className="w-2.5 h-2.5 rounded-sm shrink-0 border transition-colors"
        style={{
          backgroundColor: selected ? color : 'transparent',
          borderColor: selected ? color : 'hsl(var(--border))',
        }}
        onClick={() => toggleLap(sessionId, lapNumber)}
      />
      <input type="checkbox" className="sr-only" checked={selected} onChange={() => toggleLap(sessionId, lapNumber)} />
      <span className="text-xs font-mono text-muted-foreground flex-1">L{lapNumber}</span>
      <span className={`text-xs font-mono tabular-nums ${isValid ? 'text-foreground' : 'text-muted-foreground/50'}`}>
        {timeStr}
      </span>
      {isValid && lapTime > 10 && lapTime === fastestTime && (
        <span className="text-[10px] text-racing-green">★</span>
      )}
      {isValid && lapTime > 10 && fastestTime < Infinity && lapTime !== fastestTime && (
        <span className="text-[10px] text-racing-red font-mono tabular-nums">
          +{(lapTime - fastestTime).toFixed(2)}
        </span>
      )}
    </label>
  )
}

export default function LapSidebar() {
  const { sessions, selectedLapKeys, loading, error, loadFiles } = useSessionStore()

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

  // Build a global color assignment map: key → colorIndex (order of selection)
  const keyColorIndex: Record<string, number> = {}
  selectedLapKeys.forEach((k, i) => { keyColorIndex[k] = i })

  return (
    <aside className="w-52 shrink-0 border-r border-border bg-card flex flex-col overflow-hidden">
      <div className="px-4 pt-4 pb-3 border-b border-border shrink-0">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2">Sessions</p>
        {loading && <p className="text-xs text-muted-foreground">Loading…</p>}
        {error && <p className="text-xs text-destructive truncate" title={error}>Error</p>}
        {sessions.length === 0 && !loading && (
          <p className="text-xs text-muted-foreground">No session loaded</p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {sessions.map((session, si) => (
          <div key={session.id} className="mb-2">
            {/* Session header */}
            <div className="px-4 pt-3 pb-1">
              <p className="text-xs font-semibold text-foreground truncate leading-tight">{session.track}</p>
              <p className="text-xs text-muted-foreground truncate">{session.car}</p>
              <p className="text-[10px] text-muted-foreground/70">{session.date.slice(0, 10)}</p>
            </div>
            {/* Laps */}
            <div>
              {session.laps.map(lap => {
                const k = lapKey(session.id, lap.lap_number)
                const ci = keyColorIndex[k] ?? -1
                return (
                  <LapRow
                    key={k}
                    sessionId={session.id}
                    lapNumber={lap.lap_number}
                    lapTime={lap.lap_time}
                    isValid={lap.is_valid}
                    colorIndex={ci >= 0 ? ci : selectedLapKeys.length}
                    fastestTime={fastestTime}
                  />
                )
              })}
            </div>
            {si < sessions.length - 1 && <div className="border-t border-border mt-2" />}
          </div>
        ))}
      </div>

      <div className="px-4 py-3 border-t border-border shrink-0">
        <button
          onClick={handleOpen}
          className="w-full text-xs text-muted-foreground hover:text-foreground border border-border hover:border-foreground/30 rounded-lg px-3 py-2 text-center transition-colors"
        >
          + Load file(s)…
        </button>
      </div>
    </aside>
  )
}
