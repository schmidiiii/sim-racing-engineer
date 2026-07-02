import { create } from 'zustand'

export type ProviderType = 'Ollama' | 'OpenAI' | 'Gemini'

export interface ProviderConfig {
  type: ProviderType
  base_url?: string   // Ollama only
  api_key?: string    // OpenAI / Gemini
  model: string
}

export interface AiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface AiStore {
  provider: ProviderConfig
  messages: AiMessage[]
  streaming: boolean
  setProvider: (p: ProviderConfig) => void
  addMessage: (m: AiMessage) => void
  appendToLast: (token: string) => void
  setStreaming: (v: boolean) => void
  clearMessages: () => void
}

const DEFAULT_PROVIDER: ProviderConfig = {
  type: 'Ollama',
  base_url: 'http://localhost:11434',
  model: 'llama3',
}

function loadProvider(): ProviderConfig {
  try {
    const raw = localStorage.getItem('ai_provider')
    if (raw) return JSON.parse(raw)
  } catch {}
  return DEFAULT_PROVIDER
}

export const useAiStore = create<AiStore>((set) => ({
  provider: loadProvider(),
  messages: [],
  streaming: false,

  setProvider: (p) => {
    localStorage.setItem('ai_provider', JSON.stringify(p))
    set({ provider: p })
  },

  addMessage: (m) => set(s => ({ messages: [...s.messages, m] })),

  appendToLast: (token) => set(s => {
    const msgs = [...s.messages]
    if (msgs.length === 0) return s
    const last = msgs[msgs.length - 1]
    msgs[msgs.length - 1] = { ...last, content: last.content + token }
    return { messages: msgs }
  }),

  setStreaming: (v) => set({ streaming: v }),

  clearMessages: () => set({ messages: [] }),
}))
