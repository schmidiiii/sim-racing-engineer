import { getCurrentWindow } from '@tauri-apps/api/window'

export default function TitleBar() {
  if (!('__TAURI_INTERNALS__' in window)) return null

  const win = getCurrentWindow()

  return (
    <div
      data-tauri-drag-region
      className="h-8 shrink-0 flex items-center justify-end bg-[#1c1824] select-none"
    >
      <button
        onClick={() => win.minimize()}
        className="h-8 w-10 flex items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors text-sm"
        aria-label="Minimize"
      >
        ─
      </button>
      <button
        onClick={() => win.toggleMaximize()}
        className="h-8 w-10 flex items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors text-sm"
        aria-label="Maximize"
      >
        □
      </button>
      <button
        onClick={() => win.close()}
        className="h-8 w-10 flex items-center justify-center text-zinc-400 hover:bg-red-600 hover:text-white transition-colors text-sm"
        aria-label="Close"
      >
        ✕
      </button>
    </div>
  )
}
