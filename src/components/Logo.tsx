import { useCallback, useEffect, useRef } from 'react'

/** The logo is a painted PNG, so the red arc round it cannot follow the accent
 *  colour by itself. It is redrawn onto a canvas instead, with the red pixels of
 *  the *outer ring* given the accent's hue and saturation while keeping their
 *  own lightness — which is what preserves the shading and the soft edges.
 *
 *  Only the ring: the red "E" on the shirt and the red traces on the laptop are
 *  part of the picture, not of the branding, and sit well inside it. */

const SRC = '/LogoSRE.png'
// Everything closer to the middle than this fraction of the width is the
// illustration and is left alone. The arc runs at about 0.47.
const RING = 0.36
// A pixel counts as red when the channel dominates by this much
const DOMINANCE = 1.5
const MIN_RED = 90
// Drawn well above its 44px slot so it stays crisp on a high-DPI screen, but
// far below the 1500px original — the recolouring walks every pixel
const SIZE = 160

let cached: Promise<HTMLImageElement> | null = null
function loadLogo(): Promise<HTMLImageElement> {
  cached ??= new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = SRC
  })
  return cached
}

/** The accent as the app currently renders it — read from the variable rather
 *  than from storage, so it carries the light/dark adjustment already applied */
function accentHsl(): { h: number; s: number } {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--primary')
  const m = raw.trim().match(/^([\d.]+)\s+([\d.]+)%/)
  return m ? { h: Number(m[1]), s: Number(m[2]) } : { h: 197, s: 100 }
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const S = s / 100, L = l / 100
  const c = (1 - Math.abs(2 * L - 1)) * S
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r, g, b] =
      hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = L - c / 2
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

export default function Logo({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)

  const paint = useCallback(async () => {
    const img = await loadLogo()
    const canvas = ref.current
    if (!canvas) return
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.clearRect(0, 0, SIZE, SIZE)
    ctx.drawImage(img, 0, 0, SIZE, SIZE)

    const { h, s } = accentHsl()
    const data = ctx.getImageData(0, 0, SIZE, SIZE)
    const px = data.data
    const mid = SIZE / 2
    const ringSq = (RING * SIZE) ** 2

    for (let y = 0; y < SIZE; y++) {
      const dy = y - mid
      for (let x = 0; x < SIZE; x++) {
        const dx = x - mid
        if (dx * dx + dy * dy < ringSq) continue
        const i = (y * SIZE + x) * 4
        if (px[i + 3] < 8) continue
        const r = px[i], g = px[i + 1], b = px[i + 2]
        if (r < MIN_RED || r < g * DOMINANCE || r < b * DOMINANCE) continue
        // Its own lightness, the accent's colour
        const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255 * 100
        const [nr, ng, nb] = hslToRgb(h, s, l)
        px[i] = nr; px[i + 1] = ng; px[i + 2] = nb
      }
    }
    ctx.putImageData(data, 0, 0)
  }, [])

  useEffect(() => {
    paint()
    // Repainted when the colour is picked, and when the theme shifts its
    // lightness — both write the variable this reads
    const onAccent = () => { paint() }
    window.addEventListener('sre-accent', onAccent)
    return () => window.removeEventListener('sre-accent', onAccent)
  }, [paint])

  return <canvas ref={ref} className={className} aria-label="Sim Racing Engineer" role="img" />
}
