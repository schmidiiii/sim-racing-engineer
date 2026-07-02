import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useSessionStore } from '@/store/session'
import LapSidebar from '@/components/LapSidebar'
import TraceGroup from '@/components/TraceGroup'

export default function Viewer() {
  const { loadLatest, loadFile } = useSessionStore()

  useEffect(() => {
    loadLatest()
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<string>('new-ibt-file', (event) => {
      loadFile(event.payload)
    }).then(fn => { unlisten = fn })
    return () => { unlisten?.() }
  }, [])

  return (
    <div className="flex h-full gap-0">
      <LapSidebar />

      {/* Center: Telemetry + Track Map */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-hidden">
          <TraceGroup />
        </div>
        <div className="h-64 border-t border-border p-3 shrink-0">
          <p className="text-xs text-muted-foreground">Track map</p>
        </div>
      </div>

      {/* Right: AI Panel */}
      <aside className="w-72 shrink-0 border-l border-border p-3 flex flex-col overflow-hidden">
        <p className="text-xs text-muted-foreground font-medium mb-2 uppercase tracking-wider">AI Coach</p>
        <div className="flex-1 overflow-y-auto">
          <p className="text-xs text-muted-foreground">Analysis will appear here…</p>
        </div>
      </aside>
    </div>
  )
}
