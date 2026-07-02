import { useMemo } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from 'recharts'
import { getLapColor } from '@/store/session'

export interface LapTrace {
  lapNumber: number
  colorIndex: number
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
  const base = traces.reduce((a, b) => a.timestamps.length >= b.timestamps.length ? a : b)
  return base.timestamps.map((t, i) => {
    const point: Record<string, number> = { t }
    for (const trace of traces) {
      const idx = Math.min(i, trace.samples.length - 1)
      if (idx >= 0) {
        point[`t_${trace.colorIndex}`] = trace.samples[idx]
      }
    }
    return point
  })
}

export default function TraceChart({ channel, unit, traces, crosshairTime, onMouseMove, height = 100 }: Props) {
  const data = useMemo(() => buildChartData(traces), [traces])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleMouseMove = (e: any) => {
    if (e?.activeLabel != null) onMouseMove(Number(e.activeLabel))
  }

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
          onMouseLeave={() => onMouseMove(null)}
        >
          <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} hide />
          <YAxis width={36} tick={{ fontSize: 9, fill: '#6b7280' }} tickLine={false} axisLine={false} />
          <Tooltip contentStyle={{ display: 'none' }} cursor={false} />
          {traces.map(trace => (
            <Line
              key={trace.colorIndex}
              type="monotone"
              dataKey={`t_${trace.colorIndex}`}
              stroke={getLapColor(trace.colorIndex)}
              dot={false}
              strokeWidth={1.5}
              isAnimationActive={false}
            />
          ))}
          {crosshairTime != null && (
            <ReferenceLine x={crosshairTime} stroke="#ffffff40" strokeWidth={1} />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
