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
        <div className="flex gap-1 px-3 pt-2 pb-0 shrink-0 border-b border-border bg-background">
          {(['telemetry', 'setup'] as CenterView[]).map(v => (
            <button
              key={v}
              onClick={() => setCenterView(v)}
              className={`text-xs px-3 py-1.5 capitalize transition-colors border-b-2 -mb-px ${
                v === centerView
                  ? 'border-primary text-foreground'
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
