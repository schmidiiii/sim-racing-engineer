import { useState } from 'react'
import { Button } from '@/components/ui/button'
import Viewer from '@/pages/Viewer'
import Settings from '@/pages/Settings'

type Page = 'viewer' | 'settings'

export default function App() {
  const [page, setPage] = useState<Page>('viewer')

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      <header className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
        <span className="font-semibold text-sm tracking-wide">iRacing Telemetry</span>
        <nav className="flex gap-2">
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
