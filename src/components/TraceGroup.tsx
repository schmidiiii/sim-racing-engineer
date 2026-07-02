import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, parseLapKey } from '@/store/session'
import { CHANNEL_GROUPS } from '@/lib/channelGroups'
import TraceChart, { LapTrace } from '@/components/TraceChart'

interface LapChannelData {
  lap_number: number
  channel: string
  samples: number[]
  timestamps: number[]
}

export default function TraceGroup() {
  const { sessions, selectedLapKeys, crosshairTime, setCrosshairTime } = useSessionStore()
  const [activeGroup, setActiveGroup] = useState(0)
  const [traces, setTraces] = useState<Record<string, LapTrace[]>>({})
  const [fetchError, setFetchError] = useState<string | null>(null)
  const loadedRef = useRef<string>('')

  const group = CHANNEL_GROUPS[activeGroup]

  useEffect(() => {
    if (sessions.length === 0 || selectedLapKeys.length === 0) return

    const key = `${selectedLapKeys.join(',')}-${activeGroup}`
    if (loadedRef.current === key) return
    loadedRef.current = key

    setFetchError(null)

    const fetchAll = async () => {
      const nextTraces: Record<string, LapTrace[]> = {}

      // Group selected lap keys by session
      const bySession: Record<string, number[]> = {}
      selectedLapKeys.forEach((k) => {
        const { sessionId, lapNumber } = parseLapKey(k)
        if (!bySession[sessionId]) bySession[sessionId] = []
        bySession[sessionId].push(lapNumber)
      })

      for (const channel of group.channels) {
        nextTraces[channel] = []

        for (const [sessionId, lapNumbers] of Object.entries(bySession)) {
          const session = sessions.find(s => s.id === sessionId)
          if (!session) continue
          const available = new Set(session.available_channels.map(c => c.name))
          if (!available.has(channel)) continue

          try {
            const results = await invoke<LapChannelData[]>('get_lap_channel_data', {
              sessionId,
              lapNumbers,
              channel,
            })
            for (const data of results) {
              const k = `${sessionId}:${data.lap_number}`
              const colorIdx = selectedLapKeys.indexOf(k)
              nextTraces[channel].push({
                lapNumber: data.lap_number,
                colorIndex: colorIdx >= 0 ? colorIdx : nextTraces[channel].length,
                samples: data.samples,
                timestamps: data.timestamps,
              })
            }
          } catch (e) {
            setFetchError(`${channel}: ${String(e)}`)
          }
        }
      }

      setTraces(nextTraces)
    }

    fetchAll()
  }, [sessions, selectedLapKeys, activeGroup])

  if (sessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">No session loaded</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-end gap-0.5 px-4 pt-2 shrink-0 border-b border-border bg-card">
        {CHANNEL_GROUPS.map((g, i) => (
          <button
            key={g.label}
            onClick={() => setActiveGroup(i)}
            className={`px-3 py-2 text-xs font-semibold border-b-2 -mb-px transition-colors ${
              i === activeGroup
                ? 'border-racing-amber text-racing-amber'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {g.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 bg-background">
        {fetchError && (
          <p className="text-xs text-destructive px-1 py-1">{fetchError}</p>
        )}
        {group.channels.map(channel => (
          <TraceChart
            key={channel}
            channel={channel}
            traces={traces[channel] ?? []}
            crosshairTime={crosshairTime}
            onMouseMove={setCrosshairTime}
            height={120}
          />
        ))}
      </div>
    </div>
  )
}
