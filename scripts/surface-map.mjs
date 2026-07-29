// What each PlayerTrackSurfaceMaterial value means, worked out from geometry.
//
// iRacing labels the surface under the car but not what the numbers stand for.
// The stored centreline settles it: measure how far off centre the car is for
// each value and compare against the track's own half width. Tarmac sits inside
// it, kerbs just beyond the painted edge, run-off further out again.
import fs from 'node:fs'

const [trackFile, ibt] = process.argv.slice(2)
const T = JSON.parse(fs.readFileSync(trackFile, 'utf8'))
const fd = fs.openSync(ibt, 'r'), st = fs.fstatSync(fd)
const h = Buffer.alloc(112); fs.readSync(fd, h, 0, 112, 0)
const nv = h.readInt32LE(24), vho = h.readInt32LE(28), bl = h.readInt32LE(36), bo = h.readInt32LE(52)
const vh = Buffer.alloc(nv * 144); fs.readSync(fd, vh, 0, vh.length, vho)
const V = {}
for (let i = 0; i < nv; i++) {
  const o = i * 144
  const n = vh.toString('latin1', o + 16, o + 48).replace(/\0.*/, '')
  if (['Lat','Lon','Speed','LapDistPct','OnPitRoad','PlayerTrackSurfaceMaterial'].includes(n))
    V[n] = { t: vh.readInt32LE(o), o: vh.readInt32LE(o + 4) }
}
const rd = (b, v) => v.t === 5 ? b.readDoubleLE(v.o) : v.t === 4 ? b.readFloatLE(v.o)
                   : v.t === 1 ? b.readUInt8(v.o) : b.readInt32LE(v.o)
const nS = Math.floor((st.size - bo) / bl), buf = Buffer.alloc(bl)
const rows = []
for (let s = 0; s < nS; s += 2) {
  fs.readSync(fd, buf, 0, bl, bo + s * bl)
  if (rd(buf, V.Speed) < 15) continue
  if (V.OnPitRoad && rd(buf, V.OnPitRoad)) continue
  rows.push({ lat: rd(buf, V.Lat), lon: rd(buf, V.Lon), m: rd(buf, V.PlayerTrackSurfaceMaterial) })
}
fs.closeSync(fd)

const K = 111320, cs = Math.cos(T.centreline[0][0] * Math.PI / 180)
const C = T.centreline.map(([la, lo]) => ({ x: lo * K * cs, y: la * K }))
const halfL = i => T.edgeLeft ? T.edgeLeft[i] : T.width / 2
const halfR = i => T.edgeRight ? T.edgeRight[i] : T.width / 2

const byMat = {}
for (const r of rows) {
  const P = { x: r.lon * K * cs, y: r.lat * K }
  let bi = 0, bd = Infinity
  for (let i = 0; i < C.length; i++) {
    const d = (C[i].x - P.x) ** 2 + (C[i].y - P.y) ** 2
    if (d < bd) { bd = d; bi = i }
  }
  const a = C[(bi - 2 + C.length) % C.length], b = C[(bi + 2) % C.length]
  const tx = b.x - a.x, ty = b.y - a.y, l = Math.hypot(tx, ty) || 1
  const lateral = ((P.x - C[bi].x) * -ty + (P.y - C[bi].y) * tx) / l
  // How far past the painted edge, in metres. Negative = still on the tarmac.
  const past = Math.abs(lateral) - (lateral > 0 ? halfL(bi) : halfR(bi))
  ;(byMat[r.m] ||= []).push(past)
}
const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1]
console.log(`${T.displayName} — ${rows.length} on-track samples\n`)
console.log('  value   share    distance past the painted edge (m)')
console.log('                   p25     median     p75      max')
for (const [m, arr] of Object.entries(byMat).sort((a, b) => b[1].length - a[1].length)) {
  const s = arr.slice().sort((x, y) => x - y)
  const q = p => s[Math.floor(s.length * p)]
  console.log(`  ${String(m).padStart(5)}  ${(arr.length / rows.length * 100).toFixed(2).padStart(6)}%  `
    + `${q(0.25).toFixed(1).padStart(6)}  ${med(arr).toFixed(1).padStart(7)}  `
    + `${q(0.75).toFixed(1).padStart(7)}  ${s[s.length - 1].toFixed(1).padStart(7)}`)
}
console.log('\n  negative = inside the painted edge, positive = beyond it')
