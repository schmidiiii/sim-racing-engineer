import { useEffect, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useSessionStore } from '@/store/session'
import LapSidebar from '@/components/LapSidebar'
import TraceGroup from '@/components/TraceGroup'
import AiPanel from '@/components/AiPanel'
import LapMap from '@/components/LapMap'

export default function Viewer() {
  const { loadLatest, loadFiles, autoLoad, lapMapFullscreen, setLapMapFullscreen } = useSessionStore()
  const autoLoadRef = useRef(autoLoad)
  useEffect(() => { autoLoadRef.current = autoLoad }, [autoLoad])

  useEffect(() => {
    if (!lapMapFullscreen) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setLapMapFullscreen(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [lapMapFullscreen])

  useEffect(() => {
    loadLatest()
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<string>('new-ibt-file', (event) => {
      if (autoLoadRef.current) loadFiles([event.payload])
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

      {/* Fullscreen Lap Analyse overlay */}
      {lapMapFullscreen && (
        <div className="fixed inset-0 z-50 bg-background flex flex-col">
          <div className="h-8 shrink-0 flex items-center bg-[#EAE7E8] dark:bg-[#181b21] select-none" data-tauri-drag-region>
            <span className="text-xs font-semibold text-foreground/70 px-4 flex-1" data-tauri-drag-region>Lap Analyse</span>
            {/* Back to app */}
            <button
              onClick={() => setLapMapFullscreen(false)}
              className="h-8 px-3 flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400 hover:bg-black/10 dark:hover:bg-zinc-800 hover:text-foreground transition-colors"
              title="Back (Esc)"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M6 2L3 5l3 3"/>
              </svg>
              Back
            </button>
            <div className="w-px h-4 bg-border mx-1" />
            {/* Window controls */}
            {'__TAURI_INTERNALS__' in window && (() => {
              const win = getCurrentWindow()
              return <>
                <button onClick={() => win.minimize()}
                  className="h-8 w-10 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:bg-black/10 dark:hover:bg-zinc-800 hover:text-foreground transition-colors text-sm"
                  aria-label="Minimize">─</button>
                <button onClick={() => win.toggleMaximize()}
                  className="h-8 w-10 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:bg-black/10 dark:hover:bg-zinc-800 hover:text-foreground transition-colors text-sm"
                  aria-label="Maximize">□</button>
                <button onClick={() => win.close()}
                  className="h-8 w-10 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:bg-red-500 hover:text-white transition-colors text-sm"
                  aria-label="Close">✕</button>
              </>
            })()}
          </div>
          <div className="flex-1 min-h-0 flex flex-col">
            <LapMap />
          </div>
        </div>
      )}
    </div>
  )
}
