import { useMemo } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from 'recharts'

const LAP_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b',
  '#a855f7', '#ec4899', '#14b8a6', '#f97316',
]

const getLapColor = (n: number) => LAP_COLORS[n % LAP_COLORS.length]

export interface LapTrace {
  lapNumber: number
  samples: number[]
  timestamps: number[]
}

interface Props {
  channel: string
  unit?: string
  traces: LapTrace[]
  crosshairTime: number | null
  onMouseMove: (t: number | null) => void
  height?: number
}

function buildChartData(traces: LapTrace[]) {
  if (traces.length === 0) return []

  // Use the longest trace's timestamps as the x-axis
  const base = traces.reduce((a, b) => a.timestamps.length >= b.timestamps.length ? a : b)

  return base.timestamps.map((t, i) => {
    const point: Record<string, number> = { t }
    for (const trace of traces) {
      // Find closest index in this trace
      const idx = Math.min(i, trace.samples.length - 1)
      if (idx >= 0) {
        point[`lap_${trace.lapNumber}`] = trace.samples[idx]
      }
    }
    return point
  })
}

export default function TraceChart({ channel, unit, traces, crosshairTime, onMouseMove, height = 100 }: Props) {
  const data = useMemo(() => buildChartData(traces), [traces])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleMouseMove = (e: any) => {
    if (e?.activeLabel != null) {
      onMouseMove(Number(e.activeLabel))
    }
  }

  const handleMouseLeave = () => onMouseMove(null)

  return (
    <div className="w-full" style={{ height }}>
      <div className="text-xs text-muted-foreground px-1 mb-0.5">
        {channel}{unit ? ` (${unit})` : ''}
      </div>
      <ResponsiveContainer width="100%" height={height - 18}>
        <LineChart
          data={data}
          margin={{ top: 2, right: 4, left: 0, bottom: 2 }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            hide
          />
          <YAxis
            width={36}
            tick={{ fontSize: 9, fill: '#6b7280' }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            contentStyle={{ display: 'none' }}
            cursor={false}
          />
          {traces.map(trace => (
            <Line
              key={trace.lapNumber}
              type="monotone"
              dataKey={`lap_${trace.lapNumber}`}
              stroke={getLapColor(trace.lapNumber)}
              dot={false}
              strokeWidth={1.5}
              isAnimationActive={false}
            />
          ))}
          {crosshairTime != null && (
            <ReferenceLine
              x={crosshairTime}
              stroke="#ffffff40"
              strokeWidth={1}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
