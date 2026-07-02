import { useState } from 'react'
import { Button } from '@/components/ui/button'
import Viewer from '@/pages/Viewer'
import Settings from '@/pages/Settings'

type Page = 'viewer' | 'settings'

export default function App() {
  const [page, setPage] = useState<Page>('viewer')

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      <header className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0 bg-background/80 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          <span className="font-semibold text-sm tracking-tight">iRacing Telemetry</span>
        </div>
        <nav className="flex gap-1">
          <Button
            variant={page === 'viewer' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setPage('viewer')}
          >
            Viewer
          </Button>
          <Button
            variant={page === 'settings' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setPage('settings')}
          >
            Settings
          </Button>
        </nav>
      </header>
      <main className="flex-1 overflow-hidden">
        {page === 'viewer' ? <Viewer /> : <Settings />}
      </main>
    </div>
  )
}
