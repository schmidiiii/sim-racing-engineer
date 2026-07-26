import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import Viewer from '@/pages/Viewer'
import Settings from '@/pages/Settings'
import UpdateBanner from '@/components/UpdateBanner'
import TitleBar from '@/components/TitleBar'
import { useAiStore, LANGUAGES, type Language } from '@/store/ai'
import { useT } from '@/lib/i18n'

export default function App() {
  const t = useT()
  const { language, setLanguage } = useAiStore()
  const [dark, setDark] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [version, setVersion] = useState('')

  useEffect(() => {
    if ('__TAURI_INTERNALS__' in window) {
      import('@tauri-apps/api/app').then(({ getVersion }) => getVersion().then(setVersion))
    }
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  useEffect(() => {
    if (!settingsOpen && !feedbackOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setSettingsOpen(false)
      setFeedbackOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen, feedbackOpen])

  useEffect(() => {
    const handler = () => setSettingsOpen(true)
    window.addEventListener('open-settings', handler)
    return () => window.removeEventListener('open-settings', handler)
  }, [])

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      <TitleBar />
      <header className="shrink-0 border-b border-border bg-card">
        <div className="px-5 py-2.5 flex items-center gap-4">
          <div className="flex items-center gap-3">
            <img src="/LogoSRE.png" alt="logo" className="h-11 w-11 object-contain" />
            <div>
              <div className="font-bold text-lg text-foreground tracking-tight leading-tight">Sim Racing Engineer</div>
              {version && <div className="text-xs text-muted-foreground leading-tight">v{version} by schmidiiii</div>}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {/* Language — lives here rather than in the race engineer panel, which
                is collapsed by default and would hide it */}
            <div className="relative">
              <select
                value={language}
                onChange={e => setLanguage(e.target.value as Language)}
                title={t('language')}
                className="appearance-none text-xs font-medium bg-transparent border border-border text-muted-foreground hover:text-foreground rounded-lg pl-3 pr-7 py-1.5 focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer hover:bg-secondary/60 transition-colors"
              >
                {(Object.entries(LANGUAGES) as [Language, string][]).map(([code, name]) => (
                  <option key={code} value={code} className="bg-popover text-foreground">{name}</option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground text-[10px]">▾</span>
            </div>
            <button
              onClick={() => setFeedbackOpen(true)}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('feedback')}
            </button>
            <a
              href="https://ko-fi.com/schmidiiii/donate"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors"
            >
              {t('donate')}
            </a>
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

      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setSettingsOpen(false) }}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
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

      {feedbackOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setFeedbackOpen(false) }}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div className="relative z-10 bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
              <h2 className="text-sm font-semibold text-foreground">{t('feedbackTitle')}</h2>
              <button
                onClick={() => setFeedbackOpen(false)}
                className="text-muted-foreground hover:text-foreground text-lg leading-none transition-colors"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              <p className="text-xs text-muted-foreground leading-relaxed">{t('feedbackIntro')}</p>

              <div className="space-y-2.5">
                <div className="flex gap-3 items-start">
                  <span className="shrink-0 mt-0.5 text-xs font-mono font-semibold text-primary">#bugs</span>
                  <span className="text-xs text-muted-foreground leading-relaxed">{t('feedbackBugs')}</span>
                </div>
                <div className="flex gap-3 items-start">
                  <span className="shrink-0 mt-0.5 text-xs font-mono font-semibold text-primary">#feedback</span>
                  <span className="text-xs text-muted-foreground leading-relaxed">{t('feedbackIdeas')}</span>
                </div>
              </div>

              <p className="text-xs text-muted-foreground leading-relaxed">{t('feedbackOutro')}</p>

              <button
                onClick={() => {
                  // Same route the track guide link uses — opens in the system browser
                  invoke('open_url', { url: 'https://discord.gg/GPzN3ETGFC' }).catch(() => {
                    window.open('https://discord.gg/GPzN3ETGFC', '_blank', 'noopener,noreferrer')
                  })
                  setFeedbackOpen(false)
                }}
                className="w-full flex items-center justify-center gap-2 text-xs font-semibold px-3 py-2.5 rounded-lg text-white transition-colors"
                style={{ backgroundColor: '#5865F2' }}
              >
                {/* Discord mark */}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.6 12.6 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127c-.598.35-1.22.645-1.873.891a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.056c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028ZM8.02 15.331c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z" />
                </svg>
                {t('joinDiscord')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
