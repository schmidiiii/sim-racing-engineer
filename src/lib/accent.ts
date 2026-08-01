/** The accent colour — everything the app highlights with. It lives as
 *  `--primary` and `--ring` on the root element, so the whole UI follows from
 *  two variables: `bg-primary`, `text-primary`, focus rings, the chart marks
 *  that read `hsl(var(--primary))`.
 *
 *  The default is also written into index.css, so the app opens in the right
 *  colour before any of this runs. */

export const DEFAULT_ACCENT = '#64AAB2'
const KEY = 'srAccent'

export interface Hsl { h: number; s: number; l: number }

export function hexToHsl(hex: string): Hsl {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hexToHsl(DEFAULT_ACCENT)
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l: l * 100 }
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0))
          : max === g ? (b - r) / d + 2
          :             (r - g) / d + 4
  return { h: h * 60, s: s * 100, l: l * 100 }
}

export function hslToHex({ h, s, l }: Hsl): string {
  const S = s / 100, L = l / 100
  const c = (1 - Math.abs(2 * L - 1)) * S
  const hp = ((h % 360) + 360) % 360 / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] =
      hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = L - c / 2
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${to(r1)}${to(g1)}${to(b1)}`.toUpperCase()
}

/** Perceived brightness, for deciding whether text on the accent is white or
 *  black. The sRGB weights, not a plain average: a saturated green is far
 *  brighter to the eye than a blue of the same lightness. */
function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16)
  const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255)
}

export function loadAccent(): string {
  const saved = localStorage.getItem(KEY)
  return saved && /^#[0-9a-f]{6}$/i.test(saved) ? saved.toUpperCase() : DEFAULT_ACCENT
}

export function saveAccent(hex: string) {
  localStorage.setItem(KEY, hex.toUpperCase())
}

/** Writes the colour onto the root element. Called again whenever the theme is
 *  switched: on a dark background a colour has to sit lighter to read the same,
 *  which is why the built-in light and dark palettes differ in lightness too. */
export function applyAccent(hex: string) {
  const root = document.documentElement
  const dark = root.classList.contains('dark')
  const { h, s, l } = hexToHsl(hex)
  // Dark mode lifts the colour, but never past what the eye takes as pastel,
  // and never lets a colour picked almost black disappear against the panel
  const L = dark ? Math.min(78, Math.max(46, l + 10)) : Math.min(62, Math.max(28, l))
  const shown = hslToHex({ h, s, l: L })

  root.style.setProperty('--primary', `${h.toFixed(0)} ${s.toFixed(0)}% ${L.toFixed(0)}%`)
  root.style.setProperty('--ring', `${h.toFixed(0)} ${s.toFixed(0)}% ${L.toFixed(0)}%`)
  // Labels sit *on* the accent. White holds down to the mid tones — it is what
  // the app has always used and what the default teal is meant to carry — and
  // gives way to near-black only for the genuinely bright picks, a yellow or a
  // pale green, where white would be gone altogether.
  root.style.setProperty('--primary-foreground', luminance(shown) > 0.5 ? '0 0% 10%' : '0 0% 100%')

  // For the parts that cannot follow a CSS variable on their own — the logo,
  // whose arc is painted pixels and has to be recoloured by hand
  window.dispatchEvent(new CustomEvent('sre-accent'))
}
