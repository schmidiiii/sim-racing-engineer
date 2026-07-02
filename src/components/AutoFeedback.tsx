import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useSessionStore } from '@/store/session'
import { useAiStore } from '@/store/ai'

export default function AutoFeedback() {
  const { session } = useSessionStore()
  const { provider, addMessage, appendToLast, setStreaming, clearMessages } = useAiStore()
  const analyzedSessionRef = useRef<string | null>(null)

  useEffect(() => {
    if (!session || analyzedSessionRef.current === session.id) return
    analyzedSessionRef.current = session.id

    const eventId = crypto.randomUUID()

    clearMessages()
    addMessage({ role: 'assistant', content: '' })
    setStreaming(true)

    let unlistenToken: (() => void) | undefined
    let unlistenDone: (() => void) | undefined

    Promise.all([
      listen<string>(`ai-token-${eventId}`, (e) => appendToLast(e.payload)),
      listen<void>(`ai-done-${eventId}`, () => {
        setStreaming(false)
        unlistenToken?.()
        unlistenDone?.()
      }),
    ]).then(([ut, ud]) => {
      unlistenToken = ut
      unlistenDone = ud

      invoke('auto_analyze', {
        sessionId: session.id,
        provider,
        eventId,
      }).catch((err: unknown) => {
        appendToLast(`\n\nError: ${String(err)}`)
        setStreaming(false)
      })
    })

    return () => {
      unlistenToken?.()
      unlistenDone?.()
    }
  }, [session?.id])

  return null
}
