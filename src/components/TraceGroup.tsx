import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore } from '@/store/session'
import { CHANNEL_GROUPS } from '@/lib/channelGroups'
import TraceChart, { LapTrace } from '@/components/TraceChart'

interface LapChannelData {
  lap_number: number
  channel: string
  samples: number[]
  timestamps: number[]
}

export default function TraceGroup() {
  const { session, selectedLaps } = useSessionStore()
  const [activeGroup, setActiveGroup] = useState(0)
  const [traces, setTraces] = useState<Record<string, LapTrace[]>>({})
  const [crosshairTime, setCrosshairTime] = useState<number | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const loadedRef = useRef<string>('')

  const group = CHANNEL_GROUPS[activeGroup]

  useEffect(() => {
    if (!session || selectedLaps.length === 0) return

    const key = `${session.id}-${selectedLaps.join(',')}-${activeGroup}`
    if (loadedRef.current === key) return
    loadedRef.current = key

    setFetchError(null)
    const availableChannels = new Set(session.available_channels.map(c => c.name))

    const fetchAll = async () => {
      const nextTraces: Record<string, LapTrace[]> = {}

      for (const channel of group.channels) {
        if (!availableChannels.has(channel)) continue
        nextTraces[channel] = []

        try {
          // Rust command takes all lap numbers at once and returns Vec<LapChannelData>
          const results = await invoke<LapChannelData[]>('get_lap_channel_data', {
            sessionId: session.id,
            lapNumbers: selectedLaps,
            channel,
          })
          for (const data of results) {
            nextTraces[channel].push({
              lapNumber: data.lap_number,
              samples: data.samples,
              timestamps: data.timestamps,
            })
          }
        } catch (e) {
          setFetchError(`${channel}: ${String(e)}`)
        }
      }

      setTraces(nextTraces)
    }

    fetchAll()
  }, [session?.id, selectedLaps, activeGroup])

  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">No session loaded</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab bar */}
      <div className="flex gap-1 px-3 pt-2 shrink-0 border-b border-border">
        {CHANNEL_GROUPS.map((g, i) => (
          <button
            key={g.label}
            onClick={() => setActiveGroup(i)}
            className={`text-xs px-3 py-1.5 rounded-t transition-colors ${
              i === activeGroup
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {g.label}
          </button>
        ))}
      </div>

      {/* Charts */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
        {fetchError && (
          <p className="text-xs text-destructive px-3 py-1">{fetchError}</p>
        )}
        {group.channels.map(channel => {
          const channelTraces = traces[channel] ?? []
          return (
            <TraceChart
              key={channel}
              channel={channel}
              traces={channelTraces}
              crosshairTime={crosshairTime}
              onMouseMove={setCrosshairTime}
              height={120}
            />
          )
        })}
      </div>
    </div>
  )
}
