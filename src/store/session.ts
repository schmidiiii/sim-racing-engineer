import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'

export interface Lap {
  lap_number: number
  lap_time: number
  is_valid: boolean
  start_sample: number
  end_sample: number
}

export interface Channel {
  name: string
  description: string
  unit: string
  var_type: string
}

export interface Session {
  id: string
  file_path: string
  track: string
  car: string
  date: string
  tick_rate: number
  record_count: number
  laps: Lap[]
  available_channels: Channel[]
}

export interface LapChannelData {
  lap_number: number
  channel: string
  samples: number[]
  timestamps: number[]
}

// Lap key uniquely identifies a lap across sessions: "sessionId:lapNumber"
export const lapKey = (sessionId: string, lapNumber: number) => `${sessionId}:${lapNumber}`
export const parseLapKey = (key: string): { sessionId: string; lapNumber: number } => {
  const idx = key.lastIndexOf(':')
  return { sessionId: key.slice(0, idx), lapNumber: parseInt(key.slice(idx + 1)) }
}

const LAP_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b',
  '#a855f7', '#ec4899', '#14b8a6', '#f97316',
]

export const getLapColor = (colorIndex: number) => LAP_COLORS[colorIndex % LAP_COLORS.length]

interface SessionStore {
  sessions: Session[]
  selectedLapKeys: string[]
  loading: boolean
  error: string | null
  loadLatest: () => Promise<void>
  loadFiles: (paths: string[]) => Promise<void>
  toggleLap: (sessionId: string, lapNumber: number) => void
  // Helper: index of this lap key in the global selected list (for color assignment)
  lapColorIndex: (key: string) => number
}

function pickDefaultLaps(sessions: Session[], existingKeys: string[]): string[] {
  // Pick up to 4 valid laps total across all sessions (newest sessions first)
  const keys: string[] = []
  for (const session of [...sessions].reverse()) {
    for (const lap of session.laps) {
      if (lap.is_valid && keys.length < 4) {
        const k = lapKey(session.id, lap.lap_number)
        if (!existingKeys.includes(k)) keys.push(k)
      }
    }
    if (keys.length >= 4) break
  }
  return keys
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  selectedLapKeys: [],
  loading: false,
  error: null,

  loadLatest: async () => {
    set({ loading: true, error: null })
    try {
      const session = await invoke<Session>('get_latest_session')
      const keys = pickDefaultLaps([session], [])
      set(_s => ({
        sessions: [session],
        selectedLapKeys: keys,
        loading: false,
      }))
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  loadFiles: async (paths: string[]) => {
    set({ loading: true, error: null })
    try {
      const loaded: Session[] = []
      for (const path of paths) {
        const session = await invoke<Session>('load_session', { path })
        loaded.push(session)
      }
      set(s => {
        // Merge: keep existing sessions (deduplicated by id), add new ones
        const existingIds = new Set(s.sessions.map(x => x.id))
        const merged = [...s.sessions, ...loaded.filter(x => !existingIds.has(x.id))]
        const newKeys = pickDefaultLaps(loaded, s.selectedLapKeys)
        return {
          sessions: merged,
          selectedLapKeys: [...s.selectedLapKeys, ...newKeys].slice(0, 8),
          loading: false,
        }
      })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  toggleLap: (sessionId: string, lapNumber: number) => {
    const key = lapKey(sessionId, lapNumber)
    const { selectedLapKeys } = get()
    if (selectedLapKeys.includes(key)) {
      set({ selectedLapKeys: selectedLapKeys.filter(k => k !== key) })
    } else {
      set({ selectedLapKeys: [...selectedLapKeys, key] })
    }
  },

  lapColorIndex: (key: string) => {
    const { selectedLapKeys } = get()
    const idx = selectedLapKeys.indexOf(key)
    return idx >= 0 ? idx : selectedLapKeys.length
  },
}))
