import { pickSource, fetchTile, sampleSmooth, luminance, findPaintedEdge, EARTH } from './lib/ortho.mjs'
import fs from 'node:fs'
const CACHE = 'scripts/.ortho-cache'
const t = JSON.parse(fs.readFileSync('src/data/tracks/523.json', 'utf8'))
const C = t.centreline
const frac = Number(process.argv[2] ?? 0.22)
const START = Math.round(C.length * frac) % C.length
const [lat0, lon0] = C[START]
const src = pickSource(lat0, lon0)
const d = 0.0016
const bbox = [lon0 - d, lat0 - d * 0.64, lon0 + d, lat0 + d * 0.64]
const tile = await fetchTile(src, bbox, 800, 800, CACHE)
const cs = Math.cos(lat0 * Math.PI / 180)
const STEP = 0.1, REACH = 14, MIN_HALF = 3.0, MAX_HALF = 11

const measure = i => {
  const a = C[(i - 3 + C.length) % C.length], b = C[(i + 3) % C.length]
  const tx = (b[1] - a[1]) * cs, ty = (b[0] - a[0])
  const l = Math.hypot(tx, ty) || 1
  const px = -ty / l, py = tx / l
  const side = dir => {
    const prof = []
    for (let m = 0; m <= REACH; m += STEP) {
      const c = sampleSmooth(tile, C[i][0] + py * dir * m / EARTH, C[i][1] + px * dir * m / (EARTH * cs))
      if (!c) return null
      prof.push(luminance(c))
    }
    return findPaintedEdge(prof, STEP, MIN_HALF, MAX_HALF)
  }
  const L = side(1), R = side(-1)
  // The ridge contrast doubles as a confidence measure: where the white line is
  // genuinely visible it comes out around 100, and where the search has latched
  // onto a random bright patch it stays under 30. Measurements below the
  // threshold scatter by six metres, so they are worth nothing.
  const MIN_RIDGE = 50
  if (!L || !R || L.ridge < MIN_RIDGE || R.ridge < MIN_RIDGE) return null
  return { L, R }
}

console.log(`${src.name}  —  lap position ${(frac * 100).toFixed(0)}%\n`)
console.log(' idx    left    right    width   centre shift   ridge contrast')
const ws = [], sh = []
let n = 0, miss = 0
for (let i = 0; i < C.length && n < 16; i++) {
  const [la, lo] = C[i]
  if (la < bbox[1] + 0.0004 || la > bbox[3] - 0.0004 || lo < bbox[0] + 0.0004 || lo > bbox[2] - 0.0004) continue
  const r = measure(i)
  n++
  if (!r) { miss++; console.log(String(i).padStart(4) + '    (outside the tile)'); continue }
  const w = r.L.at + r.R.at, shift = (r.L.at - r.R.at) / 2
  ws.push(w); sh.push(shift)
  console.log(String(i).padStart(4) + '  ' + r.L.at.toFixed(1).padStart(5) + ' m  ' + r.R.at.toFixed(1).padStart(5) + ' m  '
    + w.toFixed(1).padStart(6) + ' m   ' + ((shift >= 0 ? '+' : '') + shift.toFixed(1) + ' m').padStart(11)
    + '     ' + r.L.ridge.toFixed(0).padStart(3) + ' / ' + r.R.ridge.toFixed(0).padStart(3))
}
const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1]
if (ws.length) {
  console.log(`\nmeasured ${ws.length} of ${n} points`)
  console.log(`median width ${med(ws).toFixed(1)} m,  spread ${Math.min(...ws).toFixed(1)}-${Math.max(...ws).toFixed(1)} m`)
  console.log(`median centre correction ${med(sh.map(Math.abs)).toFixed(1)} m, largest ${Math.max(...sh.map(Math.abs)).toFixed(1)} m`)
}
