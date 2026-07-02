export default function Viewer() {
  return (
    <div className="flex h-full gap-0">
      {/* Left: Lap Sidebar */}
      <aside className="w-48 shrink-0 border-r border-border p-3 overflow-y-auto">
        <p className="text-xs text-muted-foreground font-medium mb-2 uppercase tracking-wider">Laps</p>
        <p className="text-xs text-muted-foreground">Loading…</p>
      </aside>

      {/* Center: Telemetry + Track Map */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-hidden p-3">
          <p className="text-xs text-muted-foreground">Telemetry traces</p>
        </div>
        <div className="h-64 border-t border-border p-3 shrink-0">
          <p className="text-xs text-muted-foreground">Track map</p>
        </div>
      </div>

      {/* Right: AI Panel */}
      <aside className="w-72 shrink-0 border-l border-border p-3 flex flex-col overflow-hidden">
        <p className="text-xs text-muted-foreground font-medium mb-2 uppercase tracking-wider">AI Coach</p>
        <div className="flex-1 overflow-y-auto">
          <p className="text-xs text-muted-foreground">Analysis will appear here…</p>
        </div>
      </aside>
    </div>
  )
}
