import { useRef, useState, useEffect } from 'react'
import { DEFAULT_ACCENT, hexToHsl, hslToHex } from '@/lib/accent'
import { useT } from '@/lib/i18n'

const SIZE = 132          // wheel diameter in px
const R = SIZE / 2

/** Hue round the rim, saturation out from the middle, lightness on the slider
 *  below. The wheel is painted at 50% lightness — the shade you are picking
 *  from — and the swatch beside it shows what you actually get. */
export default function AccentPicker({ value, onChange }: {
  value: string
  onChange: (hex: string) => void
}) {
  const t = useT()
  const wheelRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const { h, s, l } = hexToHsl(value)

  // Typed by hand, so it may be half-finished and cannot drive the wheel yet
  const [hexDraft, setHexDraft] = useState(value)
  useEffect(() => { setHexDraft(value) }, [value])

  const pick = (clientX: number, clientY: number) => {
    const el = wheelRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const dx = clientX - (rect.left + rect.width / 2)
    const dy = clientY - (rect.top + rect.height / 2)
    const dist = Math.hypot(dx, dy)
    const sat = Math.min(1, dist / (rect.width / 2))
    // 0° at twelve o'clock, running clockwise — the same way the wheel is painted
    const hue = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360
    onChange(hslToHex({ h: hue, s: sat * 100, l }))
  }

  useEffect(() => {
    const move = (e: PointerEvent) => { if (draggingRef.current) pick(e.clientX, e.clientY) }
    const up = () => { draggingRef.current = false }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    return () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
    }
  })

  // Marker: hue as the angle, saturation as the distance out
  const rad = h * Math.PI / 180
  const mx = R + Math.sin(rad) * R * (s / 100)
  const my = R - Math.cos(rad) * R * (s / 100)

  return (
    <div className="flex items-center gap-4">
      <div
        ref={wheelRef}
        onPointerDown={e => { draggingRef.current = true; pick(e.clientX, e.clientY) }}
        className="relative shrink-0 rounded-full cursor-crosshair touch-none"
        style={{
          width: SIZE, height: SIZE,
          background:
            'radial-gradient(circle closest-side, #fff 0%, rgba(255,255,255,0) 70%), ' +
            'conic-gradient(hsl(0 100% 50%), hsl(60 100% 50%), hsl(120 100% 50%), ' +
            'hsl(180 100% 50%), hsl(240 100% 50%), hsl(300 100% 50%), hsl(360 100% 50%))',
          boxShadow: 'inset 0 0 0 1px hsl(var(--border))',
        }}
      >
        <span
          className="absolute w-3.5 h-3.5 rounded-full border-2 border-white pointer-events-none"
          style={{
            left: mx, top: my, transform: 'translate(-50%, -50%)',
            background: value, boxShadow: '0 0 0 1px rgba(0,0,0,0.45)',
          }}
        />
      </div>

      <div className="flex-1 min-w-0 space-y-3">
        {/* Lightness. Bounded well short of black and white, where a hue stops
            being a colour and the accent stops being visible on the panel. */}
        <input
          type="range" min={22} max={72} value={Math.round(l)}
          onChange={e => onChange(hslToHex({ h, s, l: Number(e.target.value) }))}
          className="accent-slider w-full h-2 appearance-none rounded-full cursor-pointer"
          style={{
            background: `linear-gradient(to right, ${hslToHex({ h, s, l: 22 })}, ${hslToHex({ h, s, l: 47 })}, ${hslToHex({ h, s, l: 72 })})`,
          }}
        />

        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg shrink-0 border border-border" style={{ background: value }} />
          <input
            value={hexDraft}
            onChange={e => {
              const v = e.target.value
              setHexDraft(v)
              if (/^#[0-9a-f]{6}$/i.test(v.trim())) onChange(v.trim().toUpperCase())
            }}
            spellCheck={false}
            className="w-24 bg-input text-foreground text-xs font-mono rounded-lg px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            onClick={() => onChange(DEFAULT_ACCENT)}
            className="text-xs font-medium px-2.5 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            {t('accentColorReset')}
          </button>
        </div>
      </div>
    </div>
  )
}
