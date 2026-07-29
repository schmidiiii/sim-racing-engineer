// Find the kerbs from telemetry and store them with the track.
//
// The viewer used to place kerbs wherever it detected a corner, which is a
// guess: real circuits put them where they please, and the Red Bull Ring's
// exits are lined with kerb the corner detector never asked about. iRacing
// reports the surface under the car, so the kerbs can simply be observed —
// every lap anyone ran over one is a labelled measurement of where it is.
//
// Tarmac reads as material 1 and sits inside the painted edge; the other values
// sit beyond it. Which number means "kerb" and which means "astroturf" is never
// stated, and does not matter: anything driven on beyond the paint is surface
// worth drawing.
//
//   node scripts/build-kerbs.mjs src/data/tracks/403.json

import fs from 'node:fs'

const TARMAC = 1
const BINS = 400                 // around the lap, so ~10 m on a 4 km circuit
const MIN_HITS = 4               // samples before a bin is believed
// A real kerb is one to two and a half metres of ribbed concrete. Anything
// further out is the flat beyond it — driveable, but not kerb, and painting it
// red turns a corner exit into a field. Samples out there still count as
// evidence that a kerb is present; they just do not set its depth.
const DEPTH_Q = 0.70             // how far out to call the edge of the kerb
const MAX_DEPTH = 8              // metres; past this the sample is ignored entirely
const KERB_MAX = 2.5             // metres actually drawn

const trackFile = process.argv[2]
if (!trackFile) { console.error('usage: node scripts/build-kerbs.mjs <track json>'); process.exit(1) }
const T = JSON.parse(fs.readFileSync(trackFile, 'utf8'))

const dir = 'C:/Users/schmi/Documents/iRacing/telemetry/'
const K = 111320, cs = Math.cos(T.centreline[0][0] * Math.PI / 180)
const C = T.centreline.map(([la, lo]) => ({ x: lo * K * cs, y: la * K }))
const halfL = i => T.edgeLeft ? T.edgeLeft[i] : T.width / 2
const halfR = i => T.edgeRight ? T.edgeRight[i] : T.width / 2

// Bins of observed depth beyond the paint, per side
const left = Array.from({ length: BINS }, () => [])
const right = Array.from({ length: BINS }, () => [])
let files = 0, samples = 0

for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.ibt'))) {
  let fd
  try {
    fd = fs.openSync(dir + f, 'r')
    const st = fs.fstatSync(fd)
    const h = Buffer.alloc(112); fs.readSync(fd, h, 0, 112, 0)
    const sl = h.readInt32LE(16), so = h.readInt32LE(20)
    const nv = h.readInt32LE(24), vho = h.readInt32LE(28)
    const bl = h.readInt32LE(36), bo = h.readInt32LE(52)
    const y = Buffer.alloc(sl); fs.readSync(fd, y, 0, sl, so)
    const yaml = y.toString('latin1')
    const id = (yaml.match(/^[ \t]*TrackID:[ \t]*(\d+)/m) || [])[1]
    if (Number(id) !== T.trackId) { fs.closeSync(fd); continue }

    const vh = Buffer.alloc(nv * 144); fs.readSync(fd, vh, 0, vh.length, vho)
    const V = {}
    for (let i = 0; i < nv; i++) {
      const o = i * 144
      const n = vh.toString('latin1', o + 16, o + 48).replace(/\0.*/, '')
      if (['Lat', 'Lon', 'Speed', 'LapDistPct', 'OnPitRoad', 'PlayerTrackSurfaceMaterial'].includes(n))
        V[n] = { t: vh.readInt32LE(o), o: vh.readInt32LE(o + 4) }
    }
    if (!V.PlayerTrackSurfaceMaterial) { fs.closeSync(fd); continue }
    const rd = (b, v) => v.t === 5 ? b.readDoubleLE(v.o) : v.t === 4 ? b.readFloatLE(v.o)
                       : v.t === 1 ? b.readUInt8(v.o) : b.readInt32LE(v.o)
    const nS = Math.floor((st.size - bo) / bl), buf = Buffer.alloc(bl)
    for (let s = 0; s < nS; s += 2) {
      fs.readSync(fd, buf, 0, bl, bo + s * bl)
      if (rd(buf, V.Speed) < 15) continue
      if (V.OnPitRoad && rd(buf, V.OnPitRoad)) continue
      if (rd(buf, V.PlayerTrackSurfaceMaterial) === TARMAC) continue
      const P = { x: rd(buf, V.Lon) * K * cs, y: rd(buf, V.Lat) * K }
      let bi = 0, bd = Infinity
      for (let i = 0; i < C.length; i++) {
        const d = (C[i].x - P.x) ** 2 + (C[i].y - P.y) ** 2
        if (d < bd) { bd = d; bi = i }
      }
      const a = C[(bi - 2 + C.length) % C.length], b = C[(bi + 2) % C.length]
      const tx = b.x - a.x, ty = b.y - a.y, l = Math.hypot(tx, ty) || 1
      const lateral = ((P.x - C[bi].x) * -ty + (P.y - C[bi].y) * tx) / l
      const past = Math.abs(lateral) - (lateral > 0 ? halfL(bi) : halfR(bi))
      if (past <= 0 || past > MAX_DEPTH) continue
      const bin = Math.min(BINS - 1, Math.floor(bi / C.length * BINS))
      ;(lateral > 0 ? left : right)[bin].push(past)
      samples++
    }
    fs.closeSync(fd); files++
  } catch { if (fd !== undefined) try { fs.closeSync(fd) } catch {} }
}

if (!samples) { console.error('no off-tarmac samples found for this track'); process.exit(1) }

// A kerb is a run of neighbouring bins, not a single one: one wheel clipping a
// corner leaves a lone bin, a kerb leaves several in a row.
const depth = arr => {
  const s = arr.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * DEPTH_Q))]
}
const toSeries = (bins) => {
  const raw = bins.map(b => b.length >= MIN_HITS ? Math.min(KERB_MAX, depth(b)) : 0)
  // Widen by one bin either side: the samples mark where cars went, and a kerb
  // reaches a little past the last set of wheels that touched it
  const out = raw.map((v, i) =>
    Math.max(v, raw[(i - 1 + BINS) % BINS] * 0.6, raw[(i + 1) % BINS] * 0.6))
  // Onto the centreline's own spacing
  return T.centreline.map((_, i) => {
    const b = Math.min(BINS - 1, Math.floor(i / T.centreline.length * BINS))
    return +out[b].toFixed(2)
  })
}

const kerbLeft = toSeries(left)
const kerbRight = toSeries(right)
const covered = s => s.filter(v => v > 0).length / s.length * 100

console.log(`${T.displayName}`)
console.log(`  ${files} files of this track, ${samples} samples beyond the painted edge`)
console.log(`  kerb on the left  along ${covered(kerbLeft).toFixed(0)}% of the lap, `
  + `up to ${Math.max(...kerbLeft).toFixed(1)} m deep`)
console.log(`  kerb on the right along ${covered(kerbRight).toFixed(0)}% of the lap, `
  + `up to ${Math.max(...kerbRight).toFixed(1)} m deep`)

T.kerbLeft = kerbLeft
T.kerbRight = kerbRight
fs.writeFileSync(trackFile, JSON.stringify(T))
console.log(`\n  written -> ${trackFile} (${(fs.statSync(trackFile).size / 1024).toFixed(0)} kB)`)
