import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useSessionStore } from '@/store/session'
import LapSidebar from '@/components/LapSidebar'
import TraceGroup from '@/components/TraceGroup'
import AiPanel from '@/components/AiPanel'

export default function Viewer() {
  const { loadLatest, loadFiles } = useSessionStore()

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
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <TraceGroup />
      </div>

      <AiPanel />
    </div>
  )
}
