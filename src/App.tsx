import { useState, useEffect } from 'react'
import Viewer from '@/pages/Viewer'
import Settings from '@/pages/Settings'
import UpdateBanner from '@/components/UpdateBanner'
import { useT } from '@/lib/i18n'

export default function App() {
  const t = useT()
  const [dark, setDark] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [version, setVersion] = useState('')

  useEffect(() => {
    if ('__TAURI_INTERNALS__' in window) {
      import('@tauri-apps/api/app').then(({ getVersion }) => getVersion().then(setVersion))
    }
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  // Close on Escape
  useEffect(() => {
    if (!settingsOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSettingsOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen])

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      <header className="shrink-0 border-b border-border bg-card">
        <div className="px-5 py-2.5 flex items-center gap-4">
          <div className="flex items-center gap-3">
            <img src="/LogoSRE.png" alt="logo" className="h-11 w-11 object-contain" />
            <div>
              <div className="font-bold text-lg text-foreground tracking-tight leading-tight">Sim Racing Engineer</div>
              {version && <div className="text-xs text-muted-foreground leading-tight">v{version}</div>}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setSettingsOpen(true)}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('settings')}
            </button>
            <button
              onClick={() => setDark(d => !d)}
              className="text-xs text-muted-foreground hover:text-foreground border border-border rounded-lg px-3 py-1.5 transition-colors"
              title={t('toggleTheme')}
            >
              {dark ? `☀ ${t('light')}` : `☾ ${t('dark')}`}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        <Viewer />
      </main>

      <UpdateBanner />

      {/* Settings modal */}
      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setSettingsOpen(false) }}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

          {/* Panel */}
          <div className="relative z-10 bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
              <h2 className="text-sm font-semibold text-foreground">{t('settings')}</h2>
              <button
                onClick={() => setSettingsOpen(false)}
                className="text-muted-foreground hover:text-foreground text-lg leading-none transition-colors"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <Settings />
          </div>
        </div>
      )}
    </div>
  )
}
