import { useRef, useEffect, useState, KeyboardEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useSessionStore } from '@/store/session'
import { useAiStore } from '@/store/ai'

export default function ChatThread() {
  const { session } = useSessionStore()
  const { provider, messages, streaming, addMessage, appendToLast, setStreaming } = useAiStore()
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = async () => {
    if (!input.trim() || streaming || !session) return

    const userMsg = input.trim()
    setInput('')

    addMessage({ role: 'user', content: userMsg })
    addMessage({ role: 'assistant', content: '' })
    setStreaming(true)

    const eventId = crypto.randomUUID()

    let unlistenToken: (() => void) | undefined
    let unlistenDone: (() => void) | undefined

    const [ut, ud] = await Promise.all([
      listen<string>(`ai-token-${eventId}`, (e) => appendToLast(e.payload)),
      listen<void>(`ai-done-${eventId}`, () => {
        setStreaming(false)
        unlistenToken?.()
        unlistenDone?.()
      }),
    ])
    unlistenToken = ut
    unlistenDone = ud

    const chatMessages = [
      ...messages.filter(m => m.content.trim()),
      { role: 'user' as const, content: userMsg },
    ]

    invoke('query_ai', {
      provider,
      messages: chatMessages,
      eventId,
    }).catch((err: unknown) => {
      appendToLast(`\n\nError: ${String(err)}`)
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
      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {messages.map((msg, i) => (
          <div key={i} className={msg.role === 'user' ? 'flex justify-end' : ''}>
            {msg.role === 'user' ? (
              <div className="bg-primary text-primary-foreground rounded-lg px-3 py-2 text-xs max-w-[85%]">
                {msg.content}
              </div>
            ) : (
              <div className="text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed">
                {msg.content}
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
          placeholder={session ? 'Ask a question… (Enter to send)' : 'Load a session first'}
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
