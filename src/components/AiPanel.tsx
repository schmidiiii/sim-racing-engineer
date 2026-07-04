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
        <select
          value={language}
          onChange={e => setLanguage(e.target.value as Language)}
          className="text-[10px] bg-secondary text-foreground rounded px-2 py-1 border border-border focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
        >
          {(Object.entries(LANGUAGES) as [Language, string][]).map(([code, name]) => (
            <option key={code} value={code}>{name}</option>
          ))}
        </select>
      </div>
      <div className="flex-1 flex flex-col overflow-hidden px-4 pb-4 pt-3 gap-3">
        <ChatThread />
      </div>
    </aside>
  )
}
