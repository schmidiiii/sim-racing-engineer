import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useSessionStore } from '@/store/session'
import LapSidebar from '@/components/LapSidebar'
import TraceGroup from '@/components/TraceGroup'
import TrackMap from '@/components/TrackMap'
import AiPanel from '@/components/AiPanel'
import SetupPanel from '@/components/SetupPanel'

type CenterView = 'telemetry' | 'setup'

export default function Viewer() {
  const { loadLatest, loadFiles } = useSessionStore()
  const [centerView, setCenterView] = useState<CenterView>('telemetry')

  useEffect(() => {
    loadLatest()
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<string>('new-ibt-file', (event) => {
      loadFiles([event.payload])
    }).then(fn => { unlisten = fn })
    return () => { unlisten?.() }
  }, [])

  return (
    <div className="flex h-full gap-0">
      <LapSidebar />

      {/* Center column */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* View switcher */}
        <div className="flex items-end gap-0.5 px-4 pt-2 shrink-0 border-b border-border bg-card">
          {(['telemetry', 'setup'] as CenterView[]).map(v => (
            <button
              key={v}
              onClick={() => setCenterView(v)}
              className={`px-4 py-2 text-xs font-semibold border-b-2 -mb-px transition-colors ${
                v === centerView
                  ? 'border-racing-amber text-racing-amber'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {v === 'telemetry' ? 'Telemetry' : 'Setup / Info'}
            </button>
          ))}
        </div>

        {centerView === 'telemetry' ? (
          <>
            <div className="flex-1 overflow-hidden">
              <TraceGroup />
            </div>
            <div className="h-64 border-t border-border shrink-0">
              <TrackMap />
            </div>
          </>
        ) : (
          <SetupPanel />
        )}
      </div>

      <AiPanel />
    </div>
  )
}
