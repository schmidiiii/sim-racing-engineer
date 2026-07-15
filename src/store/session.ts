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
  '#64AAB2', // EOS Teal
  '#F43F5E', // Rose
  '#FBBF24', // Amber
  '#818CF8', // Indigo
  '#34D399', // Emerald
  '#FB923C', // Orange
  '#38BDF8', // Sky
  '#E879F9', // Fuchsia
]

export const getLapColor = (colorIndex: number) => LAP_COLORS[colorIndex % LAP_COLORS.length]

interface SessionStore {
  sessions: Session[]
  activeSessionId: string | null
  setActiveSessionId: (id: string) => void
  removeSession: (id: string) => void
  selectedLapKeys: string[]
  loading: boolean
  error: string | null
  crosshairTime: number | null
  setCrosshairTime: (t: number | null) => void
  zoomDomain: [number, number] | null
  setZoomDomain: (domain: [number, number] | null) => void
  sidebarMapExpanded: boolean
  setSidebarMapExpanded: (v: boolean) => void
  activeTabLabel: string
  setActiveTabLabel: (label: string) => void
  autoLoad: boolean
  setAutoLoad: (v: boolean) => void
  lapMapFullscreen: boolean
  setLapMapFullscreen: (v: boolean) => void
  loadLatest: () => Promise<void>
  loadFiles: (paths: string[]) => Promise<void>
  toggleLap: (sessionId: string, lapNumber: number) => void
  lapColorIndex: (key: string) => number
}

export const MAX_ACTIVE_SESSIONS = 5

function pickDefaultLaps(sessions: Session[], existingKeys: string[]): string[] {
  // Pick the 2 fastest valid laps from the last MAX_ACTIVE_SESSIONS sessions
  const keys: string[] = []
  const recent = sessions.slice(-MAX_ACTIVE_SESSIONS)
  for (const session of recent) {
    const best2 = session.laps
      .filter(l => l.is_valid && l.lap_time > 10)
      .sort((a, b) => a.lap_time - b.lap_time)
      .slice(0, 2)
    for (const lap of best2) {
      const k = lapKey(session.id, lap.lap_number)
      if (!existingKeys.includes(k)) keys.push(k)
    }
  }
  return keys
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  selectedLapKeys: [],
  loading: false,
  error: null,
  crosshairTime: null,
  setCrosshairTime: (t) => set({ crosshairTime: t }),

  zoomDomain: null,
  setZoomDomain: (domain) => set({ zoomDomain: domain }),

  sidebarMapExpanded: false,
  setSidebarMapExpanded: (v) => set({ sidebarMapExpanded: v }),

  activeTabLabel: 'General',
  setActiveTabLabel: (label) => set({ activeTabLabel: label }),

  autoLoad: localStorage.getItem('srAutoLoad') !== 'false',
  setAutoLoad: (v) => { localStorage.setItem('srAutoLoad', String(v)); set({ autoLoad: v }) },

  lapMapFullscreen: false,
  setLapMapFullscreen: (v) => set({ lapMapFullscreen: v }),

  setActiveSessionId: (id) => {
    const { sessions } = get()
    const session = sessions.find(s => s.id === id)
    if (!session) return
    const newKeys = session.laps
      .filter(l => l.is_valid && l.lap_time > 10)
      .sort((a, b) => a.lap_time - b.lap_time)
      .slice(0, 2)
      .map(l => lapKey(id, l.lap_number))
    set({ activeSessionId: id, selectedLapKeys: newKeys })
  },

  removeSession: (id) => {
    const { sessions, activeSessionId, selectedLapKeys } = get()
    const remaining = sessions.filter(s => s.id !== id)
    const cleanedKeys = selectedLapKeys.filter(k => !k.startsWith(id + ':'))
    const newActive = activeSessionId === id
      ? (remaining[0]?.id ?? null)
      : activeSessionId
    set({ sessions: remaining, selectedLapKeys: cleanedKeys, activeSessionId: newActive })
  },

  loadLatest: async () => {
    set({ loading: true, error: null })
    try {
      const session = await invoke<Session>('get_latest_session')
      const keys = pickDefaultLaps([session], [])
      set({
        sessions: [session],
        selectedLapKeys: keys,
        activeSessionId: session.id,
        loading: false,
      })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  loadFiles: async (paths: string[]) => {
    set({ loading: true, error: null })
    try {
      const loaded = await Promise.all(
        paths.map(path => invoke<Session>('load_session', { path }))
      )
      set(s => {
        const existingIds = new Set(s.sessions.map(x => x.id))
        const merged = [...s.sessions, ...loaded.filter(x => !existingIds.has(x.id))]
        // Always switch to the newly loaded session — no cross-session auto-selection.
        // The user can manually add laps from other sessions if track+car match.
        const newKeys = pickDefaultLaps(loaded, [])
        return {
          sessions: merged,
          selectedLapKeys: newKeys,
          activeSessionId: loaded[0]?.id ?? s.activeSessionId,
          loading: false,
        }
      })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  toggleLap: (sessionId: string, lapNumber: number) => {
    const key = lapKey(sessionId, lapNumber)
    const { selectedLapKeys, sessions } = get()
    if (selectedLapKeys.includes(key)) {
      set({ selectedLapKeys: selectedLapKeys.filter(k => k !== key) })
      return
    }
    // Cap active sessions at MAX_ACTIVE_SESSIONS — adding a lap from a new session drops the oldest session's laps
    const activeSessionIds = [...new Set(selectedLapKeys.map(k => parseLapKey(k).sessionId))]
    if (!activeSessionIds.includes(sessionId) && activeSessionIds.length >= MAX_ACTIVE_SESSIONS) {
      const oldest = activeSessionIds[0]
      const trimmed = selectedLapKeys.filter(k => parseLapKey(k).sessionId !== oldest)
      set({ selectedLapKeys: [...trimmed, key] })
      return
    }
    // Cross-session guard: only allow if track AND car match all already-selected sessions
    const target = sessions.find(s => s.id === sessionId)
    if (target) {
      const otherIds = new Set(selectedLapKeys.map(k => parseLapKey(k).sessionId).filter(id => id !== sessionId))
      for (const otherId of otherIds) {
        const other = sessions.find(s => s.id === otherId)
        if (other && (other.track !== target.track || other.car !== target.car)) return
      }
    }
    set({ selectedLapKeys: [...selectedLapKeys, key] })
  },

  lapColorIndex: (key: string) => {
    const { selectedLapKeys } = get()
    const idx = selectedLapKeys.indexOf(key)
    return idx >= 0 ? idx : selectedLapKeys.length
  },
}))
