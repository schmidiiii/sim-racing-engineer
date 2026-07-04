import AutoFeedback from '@/components/AutoFeedback'
import ChatThread from '@/components/ChatThread'
import { useAiStore, LANGUAGES, type Language } from '@/store/ai'
import { useT } from '@/lib/i18n'

export default function AiPanel() {
  const t = useT()
  const { language, setLanguage } = useAiStore()

  return (
    <aside className="w-96 shrink-0 border-l border-border bg-card flex flex-col overflow-hidden">
      <AutoFeedback />
      <div className="px-4 pt-4 pb-3 shrink-0 border-b border-border flex items-center justify-between">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">{t('aiCoach')}</p>
        <div className="relative">
          <select
            value={language}
            onChange={e => setLanguage(e.target.value as Language)}
            className="appearance-none text-xs font-medium bg-transparent border border-border text-foreground rounded-lg pl-3 pr-7 py-1.5 focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer hover:bg-secondary/60 transition-colors"
          >
            {(Object.entries(LANGUAGES) as [Language, string][]).map(([code, name]) => (
              <option key={code} value={code} className="bg-popover text-foreground">{name}</option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground text-[10px]">▾</span>
        </div>
      </div>
      <div className="flex-1 flex flex-col overflow-hidden px-4 pb-4 pt-3 gap-3">
        <ChatThread />
      </div>
    </aside>
  )
}
