import { getCurrentWindow } from '@tauri-apps/api/window'

export default function TitleBar() {
  if (!('__TAURI_INTERNALS__' in window)) return null

  const win = getCurrentWindow()

  return (
    <div
      data-tauri-drag-region
      className="h-8 shrink-0 flex items-center justify-end bg-card border-b border-border select-none"
    >
      {/* Min */}
      <button
        onClick={() => win.minimize()}
        className="h-8 w-10 flex items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors text-sm"
        aria-label="Minimieren"
      >
        ─
      </button>
      {/* Max */}
      <button
        onClick={() => win.toggleMaximize()}
        className="h-8 w-10 flex items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors text-sm"
        aria-label="Maximieren"
      >
        □
      </button>
      {/* Close */}
      <button
        onClick={() => win.close()}
        className="h-8 w-10 flex items-center justify-center text-muted-foreground hover:bg-red-500 hover:text-white transition-colors text-sm"
        aria-label="Schließen"
      >
        ✕
      </button>
    </div>
  )
}
