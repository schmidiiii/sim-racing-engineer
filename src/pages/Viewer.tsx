import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useSessionStore } from '@/store/session'
import LapSidebar from '@/components/LapSidebar'
import TraceGroup from '@/components/TraceGroup'
import TrackMap from '@/components/TrackMap'
import AiPanel from '@/components/AiPanel'

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
        <div className="h-64 border-t border-border shrink-0">
          <TrackMap />
        </div>
      </div>

      <AiPanel />
    </div>
  )
}
