// Before-and-after for the width margin, across every stored track.
import fs from 'node:fs'
const dir = 'C:/Users/schmi/Documents/iRacing/telemetry/'
const buildable = JSON.parse(fs.readFileSync('scripts/.buildable.json', 'utf8'))

function lapOf(file) {
  const fd = fs.openSync(dir + file, 'r'), st = fs.fstatSync(fd)
  const h = Buffer.alloc(112); fs.readSync(fd, h, 0, 112, 0)
  const nv = h.readInt32LE(24), vho = h.readInt32LE(28), bl = h.readInt32LE(36), bo = h.readInt32LE(52)
  const vh = Buffer.alloc(nv * 144); fs.readSync(fd, vh, 0, vh.length, vho)
  const V = {}
  for (let i = 0; i < nv; i++) {
    const o = i * 144
    const n = vh.toString('latin1', o + 16, o + 48).replace(/\0.*/, '')
    if (['Lat','Lon','Speed','Lap','LapDistPct','OnPitRoad'].includes(n)) V[n] = { t: vh.readInt32LE(o), o: vh.readInt32LE(o + 4) }
  }
  const rd = (b, v) => v.t === 5 ? b.readDoubleLE(v.o) : v.t === 4 ? b.readFloatLE(v.o)
                     : v.t === 1 ? b.readUInt8(v.o) : b.readInt32LE(v.o)
  const nS = Math.floor((st.size - bo) / bl), buf = Buffer.alloc(bl), by = {}
  for (let s = 0; s < nS; s += 4) {
    fs.readSync(fd, buf, 0, bl, bo + s * bl)
    if (rd(buf, V.Speed) < 15) continue
    if (V.OnPitRoad && rd(buf, V.OnPitRoad)) continue
    ;(by[rd(buf, V.Lap)] ||= []).push({ lat: rd(buf, V.Lat), lon: rd(buf, V.Lon), pct: rd(buf, V.LapDistPct) })
  }
  fs.closeSync(fd)
  const full = Object.values(by).filter(p => p.length > 200 &&
    Math.max(...p.map(q => q.pct)) - Math.min(...p.map(q => q.pct)) > 0.98)
    .sort((a, b) => b.length - a.length)
  return full[0] ?? null
}

function score(T, L) {
  const K = 111320, cs = Math.cos(L[0].lat * Math.PI / 180)
  const C = T.centreline.map(([la, lo]) => ({ x: lo * K * cs, y: la * K }))
  const hl = i => T.edgeLeft ? T.edgeLeft[i] : T.width / 2
  const hr = i => T.edgeRight ? T.edgeRight[i] : T.width / 2
  let off = 0, worst = 0
  for (const q of L) {
    const P = { x: q.lon * K * cs, y: q.lat * K }
    let bi = 0, bd = Infinity
    for (let i = 0; i < C.length; i++) {
      const d = (C[i].x - P.x) ** 2 + (C[i].y - P.y) ** 2
      if (d < bd) { bd = d; bi = i }
    }
    const a = C[(bi - 2 + C.length) % C.length], b = C[(bi + 2) % C.length]
    const tx = b.x - a.x, ty = b.y - a.y, l = Math.hypot(tx, ty) || 1
    const lat = ((P.x - C[bi].x) * -ty + (P.y - C[bi].y) * tx) / l
    const over = Math.abs(lat) - (lat > 0 ? hl(bi) : hr(bi))
    if (over > 0) { off++; if (over > worst) worst = over }
  }
  return { pct: off / L.length * 100, worst }
}

console.log('                                        Breite            ausserhalb        max. Ueberschreitung')
console.log('  Strecke                             vorher   jetzt    vorher   jetzt     vorher   jetzt')
for (const f of fs.readdirSync('src/data/tracks').sort()) {
  const now = JSON.parse(fs.readFileSync('src/data/tracks/' + f, 'utf8'))
  const bakPath = `scripts/.${f}.pre-widen.bak`
  if (!fs.existsSync(bakPath)) continue
  const was = JSON.parse(fs.readFileSync(bakPath, 'utf8'))
  const entry = buildable.find(b => String(b.id) === String(now.trackId))
  if (!entry) continue
  let L = null
  try { L = lapOf(entry.file) } catch {}
  const name = (now.displayName + (now.config ? ' — ' + now.config : '')).slice(0, 34)
  if (!L) { console.log('  ' + name.padEnd(36) + String(was.width).padStart(6) + '  ' + String(now.width).padStart(6) + '     (keine saubere Runde)'); continue }
  const A = score(was, L), B = score(now, L)
  console.log('  ' + name.padEnd(36)
    + (was.width + ' m').padStart(7) + (now.width + ' m').padStart(9)
    + (A.pct.toFixed(1) + '%').padStart(10) + (B.pct.toFixed(1) + '%').padStart(8)
    + (A.worst.toFixed(1) + ' m').padStart(11) + (B.worst.toFixed(1) + ' m').padStart(8))
}
