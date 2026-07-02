import { open } from '@tauri-apps/plugin-dialog'
import { useSessionStore, getLapColor, lapKey } from '@/store/session'

function LapRow({ sessionId, lapNumber, lapTime, isValid, colorIndex }: {
  sessionId: string
  lapNumber: number
  lapTime: number
  isValid: boolean
  colorIndex: number
}) {
  const { selectedLapKeys, toggleLap } = useSessionStore()
  const key = lapKey(sessionId, lapNumber)
  const selected = selectedLapKeys.includes(key)
  const color = getLapColor(colorIndex)

  const mins = Math.floor(lapTime / 60)
  const secs = (lapTime % 60).toFixed(3).padStart(6, '0')
  const timeStr = lapTime > 10 ? `${mins}:${secs}` : '–'

  return (
    <label className="flex items-center gap-2 py-0.5 px-1 rounded hover:bg-secondary/40 cursor-pointer select-none">
      <span
        className="w-3 h-3 rounded-sm shrink-0 border"
        style={{
          backgroundColor: selected ? color : 'transparent',
          borderColor: selected ? color : '#4b5563',
        }}
        onClick={() => toggleLap(sessionId, lapNumber)}
      />
      <input type="checkbox" className="sr-only" checked={selected} onChange={() => toggleLap(sessionId, lapNumber)} />
      <span className="text-xs font-mono flex-1">L{lapNumber}</span>
      <span className={`text-xs font-mono ${isValid ? 'text-foreground' : 'text-muted-foreground'}`}>
        {timeStr}
      </span>
    </label>
  )
}

export default function LapSidebar() {
  const { sessions, selectedLapKeys, loading, error, loadFiles } = useSessionStore()

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
    <aside className="w-48 shrink-0 border-r border-border flex flex-col overflow-hidden">
      <div className="px-3 pt-3 pb-2 border-b border-border shrink-0">
        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-1">Laps</p>
        {loading && <p className="text-xs text-muted-foreground">Loading…</p>}
        {error && <p className="text-xs text-destructive truncate" title={error}>Error loading</p>}
        {sessions.length === 0 && !loading && (
          <p className="text-xs text-muted-foreground">No session loaded</p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {sessions.map((session, si) => (
          <div key={session.id} className="mb-2">
            {/* Session header */}
            <div className="px-3 py-1">
              <p className="text-xs font-medium truncate leading-tight" title={session.track}>
                {session.track}
              </p>
              <p className="text-xs text-muted-foreground truncate" title={session.car}>
                {session.car}
              </p>
              <p className="text-xs text-muted-foreground">{session.date.slice(0, 10)}</p>
            </div>
            {/* Laps */}
            <div className="px-2">
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
                  />
                )
              })}
            </div>
            {si < sessions.length - 1 && <div className="border-t border-border mt-2" />}
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-border shrink-0">
        <button
          onClick={handleOpen}
          className="w-full text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/40 rounded px-2 py-1.5 text-center transition-colors"
        >
          + Load file(s)…
        </button>
      </div>
    </aside>
  )
}
