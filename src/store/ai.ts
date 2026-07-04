import { create } from 'zustand'

export type ProviderType = 'Ollama' | 'OpenAI' | 'Gemini'

export interface ProviderConfig {
  type: ProviderType
  base_url?: string
  api_key?: string
  model: string
}

export interface AiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export type Language = 'en' | 'de' | 'fr' | 'es' | 'it' | 'pt' | 'nl' | 'pl' | 'ru' | 'ja' | 'zh'

export const LANGUAGES: Record<Language, string> = {
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  it: 'Italiano',
  pt: 'Português',
  nl: 'Nederlands',
  pl: 'Polski',
  ru: 'Русский',
  ja: '日本語',
  zh: '中文',
}

interface AiStore {
  provider: ProviderConfig
  isConfigured: boolean
  language: Language
  chatHistory: Record<string, AiMessage[]>
  streaming: boolean
  setProvider: (p: ProviderConfig) => void
  setLanguage: (l: Language) => void
  addMessage: (sessionId: string, m: AiMessage) => void
  appendToLast: (sessionId: string, token: string) => void
  setStreaming: (v: boolean) => void
  clearMessages: (sessionId: string) => void
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
  isConfigured: !!localStorage.getItem('ai_provider'),
  language: (localStorage.getItem('ai_language') as Language) ?? 'en',
  chatHistory: {},
  streaming: false,

  setProvider: (p) => {
    localStorage.setItem('ai_provider', JSON.stringify(p))
    set({ provider: p, isConfigured: true })
  },

  setLanguage: (l) => {
    localStorage.setItem('ai_language', l)
    set({ language: l })
  },

  addMessage: (sessionId, m) => set(s => ({
    chatHistory: {
      ...s.chatHistory,
      [sessionId]: [...(s.chatHistory[sessionId] ?? []), m],
    },
  })),

  appendToLast: (sessionId, token) => set(s => {
    const msgs = [...(s.chatHistory[sessionId] ?? [])]
    if (msgs.length === 0) return s
    const last = msgs[msgs.length - 1]
    msgs[msgs.length - 1] = { ...last, content: last.content + token }
    return { chatHistory: { ...s.chatHistory, [sessionId]: msgs } }
  }),

  setStreaming: (v) => set({ streaming: v }),

  clearMessages: (sessionId) => set(s => ({
    chatHistory: { ...s.chatHistory, [sessionId]: [] },
  })),
}))
