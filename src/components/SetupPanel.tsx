import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, getLapColor, type Session } from '@/store/session'

type SetupTree = Record<string, Record<string, Record<string, string>>>

function parseCarSetup(yaml: string): SetupTree {
  const result: SetupTree = {}
  let inSetup = false
  let group = ''
  let subgroup = ''

  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()

    if (indent === 0) {
      inSetup = trimmed === 'CarSetup:'
      continue
    }
    if (!inSetup) continue

    if (indent === 1 && trimmed.endsWith(':') && !trimmed.includes(': ')) {
      group = trimmed.slice(0, -1)
      result[group] = {}
      subgroup = ''
    } else if (indent === 2 && trimmed.endsWith(':') && !trimmed.includes(': ')) {
      subgroup = trimmed.slice(0, -1)
      if (group) result[group][subgroup] = {}
    } else if (indent === 3 && group && subgroup) {
      const ci = trimmed.indexOf(': ')
      if (ci >= 0) result[group][subgroup][trimmed.slice(0, ci)] = trimmed.slice(ci + 2)
    }
  }
  return result
}

// CamelCase → "Camel Case"
function label(s: string) {
  return s.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim()
}

// Group header labels
const GROUP_LABELS: Record<string, string> = {
  TiresAero: 'TIRES & AERO',
  Chassis: 'CHASSIS',
}

// Subgroup display names
function subLabel(s: string) {
  const map: Record<string, string> = {
    TireType: 'Tire Type',
    LeftFront: 'Left Front',
    LeftRear: 'Left Rear',
    RightFront: 'Right Front',
    RightRear: 'Right Rear',
    AeroBalanceCalc: 'Aero Balance',
    FrontBrakesLights: 'Front / Brakes',
    Rear: 'Rear',
    InCarAdjustments: 'In-Car Adjustments',
  }
  return map[s] ?? label(s)
}

function SubgroupBlock({
  name,
  setups,
}: {
  name: string
  sessions?: Session[]
  setups: (SetupTree | null)[]
}) {
  // Collect all keys across all sessions for this subgroup
  const groupName = Object.keys(setups[0] ?? {}).find(g =>
    setups[0]?.[g]?.[name] != null
  ) ?? ''
  const allKeys = Array.from(
    new Set(setups.flatMap(st => Object.keys(st?.[groupName]?.[name] ?? {})))
  )
  if (allKeys.length === 0) return null

  return (
    <div>
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-1.5 mt-3">
        {subLabel(name)}
      </p>
      <div className="space-y-0">
        {allKeys.map(key => {
          const vals = setups.map(st => st?.[groupName]?.[name]?.[key] ?? '—')
          const allSame = vals.every(v => v === vals[0])
          return (
            <div key={key} className="flex items-center gap-2 py-0.5 border-b border-border/40 last:border-0">
              <span className="text-xs text-muted-foreground flex-1 min-w-0 truncate">{label(key)}</span>
              <div className="flex items-center gap-4 shrink-0">
                {vals.map((v, i) => (
                  <span
                    key={i}
                    className="text-xs font-mono tabular-nums"
                    style={{ color: allSame ? undefined : getLapColor(i) }}
                  >
                    {v}
                  </span>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function GroupCard({
  groupKey,
  sessions,
  setups,
}: {
  groupKey: string
  sessions: Session[]
  setups: (SetupTree | null)[]
}) {
  const subgroups = Array.from(
    new Set(setups.flatMap(st => Object.keys(st?.[groupKey] ?? {})))
  )
  if (subgroups.length === 0) return null

  return (
    <div className="bg-card rounded-xl border border-border shadow-sm p-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-bold text-foreground tracking-wide">
          {GROUP_LABELS[groupKey] ?? groupKey.toUpperCase()}
        </h3>
        {sessions.length > 1 && (
          <div className="flex items-center gap-3">
            {sessions.map((s, i) => (
              <span key={s.id} className="text-[10px] font-semibold" style={{ color: getLapColor(i) }}>
                {s.track.split(' ')[0]}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="divide-y divide-border/30">
        {subgroups.map(sub => (
          <SubgroupBlock key={sub} name={sub} sessions={sessions} setups={setups} />
        ))}
      </div>
    </div>
  )
}

export default function SetupPanel() {
  const { sessions, activeSessionId } = useSessionStore()
  const [setups, setSetups] = useState<(SetupTree | null)[]>([])
  const [loading, setLoading] = useState(false)

  const orderedSessions = [
    sessions.find(s => s.id === activeSessionId),
    ...sessions.filter(s => s.id !== activeSessionId),
  ].filter(Boolean) as Session[]

  useEffect(() => {
    if (orderedSessions.length === 0) { setSetups([]); return }
    setLoading(true)
    Promise.all(
      orderedSessions.map(s =>
        invoke<string>('get_session_yaml', { sessionId: s.id })
          .then(yaml => parseCarSetup(yaml))
          .catch(() => null)
      )
    ).then(results => { setSetups(results); setLoading(false) })
  }, [orderedSessions.map(s => s.id).join(',')])

  if (orderedSessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">No session loaded</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs text-muted-foreground">Loading setup…</p>
      </div>
    )
  }

  const groupKeys = Array.from(
    new Set(setups.flatMap(st => Object.keys(st ?? {})))
  ).filter(k => k !== 'UpdateCount')

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 bg-background">
      {groupKeys.map(gk => (
        <GroupCard key={gk} groupKey={gk} sessions={orderedSessions} setups={setups} />
      ))}
    </div>
  )
}
