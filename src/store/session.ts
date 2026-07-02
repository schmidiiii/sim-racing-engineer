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

interface SessionStore {
  session: Session | null
  selectedLaps: number[]
  loading: boolean
  error: string | null
  loadLatest: () => Promise<void>
  loadFile: (path: string) => Promise<void>
  toggleLap: (lapNumber: number) => void
  selectAllLaps: () => void
}

const LAP_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b',
  '#a855f7', '#ec4899', '#14b8a6', '#f97316',
]

export const useLapColor = (lapNumber: number) =>
  LAP_COLORS[lapNumber % LAP_COLORS.length]

export const useSessionStore = create<SessionStore>((set, get) => ({
  session: null,
  selectedLaps: [],
  loading: false,
  error: null,

  loadLatest: async () => {
    set({ loading: true, error: null })
    try {
      const session = await invoke<Session>('get_latest_session')
      const validLaps = session.laps
        .filter(l => l.is_valid)
        .slice(0, 4)
        .map(l => l.lap_number)
      set({ session, selectedLaps: validLaps, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  loadFile: async (path: string) => {
    set({ loading: true, error: null })
    try {
      const session = await invoke<Session>('load_session', { path })
      const validLaps = session.laps
        .filter(l => l.is_valid)
        .slice(0, 4)
        .map(l => l.lap_number)
      set({ session, selectedLaps: validLaps, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  toggleLap: (lapNumber: number) => {
    const { selectedLaps } = get()
    if (selectedLaps.includes(lapNumber)) {
      set({ selectedLaps: selectedLaps.filter(n => n !== lapNumber) })
    } else {
      set({ selectedLaps: [...selectedLaps, lapNumber] })
    }
  },

  selectAllLaps: () => {
    const { session } = get()
    if (!session) return
    set({ selectedLaps: session.laps.map(l => l.lap_number) })
  },
}))
