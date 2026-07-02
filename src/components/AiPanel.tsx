import AutoFeedback from '@/components/AutoFeedback'
import ChatThread from '@/components/ChatThread'

export default function AiPanel() {
  return (
    <aside className="w-72 shrink-0 border-l border-border flex flex-col overflow-hidden bg-background">
      <AutoFeedback />
      <div className="px-3 pt-3 pb-2 shrink-0 border-b border-border">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">AI Coach</p>
      </div>
      <div className="flex-1 flex flex-col overflow-hidden px-3 pb-3 pt-2 gap-2">
        <ChatThread />
      </div>
    </aside>
  )
}
