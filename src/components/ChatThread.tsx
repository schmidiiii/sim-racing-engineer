import { useRef, useEffect, useState, KeyboardEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useSessionStore } from '@/store/session'
import { useAiStore, LANGUAGES } from '@/store/ai'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useT } from '@/lib/i18n'

export default function ChatThread() {
  const t = useT()
  const { sessions, activeSessionId, activeTabLabel } = useSessionStore()
  const session = sessions.find(s => s.id === activeSessionId) ?? sessions[0]
  const { provider, language, chatHistory, streaming, addMessage, appendToLast, setStreaming } = useAiStore()
  const chatKey = session ? `${session.id}:${activeTabLabel}` : ''
  const messages = chatHistory[chatKey] ?? []
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = async () => {
    if (!input.trim() || streaming || !session) return

    const key = chatKey
    const userMsg = input.trim()
    setInput('')

    addMessage(key, { role: 'user', content: userMsg })
    addMessage(key, { role: 'assistant', content: '' })
    setStreaming(true)

    const eventId = crypto.randomUUID()

    let unlistenToken: (() => void) | undefined
    let unlistenDone: (() => void) | undefined

    const [ut, ud] = await Promise.all([
      listen<string>(`ai-token-${eventId}`, (e) => appendToLast(key, e.payload)),
      listen<void>(`ai-done-${eventId}`, () => {
        setStreaming(false)
        unlistenToken?.()
        unlistenDone?.()
      }),
    ])
    unlistenToken = ut
    unlistenDone = ud

    const langName = LANGUAGES[language] ?? 'English'
    const sessionCtx = session
      ? ` The driver is analysing an iRacing session at ${session.track} in the ${session.car}.`
      : ''
    const systemMsg =
      `You are the driver's personal race engineer for iRacing sim-racing.${sessionCtx} ` +
      `Your tone is professional, direct, data-driven, and constructively critical — ` +
      `no filler praise ("great job", "well done"), no hedging. You hunt for tenths left on track. ` +
      `Use motorsport vocabulary: trail-braking, apex, throttle application, rotation, ` +
      `understeer, oversteer, track limits, minimum speed, brake bias. ` +
      `Every question the driver asks is about their iRacing driving performance — treat it that way. ` +
      `Respond ONLY in ${langName}. Never switch language.`

    const chatMessages = [
      { role: 'system' as const, content: systemMsg },
      ...messages.filter(m => m.content.trim() && m.role !== 'system'),
      { role: 'user' as const, content: userMsg },
    ]

    invoke('query_ai', {
      provider,
      messages: chatMessages,
      eventId,
    }).catch((err: unknown) => {
      appendToLast(key, `\n\nError: ${String(err)}`)
      setStreaming(false)
    })
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <>
      {/* Session indicator */}
      {session && (
        <div className="shrink-0 pb-2 mb-1 border-b border-border">
          <p className="text-[10px] font-medium text-muted-foreground truncate leading-snug">{session.track}</p>
          <p className="text-[10px] text-muted-foreground/60 truncate">{session.car} · {session.date.slice(0, 10)}</p>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground/50 text-center pt-6">
            {t('noMessages')}
          </p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={msg.role === 'user' ? 'flex justify-end' : ''}>
            {msg.role === 'user' ? (
              <div className="bg-primary text-primary-foreground rounded-lg px-3 py-2 text-xs max-w-[85%]">
                {msg.content}
              </div>
            ) : (
              <div className="prose-ai text-xs leading-relaxed">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    h2: ({ children }) => <h2 className="text-sm font-semibold text-foreground mt-3 mb-1 first:mt-0">{children}</h2>,
                    h3: ({ children }) => <h3 className="text-xs font-semibold text-foreground/90 mt-2 mb-0.5">{children}</h3>,
                    p: ({ children }) => <p className="text-xs text-foreground/85 mb-1.5 leading-relaxed">{children}</p>,
                    ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 mb-1.5 text-xs text-foreground/85">{children}</ul>,
                    ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 mb-1.5 text-xs text-foreground/85">{children}</ol>,
                    li: ({ children }) => <li className="text-xs">{children}</li>,
                    strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
                    code: ({ children }) => <code className="bg-secondary px-1 rounded text-xs font-mono">{children}</code>,
                    hr: () => <hr className="border-border my-2" />,
                  }}
                >
                  {msg.content}
                </ReactMarkdown>
                {streaming && i === messages.length - 1 && (
                  <span className="inline-block w-1 h-3 bg-foreground/60 ml-0.5 animate-pulse" />
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 pt-2 border-t border-border">
        <textarea
          className="w-full bg-secondary/50 text-foreground text-xs rounded px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
          placeholder={session ? t('askQuestion') : t('loadSessionFirst')}
          rows={2}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!session || streaming}
        />
      </div>
    </>
  )
}
