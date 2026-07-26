import { useState } from 'react'
import AutoFeedback from '@/components/AutoFeedback'
import ChatThread from '@/components/ChatThread'
import { useT } from '@/lib/i18n'

export default function AiPanel() {
  const t = useT()
  // Collapsed unless the user has opened it before — the telemetry gets the width
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem('aiPanelOpen') === 'true' } catch { return false }
  })

  const toggle = () => setOpen(v => {
    const next = !v
    try { localStorage.setItem('aiPanelOpen', String(next)) } catch { /* */ }
    return next
  })

  if (!open) {
    return (
      <aside className="shrink-0 border-l border-border bg-card flex flex-col items-center pt-3 w-10">
        <button
          onClick={toggle}
          title={t('aiCoach')}
          className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          {/* chevron-left icon */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span
          className="mt-4 text-[9px] font-semibold text-muted-foreground uppercase tracking-widest"
          style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}
        >
          {t('aiCoach')}
        </span>
      </aside>
    )
  }

  return (
    <aside className="w-96 shrink-0 border-l border-border bg-card flex flex-col overflow-hidden">
      <AutoFeedback />
      <div className="px-4 pt-4 pb-3 shrink-0 border-b border-border flex items-center justify-between">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">{t('aiCoach')}</p>
        <div className="flex items-center gap-2">
          {/* Language selector moved to the app header — see App.tsx */}
          <button
            onClick={toggle}
            className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
          >
            {/* chevron-right icon */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      </div>
      <div className="flex-1 flex flex-col overflow-hidden px-4 pb-4 pt-3 gap-3">
        <ChatThread />
      </div>
    </aside>
  )
}
