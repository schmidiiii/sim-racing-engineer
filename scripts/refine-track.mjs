// Refine a stored track with aerial imagery.
//
// build-track.mjs gets the shape from OpenStreetMap, which knows where the
// circuit runs but not how wide it is — and around the pits its naming is
// muddled enough that the line drifts off the tarmac. Official orthophotos
// settle both. At 28 cm per pixel the painted edge line is only about half a
// pixel wide, but it still lifts the pixels it touches clear of the tarmac, so
// the edge can be found as a brightness ridge. Asphalt-versus-grass would not
// work: modern runoff is asphalt too, so there is no material change to find.
//
//   node scripts/refine-track.mjs src/data/tracks/523.json
//
// Adds `halfWidth` (metres per centreline point) and nudges the centreline onto
// the measured centre of the track. Points where the imagery gives no confident
// reading keep the OSM position and take the width of their neighbours.

import fs from 'node:fs'
import { pickSource, fetchTile, sampleSmooth, luminance, findPaintedEdge, EARTH } from './lib/ortho.mjs'

const CACHE = 'scripts/.ortho-cache'
const TILE_PX = 800
const TILE_SPAN = 0.0016        // degrees of longitude either side of centre
const STEP = 0.1                // profile sampling, metres
const REACH = 14
const MIN_HALF = 3.0, MAX_HALF = 11
const MIN_RIDGE = 50            // below this the reading scatters by metres
const SMOOTH = 4                // stations either side, for the median filter

const file = process.argv[2]
if (!file) { console.error('usage: node scripts/refine-track.mjs <track json>'); process.exit(1) }
const track = JSON.parse(fs.readFileSync(file, 'utf8'))
const C = track.centreline
const src = pickSource(C[0][0], C[0][1])
if (!src) { console.error('no open imagery source covers this track'); process.exit(1) }
console.log(`${track.displayName} — ${C.length} points`)
console.log(`imagery: ${src.name}\n`)

const cs = Math.cos(C[0][0] * Math.PI / 180)

// Cover the lap with tiles: walk the centreline and start a new one whenever the
// next point would fall near the edge of the current tile.
const tiles = []
{
  let cur = null
  for (const [lat, lon] of C) {
    const inside = cur && lat > cur.bbox[1] + 0.0004 && lat < cur.bbox[3] - 0.0004
                       && lon > cur.bbox[0] + 0.0004 && lon < cur.bbox[2] - 0.0004
    if (inside) continue
    cur = { bbox: [lon - TILE_SPAN, lat - TILE_SPAN * 0.64, lon + TILE_SPAN, lat + TILE_SPAN * 0.64] }
    tiles.push(cur)
  }
}
console.log(`fetching ${tiles.length} tiles…`)
let failed = 0
for (const [n, t] of tiles.entries()) {
  try { t.tile = await fetchTile(src, t.bbox, TILE_PX, TILE_PX, CACHE) }
  catch (e) { failed++; if (failed < 3) console.log('  ' + e.message.slice(0, 100)) }
  if ((n + 1) % 10 === 0 || n === tiles.length - 1) process.stdout.write(`  ${n + 1}/${tiles.length}\r`)
}
console.log(`\n${tiles.filter(t => t.tile).length} tiles ready${failed ? `, ${failed} failed` : ''}\n`)

const tileFor = (lat, lon) => {
  for (const t of tiles) {
    if (!t.tile) continue
    const [w, s, e, n] = t.bbox
    if (lat > s + 0.0004 && lat < n - 0.0004 && lon > w + 0.0004 && lon < e - 0.0004) return t.tile
  }
  return null
}

const measure = i => {
  const [lat, lon] = C[i]
  const tile = tileFor(lat, lon)
  if (!tile) return null
  const a = C[(i - 3 + C.length) % C.length], b = C[(i + 3) % C.length]
  const tx = (b[1] - a[1]) * cs, ty = (b[0] - a[0])
  const l = Math.hypot(tx, ty) || 1
  const px = -ty / l, py = tx / l
  const side = dir => {
    const prof = []
    for (let m = 0; m <= REACH; m += STEP) {
      const c = sampleSmooth(tile, lat + py * dir * m / EARTH, lon + px * dir * m / (EARTH * cs))
      if (!c) return null
      prof.push(luminance(c))
    }
    return findPaintedEdge(prof, STEP, MIN_HALF, MAX_HALF)
  }
  const L = side(1), R = side(-1)
  // The ridge height doubles as a confidence measure: a real painted edge scores
  // around 100, a chance bright patch under 30, and readings below the threshold
  // scatter by six metres — worth nothing.
  if (!L || !R || L.ridge < MIN_RIDGE || R.ridge < MIN_RIDGE) return null
  return { left: L.at, right: R.at, perp: { px, py } }
}

const raw = C.map((_, i) => measure(i))
const got = raw.filter(Boolean).length
console.log(`measured ${got} of ${C.length} points (${(got / C.length * 100).toFixed(0)}%)`)

// Median filter, then fill gaps from the neighbours: a single stray reading
// cannot pull the track out of shape, and a stretch with no reading keeps the
// OSM position rather than inventing one.
const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1]
const halfWidth = [], shift = []
for (let i = 0; i < C.length; i++) {
  const win = []
  for (let k = i - SMOOTH; k <= i + SMOOTH; k++) {
    const r = raw[(k + C.length) % C.length]
    if (r) win.push(r)
  }
  if (!win.length) { halfWidth.push(null); shift.push(0); continue }
  halfWidth.push(med(win.map(r => (r.left + r.right) / 2)))
  shift.push(raw[i] ? med(win.map(r => (r.left - r.right) / 2)) : 0)
}
// Any point still without a width takes the track's median
const known = halfWidth.filter(Boolean)
if (!known.length) {
  console.error('no usable readings — leaving the track as it was')
  process.exit(1)
}
const fallback = med(known)
for (let i = 0; i < halfWidth.length; i++) if (halfWidth[i] == null) halfWidth[i] = fallback

const moved = []
const out = C.map(([lat, lon], i) => {
  const r = raw[i]
  if (!r || !shift[i]) return [lat, lon]
  moved.push(Math.abs(shift[i]))
  return [
    +(lat + r.perp.py * shift[i] / EARTH).toFixed(7),
    +(lon + r.perp.px * shift[i] / (EARTH * cs)).toFixed(7),
  ]
})

const ws = halfWidth.map(h => h * 2)
console.log(`track width: median ${med(ws).toFixed(1)} m, ` +
            `${Math.min(...ws).toFixed(1)}–${Math.max(...ws).toFixed(1)} m  (was a flat ${track.width} m)`)
if (moved.length) console.log(`centreline moved at ${moved.length} points: median ${med(moved).toFixed(2)} m, largest ${Math.max(...moved).toFixed(2)} m`)

track.centreline = out
// The measured median replaces the guessed 12 m. The per-point figures are kept
// too, but the viewer does not shape the road with them yet: on Spa the widest
// 5% read 17-20 m, which the circuit never is — the search reaches through into
// the asphalt runoff, where there is no painted edge to stop at. Worth storing,
// not yet worth trusting.
track.width = +med(ws).toFixed(1)
track.halfWidth = halfWidth.map(h => +h.toFixed(2))
track.imagery = src.name
fs.writeFileSync(file, JSON.stringify(track))
console.log(`\nwritten -> ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} kB)`)
