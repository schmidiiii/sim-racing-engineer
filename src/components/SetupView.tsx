import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSessionStore, parseLapKey, getLapColor } from '@/store/session'
import { useT } from '@/lib/i18n'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetupTree = Record<string, any>

function parseCarSetup(yaml: string): SetupTree {
  const lines = yaml.split('\n')
  const startIdx = lines.findIndex(l => l.startsWith('CarSetup:'))
  if (startIdx < 0) return {}
  const root: SetupTree = {}
  const stack: { indent: number; node: SetupTree }[] = [{ indent: -1, node: root }]
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed) continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) break
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack[stack.length - 1].node
    const colon = trimmed.indexOf(':')
    if (colon < 0) continue
    const key = trimmed.slice(0, colon)
    const value = trimmed.slice(colon + 1).trim()
    if (value) { parent[key] = value } else {
      const child: SetupTree = {}
      parent[key] = child
      stack.push({ indent, node: child })
    }
  }
  return root
}

function fmtKey(key: string): string {
  const k = key.startsWith('dc') ? key.slice(2) : key
  return k.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/^[a-z]/, c => c.toUpperCase())
}

function getVal(setup: SetupTree, path: string[]): string {
  let cur: string | SetupTree = setup
  for (const p of path) {
    if (typeof cur !== 'object') return '—'
    cur = (cur as SetupTree)[p] ?? '—'
  }
  return typeof cur === 'string' ? cur : '—'
}

type Param = { path: string[]; name: string }
type Subsection = { name: string; params: Param[] }
type Section = { name: string; subsections: Subsection[] }

function buildSections(setup: SetupTree): Section[] {
  const sections: Section[] = []
  for (const [secKey, secVal] of Object.entries(setup)) {
    if (secKey === 'UpdateCount' || typeof secVal === 'string') continue
    const section: Section = { name: secKey, subsections: [] }
    let loose: Param[] = []
    for (const [k2, v2] of Object.entries(secVal)) {
      if (typeof v2 === 'string') {
        loose.push({ path: [secKey, k2], name: k2 })
      } else {
        if (loose.length) { section.subsections.push({ name: '', params: loose }); loose = [] }
        const sub: Subsection = { name: k2, params: [] }
        for (const [k3, v3] of Object.entries(v2 as SetupTree)) {
          if (typeof v3 === 'string') sub.params.push({ path: [secKey, k2, k3], name: k3 })
        }
        section.subsections.push(sub)
      }
    }
    if (loose.length) section.subsections.push({ name: '', params: loose })
    sections.push(section)
  }
  return sections
}

type Col = { key: string; sessionId: string; lapNumber: number; colorIndex: number; setup: SetupTree }

export default function SetupView() {
  const t = useT()
  const { sessions, selectedLapKeys } = useSessionStore()
  const [yamlCache, setYamlCache] = useState<Record<string, string>>({})

  const sessionIds = [...new Set(selectedLapKeys.map(k => parseLapKey(k).sessionId))]

  useEffect(() => {
    const missing = sessionIds.filter(id => !yamlCache[id])
    for (const id of missing) {
      invoke<string>('get_session_yaml', { sessionId: id })
        .then(yaml => setYamlCache(p => ({ ...p, [id]: yaml })))
        .catch(() => {})
    }
  }, [selectedLapKeys.join(',')])

  if (!selectedLapKeys.length) {
    return <div className="flex-1 flex items-center justify-center"><p className="text-sm text-muted-foreground">{t('selectLapsCompare')}</p></div>
  }
  if (sessionIds.some(id => !yamlCache[id])) {
    return <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted-foreground">{t('loadingSetup')}</p></div>
  }

  const columns: Col[] = selectedLapKeys.map((key, i) => {
    const { sessionId, lapNumber } = parseLapKey(key)
    return { key, sessionId, lapNumber, colorIndex: i, setup: parseCarSetup(yamlCache[sessionId] ?? '') }
  })

  const sections = buildSections(columns[0]?.setup ?? {})
  if (!sections.length) {
    return <div className="flex-1 flex items-center justify-center"><p className="text-sm text-muted-foreground">{t('noSetupData')}</p></div>
  }

  const session0 = sessions.find(s => s.id === columns[0]?.sessionId)

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-background">

      {/* KPI row — identical to telemetry tabs */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-card rounded-xl border border-border shadow-sm p-3 min-w-0">
          <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide truncate">{t('track')}</p>
          <p className="font-bold text-base mt-0.5 leading-tight text-foreground truncate">{session0?.track ?? '–'}</p>
          <p className="text-muted-foreground text-[10px] mt-0.5">{session0?.date?.slice(0, 10)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border shadow-sm p-3 min-w-0">
          <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide truncate">{t('car')}</p>
          <p className="font-bold text-base mt-0.5 leading-tight text-foreground truncate">{session0?.car ?? '–'}</p>
        </div>
        <div className="bg-card rounded-xl border border-border shadow-sm p-3 min-w-0">
          <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide truncate">{t('lapsSelected')}</p>
          <p className="font-bold text-base mt-0.5 leading-tight text-foreground">{columns.length}</p>
          <div className="flex gap-2 mt-0.5">
            {columns.map(col => (
              <span key={col.key} className="text-[10px] font-semibold" style={{ color: getLapColor(col.colorIndex) }}>L{col.lapNumber}</span>
            ))}
          </div>
        </div>
      </div>

      {/* One card per setup section */}
      {sections.map(sec => (
        <div key={sec.name} className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
          {/* Card header — section name + lap labels */}
          <div className="flex items-center px-4 py-2.5 border-b border-border">
            <p className="flex-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {fmtKey(sec.name)}
            </p>
            {columns.map(col => (
              <span key={col.key} className="w-28 text-right text-[10px] font-bold" style={{ color: getLapColor(col.colorIndex) }}>
                L{col.lapNumber}
              </span>
            ))}
          </div>

          {/* Subsections + rows */}
          <div className="px-4 py-2">
            {sec.subsections.map((sub, si) => (
              <div key={si} className={si > 0 ? 'mt-3 pt-3 border-t border-border/40' : ''}>
                {sub.name && (
                  <p className="text-xs font-semibold text-foreground mb-1">{fmtKey(sub.name)}</p>
                )}
                {sub.params.map(param => {
                  const vals = columns.map(col => getVal(col.setup, param.path))
                  const allSame = vals.every(v => v === vals[0])
                  return (
                    <div key={param.name} className="flex items-center py-1 border-b border-border/20 last:border-0">
                      <span className="flex-1 text-xs text-muted-foreground">{fmtKey(param.name)}</span>
                      {vals.map((v, i) => (
                        <span
                          key={i}
                          className="w-28 text-right text-xs font-mono tabular-nums whitespace-nowrap"
                          style={{ color: allSame ? undefined : getLapColor(i) }}
                        >
                          {v}
                        </span>
                      ))}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
