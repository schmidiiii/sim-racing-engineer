// Does the stored track actually contain the car?
//
// Comparing the driven line to the centreline in metres is not the test that
// matters — a racing line is supposed to leave the middle. The test is whether
// the car stays inside the width stored for that spot.
import fs from 'node:fs'
const trackFile = process.argv[2] || 'src/data/tracks/523.json'
const ibt = process.argv[3] || 'C:/Users/schmi/Documents/iRacing/telemetry/toyotagr86_spa 2024 up 2026-07-19 17-05-20.ibt'
const T = JSON.parse(fs.readFileSync(trackFile, 'utf8'))
const fd = fs.openSync(ibt, 'r'), st = fs.fstatSync(fd)
const h = Buffer.alloc(112); fs.readSync(fd, h, 0, 112, 0)
const nv = h.readInt32LE(24), vho = h.readInt32LE(28), bl = h.readInt32LE(36), bo = h.readInt32LE(52)
const vh = Buffer.alloc(nv * 144); fs.readSync(fd, vh, 0, vh.length, vho)
const V = {}
for (let i = 0; i < nv; i++) { const o = i * 144
  const n = vh.toString('latin1', o + 16, o + 48).replace(/\0.*/, '')
  if (['Lat','Lon','Speed','Lap','LapDistPct','OnPitRoad'].includes(n)) V[n] = { t: vh.readInt32LE(o), o: vh.readInt32LE(o + 4) } }
const rd = (b, v) => v.t === 5 ? b.readDoubleLE(v.o) : v.t === 4 ? b.readFloatLE(v.o) : v.t === 1 ? b.readUInt8(v.o) : b.readInt32LE(v.o)
const nS = Math.floor((st.size - bo) / bl), buf = Buffer.alloc(bl), by = {}
for (let s = 0; s < nS; s += 2) { fs.readSync(fd, buf, 0, bl, bo + s * bl)
  if (rd(buf, V.Speed) < 15) continue
  if (V.OnPitRoad && rd(buf, V.OnPitRoad)) continue
  ;(by[rd(buf, V.Lap)] ||= []).push({ lat: rd(buf, V.Lat), lon: rd(buf, V.Lon), pct: rd(buf, V.LapDistPct) }) }
fs.closeSync(fd)
const laps = Object.entries(by).filter(([, p]) => p.length > 400 &&
  Math.max(...p.map(q => q.pct)) - Math.min(...p.map(q => q.pct)) > 0.98).sort((a, b) => b[1].length - a[1].length)
if (!laps.length) { console.log('no complete clean lap in that file'); process.exit(0) }
const L = laps[0][1]

const K = 111320, cs = Math.cos(L[0].lat * Math.PI / 180)
const XY = q => ({ x: q.lon * K * cs, y: q.lat * K })
const C = T.centreline.map(([la, lo]) => XY({ lat: la, lon: lo }))
const hasEdges = !!T.edgeLeft
const halfL = i => hasEdges ? T.edgeLeft[i] : (T.halfWidth ? T.halfWidth[i] : T.width / 2)
const halfR = i => hasEdges ? T.edgeRight[i] : (T.halfWidth ? T.halfWidth[i] : T.width / 2)

let off = 0, worstOut = 0, worstAt = 0
const bins = new Array(20).fill(0), binsN = new Array(20).fill(0)
for (const q of L) {
  const P = XY(q)
  let bi = 0, bd = Infinity
  for (let i = 0; i < C.length; i++) {
    const d = (C[i].x - P.x) ** 2 + (C[i].y - P.y) ** 2
    if (d < bd) { bd = d; bi = i }
  }
  const a = C[(bi - 2 + C.length) % C.length], b = C[(bi + 2) % C.length]
  const tx = b.x - a.x, ty = b.y - a.y
  const l = Math.hypot(tx, ty) || 1
  const lateral = ((P.x - C[bi].x) * -ty + (P.y - C[bi].y) * tx) / l
  const limit = lateral > 0 ? halfL(bi) : halfR(bi)
  const over = Math.abs(lateral) - limit
  const k = Math.min(19, Math.floor(q.pct * 20))
  binsN[k]++
  if (over > 0) { off++; bins[k]++; if (over > worstOut) { worstOut = over; worstAt = q.pct } }
}
console.log(`${T.displayName} — ${T.centreline.length} points, ${hasEdges ? 'per-point left/right widths' : 'single width'}`)
console.log(`checked ${L.length} samples of one clean racing lap\n`)
console.log(`car drawn OUTSIDE the stored track: ${(off / L.length * 100).toFixed(1)}% of the lap`)
console.log(`worst overshoot ${worstOut.toFixed(1)} m at ${(worstAt * 100).toFixed(0)}% of the lap\n`)
console.log(' lap %    outside')
for (let i = 0; i < 20; i++) {
  if (!binsN[i]) continue
  const p = bins[i] / binsN[i] * 100
  console.log(`  ${String(i * 5).padStart(3)}-${String(i * 5 + 5).padStart(3)}%  ${p.toFixed(0).padStart(4)}%  ${'#'.repeat(Math.round(p / 4))}`)
}
