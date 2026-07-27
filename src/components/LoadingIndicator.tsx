// Shared loading visual. Parsing a 100 MB telemetry file takes a few seconds, and
// a bare line of text left it looking like the app had stalled — this at least
// shows something is still happening.

export function Spinner({ size = 16 }: { size?: number }) {
  const stroke = Math.max(1.5, size / 10)
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0" aria-hidden>
      <circle
        cx="12" cy="12" r="9" fill="none" strokeWidth={stroke}
        stroke="currentColor" opacity="0.18"
      />
      {/* Rotating arc — one turn per second */}
      <path
        d="M21 12a9 9 0 0 0-9-9" fill="none" strokeWidth={stroke}
        stroke="currentColor" strokeLinecap="round"
      >
        <animateTransform
          attributeName="transform" type="rotate"
          from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"
        />
      </path>
    </svg>
  )
}

// Full-area version for empty panels, with a car sweeping along a track line
export default function LoadingIndicator({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 text-center">
      <svg width="120" height="34" viewBox="0 0 120 34" aria-hidden>
        {/* track */}
        <path
          d="M8 24 C 26 24, 30 10, 48 10 S 74 24, 92 24 L112 24"
          fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" className="text-muted-foreground/25"
        />
        {/* car running the line, then looping back */}
        <g className="text-primary">
          <rect x="-5" y="-3" width="10" height="6" rx="1.6" fill="currentColor">
            <animateMotion
              dur="1.8s" repeatCount="indefinite" rotate="auto"
              path="M8 24 C 26 24, 30 10, 48 10 S 74 24, 92 24 L112 24"
            />
          </rect>
        </g>
      </svg>
      <div>
        <p className="text-xs font-medium text-foreground">{label}</p>
        {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
      </div>
    </div>
  )
}
