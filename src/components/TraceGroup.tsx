import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, parseLapKey } from '@/store/session'
import { CHANNEL_GROUPS } from '@/lib/channelGroups'
import TraceChart, { LapTrace } from '@/components/TraceChart'
import SetupView from '@/components/SetupView'
import DeltaView from '@/components/DeltaView'
import BrakeAnalysis from '@/components/BrakeAnalysis'
import CornerSpeed from '@/components/CornerSpeed'
import LapMap from '@/components/LapMap'
import { useT, translateChannelLabel } from '@/lib/i18n'

interface LapChannelData {
  lap_number: number
  channel: string
  samples: number[]
  timestamps: number[]
  lap_dist_pct: number[]
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm p-3 min-w-0">
      <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide truncate">{label}</p>
      <p className="font-bold text-base mt-0.5 leading-tight text-foreground truncate" title={value}>{value}</p>
      {sub && <p className="text-muted-foreground text-[10px] mt-0.5 truncate">{sub}</p>}
    </div>
  )
}

export default function TraceGroup() {
  const t = useT()
  const { sessions, selectedLapKeys, crosshairTime, setCrosshairTime, activeSessionId, setActiveTabLabel } = useSessionStore()
  const [activeGroup, setActiveGroup] = useState(0)
  const [traces, setTraces] = useState<Record<string, LapTrace[]>>({})
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [isFetching, setIsFetching] = useState(false)
  const zoomRef = useRef<[number, number] | null>(null)
  const redrawsRef = useRef(new Set<() => void>())
  // Cache: `${sessionId}:${lapNumber}:${channel}` → already-transformed samples+timestamps+lapDistPct
  const lapCache = useRef<Record<string, { samples: number[], timestamps: number[], lapDistPct: number[] }>>({})
  const prevGroupRef = useRef<number>(-1)
  const fetchIdRef = useRef(0)

  const handleZoom = useCallback((domain: [number, number] | null) => {
    zoomRef.current = domain
    redrawsRef.current.forEach(fn => fn())
  }, [])

  const registerRedraw = useCallback((fn: () => void) => {
    redrawsRef.current.add(fn)
    return () => { redrawsRef.current.delete(fn) }
  }, [])

  const group = CHANNEL_GROUPS[activeGroup]

  useEffect(() => {
    if (sessions.length === 0 || selectedLapKeys.length === 0) {
      setTraces({})
      return
    }

    // Clear cache when switching groups (different transforms may apply)
    if (prevGroupRef.current !== activeGroup) {
      lapCache.current = {}
      prevGroupRef.current = activeGroup
    }

    setFetchError(null)

    const bySession: Record<string, number[]> = {}
    selectedLapKeys.forEach((k) => {
      const { sessionId, lapNumber } = parseLapKey(k)
      if (!bySession[sessionId]) bySession[sessionId] = []
      bySession[sessionId].push(lapNumber)
    })

    const fetchId = ++fetchIdRef.current
    setIsFetching(true)

    const fetchAll = async () => {
      const nextTraces: Record<string, LapTrace[]> = {}

      for (const channel of group.channels) {
        nextTraces[channel] = []

        for (const [sessionId, lapNumbers] of Object.entries(bySession)) {
          const session = sessions.find(s => s.id === sessionId)
          if (!session) continue
          const available = new Set(session.available_channels.map(c => c.name))
          if (!available.has(channel)) continue

          const transform = group.transforms[channel]

          // Only fetch laps not already in cache
          const toFetch = lapNumbers.filter(
            lapNum => !lapCache.current[`${sessionId}:${lapNum}:${channel}`]
          )
          if (toFetch.length > 0) {
            try {
              const results = await invoke<LapChannelData[]>('get_lap_channel_data', {
                sessionId, lapNumbers: toFetch, channel,
              })
              if (fetchId !== fetchIdRef.current) return
              for (const data of results) {
                lapCache.current[`${sessionId}:${data.lap_number}:${channel}`] = {
                  samples: transform ? data.samples.map(transform) : data.samples,
                  timestamps: data.timestamps,
                  lapDistPct: data.lap_dist_pct,
                }
              }
            } catch (e) {
              if (fetchId !== fetchIdRef.current) return
              setFetchError(`${channel}: ${String(e)}`)
            }
          }

          // Build traces from cache for all selected laps
          for (const lapNum of lapNumbers) {
            const cached = lapCache.current[`${sessionId}:${lapNum}:${channel}`]
            if (!cached) continue
            const k = `${sessionId}:${lapNum}`
            const colorIdx = selectedLapKeys.indexOf(k)
            nextTraces[channel].push({
              lapNumber: lapNum,
              colorIndex: colorIdx >= 0 ? colorIdx : nextTraces[channel].length,
              samples: cached.samples,
              timestamps: cached.timestamps,
              lapDistPct: cached.lapDistPct,
            })
          }
        }
      }

      if (fetchId !== fetchIdRef.current) return
      setTraces(nextTraces)
      setIsFetching(false)
    }

    fetchAll()
  }, [sessions, selectedLapKeys, activeGroup])

  if (sessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('noSessionLoaded')}</p>
      </div>
    )
  }

  // KPI values — follow activeSessionId
  const session = sessions.find(s => s.id === activeSessionId) ?? sessions[0]
  const selectedLaps = session?.laps.filter(l =>
    selectedLapKeys.some(k => k.endsWith(`:${l.lap_number}`))
  ) ?? []
  const validTimes = selectedLaps.filter(l => l.is_valid && l.lap_time > 10).map(l => l.lap_time)
  const fastest = validTimes.length > 0 ? Math.min(...validTimes) : null
  const fastestStr = fastest != null
    ? `${Math.floor(fastest / 60)}:${(fastest % 60).toFixed(3).padStart(6, '0')}`
    : '–'

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Channel group tab bar */}
      <div className="flex items-end gap-0.5 px-5 pt-2 shrink-0 border-b border-border bg-card overflow-x-auto">
        {CHANNEL_GROUPS.map((g, i) => (
          <button
            key={g.label}
            onClick={() => {
              setActiveGroup(i)
              setActiveTabLabel(g.label)
              zoomRef.current = null
              redrawsRef.current.forEach(fn => fn())
            }}
            className={`px-3 py-2 text-xs font-semibold border-b-2 -mb-px transition-colors whitespace-nowrap shrink-0 ${
              i === activeGroup
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {translateChannelLabel(g.label, t)}
          </button>
        ))}
      </div>

      {group.viewType === 'setup' && <SetupView />}
      {group.viewType === 'delta' && <DeltaView />}
      {group.viewType === 'braking' && <BrakeAnalysis />}
      {group.viewType === 'lapMap' && <LapMap />}
      {group.viewType === 'cornerSpeed' && <CornerSpeed />}

      {!group.viewType && <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-background">

        {/* KPI row */}
        {selectedLapKeys.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            <StatCard
              label={t('fastestSelected')}
              value={fastestStr}
              sub={`${selectedLapKeys.length} ${t('lapsSelected').toLowerCase()}`}
            />
            <StatCard
              label={t('track')}
              value={session?.track ?? '–'}
              sub={session?.date?.slice(0, 10)}
            />
            <StatCard
              label={t('car')}
              value={session?.car ?? '–'}
              sub={`${session?.laps.length ?? 0} ${t('lapsTotal')}`}
            />
          </div>
        )}

        {/* Error */}
        {fetchError && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3">
            <p className="text-xs text-destructive">{fetchError}</p>
          </div>
        )}

        {/* No laps selected hint */}
        {selectedLapKeys.length === 0 && (
          <div className="bg-card rounded-xl border border-border shadow-sm px-4 py-8 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">{t('selectLapsCompare')}</p>
          </div>
        )}

        {/* Loading state */}
        {isFetching && (
          <div className="bg-card rounded-xl border border-border shadow-sm px-4 py-8 flex items-center justify-center gap-2">
            <div className="h-3 w-3 rounded-full bg-primary animate-bounce [animation-delay:-0.2s]" />
            <div className="h-3 w-3 rounded-full bg-primary animate-bounce [animation-delay:-0.1s]" />
            <div className="h-3 w-3 rounded-full bg-primary animate-bounce" />
          </div>
        )}

        {/* Chart cards — only render channels that have data */}
        {!isFetching && selectedLapKeys.length > 0 && (() => {
          const withData = group.channels.filter(ch => (traces[ch]?.length ?? 0) > 0)
          const fetched = group.channels.some(ch => traces[ch] !== undefined)
          if (fetched && withData.length === 0) {
            return (
              <div className="bg-card rounded-xl border border-border shadow-sm px-4 py-8 flex items-center justify-center">
                <p className="text-sm text-muted-foreground">{t('noDataSession').replace('%label%', translateChannelLabel(group.label, t))}</p>
              </div>
            )
          }
          return withData.map(channel => (
            <TraceChart
              key={channel}
              channel={channel}
              unit={group.units[channel]}
              yDomain={group.yDomains[channel]}
              traces={traces[channel] ?? []}
              crosshairTime={crosshairTime}
              onMouseMove={setCrosshairTime}
              zoomRef={zoomRef}
              onZoom={handleZoom}
              registerRedraw={registerRedraw}
              height={130}
            />
          ))
        })()}

      </div>}
    </div>
  )
}
