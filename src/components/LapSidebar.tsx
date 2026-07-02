import { open } from '@tauri-apps/plugin-dialog'
import { useSessionStore, useLapColor } from '@/store/session'

function LapRow({ lapNumber, lapTime, isValid }: {
  lapNumber: number
  lapTime: number
  isValid: boolean
}) {
  const { selectedLaps, toggleLap } = useSessionStore()
  const color = useLapColor(lapNumber)
  const selected = selectedLaps.includes(lapNumber)

  const mins = Math.floor(lapTime / 60)
  const secs = (lapTime % 60).toFixed(3).padStart(6, '0')
  const timeStr = lapTime > 10 ? `${mins}:${secs}` : '–'

  return (
    <label className="flex items-center gap-2 py-1 px-1 rounded hover:bg-secondary/40 cursor-pointer select-none">
      <span
        className="w-3 h-3 rounded-sm shrink-0 border"
        style={{
          backgroundColor: selected ? color : 'transparent',
          borderColor: color,
        }}
        onClick={() => toggleLap(lapNumber)}
      />
      <input
        type="checkbox"
        className="sr-only"
        checked={selected}
        onChange={() => toggleLap(lapNumber)}
      />
      <span className="text-xs font-mono flex-1">
        L{lapNumber}
      </span>
      <span className={`text-xs font-mono ${isValid ? 'text-foreground' : 'text-muted-foreground'}`}>
        {timeStr}
      </span>
    </label>
  )
}

export default function LapSidebar() {
  const { session, loading, error, loadFile } = useSessionStore()

  const handleOpen = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'iRacing Telemetry', extensions: ['ibt'] }],
    })
    if (typeof selected === 'string') {
      await loadFile(selected)
    }
  }

  return (
    <aside className="w-48 shrink-0 border-r border-border flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-3 pt-3 pb-2 border-b border-border shrink-0">
        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-2">Laps</p>
        {session && (
          <div className="space-y-0.5">
            <p className="text-xs font-medium truncate" title={session.track}>{session.track}</p>
            <p className="text-xs text-muted-foreground truncate" title={session.car}>{session.car}</p>
            <p className="text-xs text-muted-foreground">{session.date}</p>
          </div>
        )}
        {loading && <p className="text-xs text-muted-foreground">Loading…</p>}
        {error && <p className="text-xs text-destructive truncate" title={error}>Error loading</p>}
      </div>

      {/* Lap list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {session?.laps.map(lap => (
          <LapRow
            key={lap.lap_number}
            lapNumber={lap.lap_number}
            lapTime={lap.lap_time}
            isValid={lap.is_valid}
          />
        ))}
      </div>

      {/* Footer: file picker */}
      <div className="px-3 py-2 border-t border-border shrink-0">
        <button
          onClick={handleOpen}
          className="w-full text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/40 rounded px-2 py-1.5 text-center transition-colors"
        >
          + Load file…
        </button>
      </div>
    </aside>
  )
}
