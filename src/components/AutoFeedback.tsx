import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useSessionStore, type Lap } from '@/store/session'
import { useAiStore, LANGUAGES, type Language } from '@/store/ai'

function fmtTime(t: number): string {
  if (t <= 0) return '–'
  return t >= 60 ? `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}` : t.toFixed(3)
}

function buildTabPrompt(
  tabLabel: string,
  track: string,
  car: string,
  selectedLaps: Lap[],
  langName: string,
): string {
  const validLaps = selectedLaps
    .filter(l => l.is_valid && l.lap_time > 10)
    .sort((a, b) => a.lap_time - b.lap_time)
  const bestTime = validLaps[0]?.lap_time ?? 0
  const lapLines = validLaps.length
    ? validLaps.map((l, i) => {
        const delta = l.lap_time - bestTime
        return `L${l.lap_number}: ${fmtTime(l.lap_time)}${i === 0 ? ' (ref)' : ` (+${delta.toFixed(3)}s)`}`
      }).join('\n')
    : '(keine Runden ausgewählt)'

  const header = `IMPORTANT: Respond ONLY in ${langName}. Never switch language.\n\n` +
    `Context: ${car} at ${track}\nSelected laps:\n${lapLines}\n\n`

  switch (tabLabel) {
    case 'Delta':
      return header +
        `The driver switched to the Delta tab (lap time difference vs. reference across S1/S2/S3).\n\n` +
        `Based on the time gap between selected laps, give:\n` +
        `- Where on the lap the gap is most likely concentrated (which sector/corners)\n` +
        `- 2–3 specific actions to close the gap\n` +
        `Use turn numbers with names from your knowledge of ${track}. Direct, no filler.`

    case 'Setup':
      return header +
        `The driver switched to the Setup tab to review car setup parameters.\n\n` +
        `Based on the lap times and spread, suggest 1–2 setup directions to explore for ${track}. ` +
        `Reference suspension, aero, or differential as relevant. Concise and specific.`

    case 'Ride Height':
      return header +
        `The driver switched to the Ride Height view.\n\n` +
        `Explain what ride height data reveals at ${track} and what patterns to look for. ` +
        `Mention track-specific ground clearance challenges. One focused paragraph.`

    case 'Rake':
      return header +
        `The driver switched to the Pitch/Roll (Rake) view.\n\n` +
        `Explain what pitch and roll data reveals about car balance and setup for ${track}. ` +
        `What setup changes would pitch/roll patterns suggest? One focused paragraph.`

    case 'Wheel Speed':
      return header +
        `The driver switched to the Wheel Speed view.\n\n` +
        `Explain what wheel speed differential reveals about traction and lockup at ${track}. ` +
        `Link to the lap time gap if applicable. One focused paragraph.`

    case 'Wheel Spin':
      return header +
        `The driver switched to the Wheel Slip/Spin view.\n\n` +
        `Explain what slip ratio data shows about over-driving traction zones at ${track}. ` +
        `What values indicate problematic wheelspin or lockup? One focused paragraph.`

    case 'Shocks':
      return header +
        `The driver switched to the Shock Deflection view.\n\n` +
        `Explain what shock deflection data reveals about damper setup and bump/rebound balance at ${track}. ` +
        `One focused paragraph with setup direction.`

    case 'Shocks Hist':
      return header +
        `The driver switched to the Shock Velocity (histogram) view.\n\n` +
        `Explain what shock velocity distribution reveals about damper tuning at ${track}. ` +
        `What velocity ranges indicate correctly tuned vs. over/underdamped behavior? One focused paragraph.`

    case 'Tyre Temp':
      return header +
        `The driver switched to the Tyre Temperature view.\n\n` +
        `Explain what temperature patterns (L/M/R distribution, cross-car balance) to look for at ${track}. ` +
        `What causes uneven distribution and how to fix it? One focused paragraph.`

    case 'Tyre Pressure':
      return header +
        `The driver switched to the Tyre Pressure view.\n\n` +
        `Explain what tyre pressure trends indicate during a stint at ${track} ` +
        `and the typical optimal operating window for the ${car}. One focused paragraph.`

    default:
      return header +
        `The driver switched to the ${tabLabel} telemetry view.\n\n` +
        `Give one focused paragraph on what this data reveals at ${track} and what patterns to look for.`
  }
}

export default function AutoFeedback() {
  const { sessions, activeSessionId, selectedLapKeys, activeTabLabel } = useSessionStore()
  const session = sessions.find(s => s.id === activeSessionId) ?? sessions[0]
  const { provider, language, addMessage, appendToLast, setStreaming, clearMessages } = useAiStore()
  const analyzedSessionRef = useRef<string | null>(null)
  const analyzedTabRef = useRef<string | null>(null)

  // ── Existing: full session analysis on load ──────────────────────────────────
  useEffect(() => {
    const effectKey = session ? `${session.id}:${language}` : null
    if (!session || !effectKey || analyzedSessionRef.current === effectKey) return
    analyzedSessionRef.current = effectKey

    const sessionId = session.id
    const chatKey = `${sessionId}:General`
    const eventId = crypto.randomUUID()

    clearMessages(chatKey)
    addMessage(chatKey, { role: 'assistant', content: '' })
    setStreaming(true)

    let unlistenToken: (() => void) | undefined
    let unlistenDone: (() => void) | undefined

    Promise.all([
      listen<string>(`ai-token-${eventId}`, (e) => appendToLast(chatKey, e.payload)),
      listen<void>(`ai-done-${eventId}`, () => {
        setStreaming(false)
        unlistenToken?.()
        unlistenDone?.()
      }),
    ]).then(([ut, ud]) => {
      unlistenToken = ut
      unlistenDone = ud

      invoke('auto_analyze', {
        sessionId,
        provider,
        language,
        eventId,
      }).catch((err: unknown) => {
        appendToLast(chatKey, `\n\nError: ${String(err)}`)
        setStreaming(false)
      })
    })

    return () => {
      unlistenToken?.()
      unlistenDone?.()
    }
  }, [session?.id, language])

  // ── New: tab-specific feedback on tab switch (debounced 2 s) ────────────────
  useEffect(() => {
    if (!session || activeTabLabel === 'General') return

    const lapKeyStr = selectedLapKeys.join(',')
    const tabKey = `${session.id}:${activeTabLabel}:${lapKeyStr}:${language}`
    if (analyzedTabRef.current === tabKey) return

    // Wait 2 s — if the user keeps switching tabs, cancel and restart the timer
    const timer = setTimeout(() => {
      // Re-check streaming after the delay
      if (useAiStore.getState().streaming) return

      analyzedTabRef.current = tabKey

      const sessionId = session.id
      const chatKey = `${sessionId}:${activeTabLabel}`
      const eventId = crypto.randomUUID()

      const langName = LANGUAGES[language as Language] ?? 'English'
      const selectedLaps = selectedLapKeys
        .map(k => {
          const idx = k.lastIndexOf(':')
          const lapNum = parseInt(k.slice(idx + 1))
          return session.laps.find(l => l.lap_number === lapNum)
        })
        .filter((l): l is Lap => l !== undefined)

      const prompt = buildTabPrompt(activeTabLabel, session.track, session.car, selectedLaps, langName)

      const systemMsg = {
        role: 'system' as const,
        content:
          `You are the driver's personal race engineer for iRacing sim-racing. ` +
          `Tone: professional, direct, data-driven, constructively critical. No filler praise. ` +
          `Use motorsport vocabulary. Respond ONLY in ${langName}.`,
      }

      clearMessages(chatKey)
      addMessage(chatKey, { role: 'assistant', content: '' })
      setStreaming(true)

      let unlistenToken: (() => void) | undefined
      let unlistenDone: (() => void) | undefined

      Promise.all([
        listen<string>(`ai-token-${eventId}`, (e) => appendToLast(chatKey, e.payload)),
        listen<void>(`ai-done-${eventId}`, () => {
          setStreaming(false)
          unlistenToken?.()
          unlistenDone?.()
        }),
      ]).then(([ut, ud]) => {
        unlistenToken = ut
        unlistenDone = ud

        invoke('query_ai', {
          provider,
          messages: [systemMsg, { role: 'user', content: prompt }],
          eventId,
        }).catch((err: unknown) => {
          appendToLast(chatKey, `\n\nError: ${String(err)}`)
          setStreaming(false)
        })
      })
    }, 2000)

    return () => clearTimeout(timer)
  }, [session?.id, activeTabLabel, selectedLapKeys.join(','), language])

  return null
}
