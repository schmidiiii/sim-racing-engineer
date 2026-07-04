import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useSessionStore, type Lap } from '@/store/session'
import { useAiStore, LANGUAGES, type Language } from '@/store/ai'

function fmtTime(t: number): string {
  if (t <= 0) return '–'
  return t >= 60 ? `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}` : t.toFixed(3)
}

// Channels that must be present for a tab to have meaningful data
const TAB_CHANNELS: Record<string, string[]> = {
  'Braking':      ['Brake', 'Speed'],
  'Corner Speed': ['Speed'],
  'Ride Height': ['RFrideHeight', 'LFrideHeight', 'RRrideHeight', 'LRrideHeight'],
  'Rake':        ['Pitch', 'Roll', 'RFrideHeight', 'RRrideHeight'],
  'Wheel Speed': ['RFspeed', 'LFspeed', 'RRspeed', 'LRspeed'],
  'Wheel Spin':  ['RFslipAngle', 'LFslipAngle', 'RFslipRatio', 'LFslipRatio'],
  'Shocks':      ['RFshockDefl', 'LFshockDefl', 'RRshockDefl', 'LRshockDefl'],
  'Shocks Hist': ['RFshockVel', 'LFshockVel', 'RRshockVel', 'LRshockVel'],
  'Tyre Temp':   ['LFtempL', 'LFtempM', 'LFtempR', 'RFtempL'],
  'Tyre Pressure': ['LFpressure', 'RFpressure', 'LRpressure', 'RRpressure'],
}

function hasTabData(tabLabel: string, availableChannels: string[]): boolean {
  const required = TAB_CHANNELS[tabLabel]
  if (!required) return true // tabs like Delta/Setup/General always have something
  return required.some(ch => availableChannels.includes(ch))
}

function buildSystemPrompt(langName: string): string {
  const addressNote = langName === 'Deutsch'
    ? 'Sprich den Fahrer immer direkt mit "du" an — niemals "Sie", niemals "der Fahrer". Beispiel: "Du bremst zu spät", nicht "Der Fahrer bremst zu spät". '
    : 'Always address the driver directly as "you" — never say "the driver" or refer to them in third person. Example: "You brake too late at T3", not "The driver brakes...". '
  return (
    `You are a personal race engineer giving direct, blunt feedback on iRacing telemetry. ` +
    `${addressNote}` +
    `Rules you MUST follow:\n` +
    `- Be direct, honest, and blunt. Zero filler phrases like "great job", "well done", "interesting". Start immediately with the point.\n` +
    `- Reference ONLY the data provided. Numbers, lap times, deltas — always be specific.\n` +
    `- If data is missing or insufficient, say so explicitly and briefly. Do not invent data.\n` +
    `- No hedging ("might", "could possibly", "it depends"). Give a concrete opinion.\n` +
    `- NEVER invent or guess lap time targets, world records, or benchmark times. You do not have reliable iRacing-specific lap time data. If asked, say so and focus on technique instead.\n` +
    `- Use motorsport vocabulary: trail-braking, apex, understeer, oversteer, throttle application, rotation, brake bias, minimum speed.\n` +
    `- Respond ONLY in ${langName}. Never switch language.`
  )
}

function buildNoDataMessage(tabLabel: string, langName: string): string {
  if (langName === 'Deutsch') {
    return `**${tabLabel}: Keine Daten verfügbar**\n\nDiese Session enthält keine Messdaten für die "${tabLabel}"-Ansicht. ` +
      `Das passiert, wenn das Fahrzeug diese Sensoren nicht hat oder iRacing sie für dieses Auto nicht aufzeichnet. ` +
      `Wechsle zu einem anderen Tab für verfügbare Telemetriedaten.`
  }
  return `**${tabLabel}: No data available**\n\nThis session contains no channel data for the "${tabLabel}" view. ` +
    `This happens when the car doesn't have these sensors or iRacing doesn't record them for this car. ` +
    `Switch to another tab for available telemetry data.`
}

function buildTabPrompt(
  tabLabel: string,
  track: string,
  car: string,
  selectedLaps: Lap[],
  langName: string,
  availableChannels: string[],
): string | null {
  // Return null → inject no-data message directly without calling AI
  if (!hasTabData(tabLabel, availableChannels)) return null

  const validLaps = selectedLaps
    .filter(l => l.is_valid && l.lap_time > 10)
    .sort((a, b) => a.lap_time - b.lap_time)

  if (validLaps.length === 0) {
    return langName === 'Deutsch'
      ? `Auto: ${car} | Strecke: ${track}\n\nKeine gültigen Runden ausgewählt. Sag mir kurz, was ich tun soll.`
      : `Car: ${car} | Track: ${track}\n\nNo valid laps selected. Tell me briefly what I need to do.`
  }

  const bestTime = validLaps[0].lap_time
  const lapLines = validLaps.map((l, i) => {
    const delta = l.lap_time - bestTime
    return `L${l.lap_number}: ${fmtTime(l.lap_time)}${i === 0 ? ' [ref]' : ` (+${delta.toFixed(3)}s)`}`
  }).join('\n')
  const spread = validLaps.length > 1
    ? ` | Spread: ${(validLaps[validLaps.length - 1].lap_time - bestTime).toFixed(3)}s`
    : ''

  const ctx = `Car: ${car} | Track: ${track}\nLaps:\n${lapLines}${spread}\n\n`

  switch (tabLabel) {
    case 'Corner Speed':
      return ctx +
        `You are on the Corner Speed tab showing minimum speed through each corner. ` +
        `Tell me specifically which corners I'm losing the most speed in at ${track} with the ${car}. ` +
        `What is the minimum speed target for the key corners? ` +
        `Is it better to sacrifice entry speed for a better exit, or is there a corner where I can carry more speed through? ` +
        `Name the corners by turn number and name. Be direct and specific.`

    case 'Braking':
      return ctx +
        `You are on the Brake Analysis tab. Your fastest lap is ${fmtTime(bestTime)}. ` +
        `Tell me specifically about my braking technique at ${track} with the ${car}. ` +
        `Which corners require the most aggressive braking? Where am I likely losing time under braking? ` +
        `What is the ideal brake point for the key heavy braking zones at ${track}? ` +
        `Give concrete, specific advice — name the turn numbers and corners.`

    case 'Delta':
      return ctx +
        `You are looking at the Delta tab. Your fastest lap is ${fmtTime(bestTime)}. ` +
        (validLaps.length > 1
          ? `You have ${validLaps.length} laps selected with a spread of ${(validLaps[validLaps.length - 1].lap_time - bestTime).toFixed(3)}s. ` +
            `Tell me directly where you are losing time — name the specific corners at ${track} by number/name. ` +
            `Give 2 concrete, actionable things to fix — not generic, specific to this track layout. ` +
            `Be blunt about what you are probably doing wrong.`
          : `Only one lap selected — no delta comparison possible. ` +
            `My lap time is ${fmtTime(bestTime)} in the ${car} at ${track}. ` +
            `Do NOT invent or guess a target lap time — you do not have reliable data for that. ` +
            `Instead: identify the 2-3 most likely areas where time is lost on this track layout with this car, based on track characteristics. Be specific about corners and techniques.`
        )

    case 'Setup':
      return ctx +
        `You are reviewing your car setup. ` +
        `Based on your lap time of ${fmtTime(bestTime)} in the ${car} at ${track}, ` +
        `give 2 specific setup directions — not vague, pick actual parameters ` +
        `(e.g. "increase front ARB by 2 clicks", "soften rear rebound", "lower rear ride height 2mm"). ` +
        `Reference what balance issue the lap time spread suggests.`

    case 'Ride Height':
      return ctx +
        `You are on the Ride Height view. ${car} at ${track}. ` +
        `Tell me what my ride height data reveals about aero platform and ground clearance on this track. ` +
        `Name the specific corners where ride height is most critical at ${track}. ` +
        `What values are too high/too low and what happens if they are? Be specific, no generics.`

    case 'Rake':
      return ctx +
        `You are on the Pitch/Roll (Rake) view. ${car} at ${track}. ` +
        `Tell me what my pitch and roll telemetry reveals about the car's balance. ` +
        `What setup change does a front-heavy pitch pattern suggest vs. a rear-heavy one? ` +
        `Reference ${track}'s specific braking and corner characteristics.`

    case 'Wheel Speed':
      return ctx +
        `You are on the Wheel Speed view. ` +
        `Analyse what my wheel speed differential between front and rear reveals about traction and locking. ` +
        `At ${track}, which corners are most critical for wheel speed management with ${car}? ` +
        `Name them specifically. What does a lockup signature look like in this data?`

    case 'Wheel Spin':
      return ctx +
        `You are on the Wheel Slip/Spin view. ` +
        `Analyse my slip ratio data for the ${car} at ${track}. ` +
        `Which exit zones are most likely to cause wheelspin with this car? ` +
        `What slip ratio range is acceptable vs. damaging lap time? Name specific corners at ${track}.`

    case 'Shocks':
      return ctx +
        `You are on the Shock Deflection view. ` +
        `Analyse what my shock deflection patterns reveal about damper setup for the ${car} at ${track}. ` +
        `Is the car bottoming, is one corner working harder than others? ` +
        `Give a specific damper direction (bump/rebound stiffness) based on what the data shows.`

    case 'Shocks Hist':
      return ctx +
        `You are on the Shock Velocity histogram. ` +
        `Explain my velocity distribution for the ${car} at ${track}. ` +
        `What does a histogram skewed to high velocities indicate vs. one clustered in low velocities? ` +
        `Give a concrete damper adjustment based on whether the profile looks over- or under-damped.`

    case 'Tyre Temp':
      return ctx +
        `You are on the Tyre Temperature view. ${car} at ${track}. ` +
        `Analyse my L/M/R temperature distribution across all four corners. ` +
        `What does outside-edge overheating indicate vs. inside-edge? ` +
        `Give a specific setup correction for any imbalance — tyre pressures, camber, or aero.`

    case 'Tyre Pressure':
      return ctx +
        `You are on the Tyre Pressure view. ${car} at ${track}. ` +
        `What is the optimal hot pressure window for the ${car}? ` +
        `If my pressures are too high at the end of a stint, what causes it and how do I fix it? ` +
        `Be specific with numbers where possible.`

    default:
      return ctx +
        `You are on the ${tabLabel} telemetry view for the ${car} at ${track}. ` +
        `Give specific, data-driven coaching on what this view reveals and what I should be looking for. ` +
        `No generic explanations — focus on ${track} and ${car} specifically.`
  }
}

export default function AutoFeedback() {
  const { sessions, activeSessionId, selectedLapKeys, activeTabLabel } = useSessionStore()
  const session = sessions.find(s => s.id === activeSessionId) ?? sessions[0]
  const { provider, isConfigured, language, addMessage, appendToLast, setStreaming, clearMessages } = useAiStore()
  const analyzedSessionRef = useRef<string | null>(null)
  const analyzedTabRef = useRef<string | null>(null)

  // Full session analysis on load (General tab)
  useEffect(() => {
    if (!isConfigured) return
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
  }, [session?.id, language, isConfigured])

  // Tab-specific feedback on tab switch (debounced 2s)
  useEffect(() => {
    if (!session || !isConfigured || activeTabLabel === 'General') return

    const lapKeyStr = selectedLapKeys.join(',')
    const tabKey = `${session.id}:${activeTabLabel}:${lapKeyStr}:${language}`
    if (analyzedTabRef.current === tabKey) return

    const timer = setTimeout(() => {
      if (useAiStore.getState().streaming) return

      analyzedTabRef.current = tabKey

      const sessionId = session.id
      const chatKey = `${sessionId}:${activeTabLabel}`
      const langName = LANGUAGES[language as Language] ?? 'English'

      const availableChannels = session.available_channels.map(c => c.name)

      const selectedLaps = selectedLapKeys
        .map(k => {
          const idx = k.lastIndexOf(':')
          const lapNum = parseInt(k.slice(idx + 1))
          return session.laps.find(l => l.lap_number === lapNum)
        })
        .filter((l): l is Lap => l !== undefined)

      const prompt = buildTabPrompt(activeTabLabel, session.track, session.car, selectedLaps, langName, availableChannels)

      clearMessages(chatKey)

      // No AI call needed — inject no-data message directly
      if (prompt === null) {
        addMessage(chatKey, { role: 'assistant', content: buildNoDataMessage(activeTabLabel, langName) })
        return
      }

      const systemMsg = {
        role: 'system' as const,
        content: buildSystemPrompt(langName),
      }

      const eventId = crypto.randomUUID()

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
  }, [session?.id, activeTabLabel, selectedLapKeys.join(','), language, isConfigured])

  return null
}
