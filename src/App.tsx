import { useState } from 'react'
import Viewer from '@/pages/Viewer'
import Settings from '@/pages/Settings'

type Page = 'viewer' | 'settings'

const NAV: { id: Page; label: string }[] = [
  { id: 'viewer', label: 'Telemetry' },
  { id: 'settings', label: 'Settings' },
]

export default function App() {
  const [page, setPage] = useState<Page>('viewer')

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      <header className="shrink-0 border-b border-border bg-card">
        <div className="px-5 py-3 flex items-center gap-3">
          <span className="font-semibold text-sm text-foreground tracking-tight">iRacing Telemetry</span>
        </div>
        <nav className="px-5 flex items-end gap-0.5">
          {NAV.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setPage(id)}
              className={`px-4 py-2 text-xs font-semibold border-b-2 -mb-px transition-colors ${
                page === id
                  ? 'border-racing-amber text-racing-amber'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      <main className="flex-1 overflow-hidden">
        {page === 'viewer' ? <Viewer /> : <Settings />}
      </main>
    </div>
  )
}
