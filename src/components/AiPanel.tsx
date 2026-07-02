import AutoFeedback from '@/components/AutoFeedback'
import ChatThread from '@/components/ChatThread'

export default function AiPanel() {
  return (
    <aside className="w-72 shrink-0 border-l border-border bg-card flex flex-col overflow-hidden">
      <AutoFeedback />
      <div className="px-4 pt-4 pb-3 shrink-0 border-b border-border">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">AI Coach</p>
      </div>
      <div className="flex-1 flex flex-col overflow-hidden px-4 pb-4 pt-3 gap-3">
        <ChatThread />
      </div>
    </aside>
  )
}
