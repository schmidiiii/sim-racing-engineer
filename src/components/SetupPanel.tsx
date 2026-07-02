import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore } from '@/store/session'

// Parse iRacing YAML into a tree: section → subsection → key: value
type YamlTree = Record<string, Record<string, Record<string, string>>>

function parseIracingYaml(yaml: string): YamlTree {
  const tree: YamlTree = {}
  let section = 'General'
  let subsection = ''

  for (const raw of yaml.split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim() || line.trim().startsWith('#')) continue

    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()

    // Top-level section (indent 0, ends with colon, no value after colon)
    if (indent === 0 && trimmed.endsWith(':') && !trimmed.includes(': ')) {
      section = trimmed.slice(0, -1)
      subsection = ''
      if (!tree[section]) tree[section] = {}
      continue
    }

    // Subsection (indent 1 space, ends with colon)
    if (indent === 1 && trimmed.endsWith(':') && !trimmed.includes(': ')) {
      subsection = trimmed.slice(0, -1)
      if (!tree[section]) tree[section] = {}
      if (!tree[section][subsection]) tree[section][subsection] = {}
      continue
    }

    // Key-value pair
    const colonIdx = trimmed.indexOf(': ')
    if (colonIdx < 0) continue
    const key = trimmed.slice(0, colonIdx).trim()
    const value = trimmed.slice(colonIdx + 2).trim()

    if (!tree[section]) tree[section] = {}
    const sub = subsection || '_root'
    if (!tree[section][sub]) tree[section][sub] = {}
    tree[section][sub][key] = value
  }

  return tree
}

// Sections to show and their display names
const VISIBLE_SECTIONS: { key: string; label: string }[] = [
  { key: 'WeekendInfo', label: 'Weekend / Track' },
  { key: 'SessionInfo', label: 'Session' },
  { key: 'CarSetup', label: 'Car Setup' },
  { key: 'DriverInfo', label: 'Driver' },
]

// Keys to hide (noisy/internal)
const HIDDEN_KEYS = new Set([
  'ResultsFastestLap', 'ResultsAverageLapTime', 'ResultsNumCautionFlags',
  'ResultsNumCautionLaps', 'ResultsNumLeadChanges', 'ResultsLapsComplete',
  'ResultsOfficial', 'SessionLapsRemain', 'SessionTimeRemain',
  'SessionNum', 'SessionType', 'SessionTrackRubberState',
  'PaceCarIdx', 'RadioTransmitCarIdx', 'RadioTransmitRadioIdx',
  'RadioTransmitFrequencyIdx', 'SeriesID', 'SeasonID', 'SessionID',
  'SubSessionID', 'LeagueID', 'QualifyScoring',
])

function SectionBlock({ title, data }: { title: string; data: Record<string, Record<string, string>> }) {
  const [open, setOpen] = useState(true)
  const entries = Object.entries(data)
    .filter(([sub]) => sub !== '_root' || Object.keys(data['_root'] ?? {}).length > 0)

  const rootEntries = Object.entries(data['_root'] ?? {})
    .filter(([k]) => !HIDDEN_KEYS.has(k))

  const subEntries = entries.filter(([sub]) => sub !== '_root')

  if (rootEntries.length === 0 && subEntries.length === 0) return null

  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 w-full text-left mb-1.5"
      >
        <span className="text-xs font-semibold text-foreground/80 uppercase tracking-wider">{title}</span>
        <span className="text-xs text-muted-foreground">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="space-y-3">
          {/* Root-level key-values */}
          {rootEntries.length > 0 && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
              {rootEntries.map(([k, v]) => (
                <div key={k} className="contents">
                  <span className="text-xs text-muted-foreground truncate">{k}</span>
                  <span className="text-xs text-foreground truncate" title={v}>{v || '—'}</span>
                </div>
              ))}
            </div>
          )}

          {/* Subsections */}
          {subEntries.map(([sub, kvs]) => {
            const filtered = Object.entries(kvs).filter(([k]) => !HIDDEN_KEYS.has(k))
            if (filtered.length === 0) return null
            return (
              <div key={sub} className="pl-2 border-l border-border">
                <p className="text-xs text-muted-foreground/70 mb-1 font-medium">{sub}</p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                  {filtered.map(([k, v]) => (
                    <div key={k} className="contents">
                      <span className="text-xs text-muted-foreground truncate">{k}</span>
                      <span className="text-xs text-foreground truncate" title={v}>{v || '—'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function SetupPanel() {
  const { sessions } = useSessionStore()
  const session = sessions[0]
  const [yaml, setYaml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!session) return
    setYaml(null)
    setError(null)
    invoke<string>('get_session_yaml', { sessionId: session.id })
      .then(setYaml)
      .catch(e => setError(String(e)))
  }, [session?.id])

  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">No session loaded</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-4">
        <p className="text-xs text-destructive">{error}</p>
      </div>
    )
  }

  if (!yaml) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs text-muted-foreground">Loading setup data…</p>
      </div>
    )
  }

  const tree = parseIracingYaml(yaml)

  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      {VISIBLE_SECTIONS.map(({ key, label }) => {
        const data = tree[key]
        if (!data) return null
        return <SectionBlock key={key} title={label} data={data} />
      })}
    </div>
  )
}
