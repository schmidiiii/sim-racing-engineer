// Trace the pit lane from telemetry.
//
// OpenStreetMap barely maps pit lanes — Spa yielded eight points for the whole
// thing — but iRacing flags every sample where the car is on pit road. Any lap
// that went through the pits therefore drives the line out for us. These are
// exactly the laps the track builder has to throw away, so nothing here costs
// anything that was being used elsewhere.
//
//   node scripts/build-pitlane.mjs src/data/tracks/403.json

import fs from 'node:fs'

const dir = 'C:/Users/schmi/Documents/iRacing/telemetry/'
const trackFile = process.argv[2]
if (!trackFile) { console.error('usage: node scripts/build-pitlane.mjs <track json>'); process.exit(1) }
const T = JSON.parse(fs.readFileSync(trackFile, 'utf8'))

let best = null      // the longest single continuous run through the pits
let files = 0

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
    const id = (y.toString('latin1').match(/^[ \t]*TrackID:[ \t]*(\d+)/m) || [])[1]
    if (Number(id) !== T.trackId) { fs.closeSync(fd); continue }
    files++

    const vh = Buffer.alloc(nv * 144); fs.readSync(fd, vh, 0, vh.length, vho)
    const V = {}
    for (let i = 0; i < nv; i++) {
      const o = i * 144
      const n = vh.toString('latin1', o + 16, o + 48).replace(/\0.*/, '')
      if (['Lat', 'Lon', 'Speed', 'OnPitRoad'].includes(n))
        V[n] = { t: vh.readInt32LE(o), o: vh.readInt32LE(o + 4) }
    }
    if (!V.OnPitRoad) { fs.closeSync(fd); continue }
    const rd = (b, v) => v.t === 5 ? b.readDoubleLE(v.o) : v.t === 4 ? b.readFloatLE(v.o)
                       : v.t === 1 ? b.readUInt8(v.o) : b.readInt32LE(v.o)
    const nS = Math.floor((st.size - bo) / bl), buf = Buffer.alloc(bl)
    let run = []
    for (let s = 0; s < nS; s += 2) {
      fs.readSync(fd, buf, 0, bl, bo + s * bl)
      if (rd(buf, V.OnPitRoad)) {
        // Stationary in the box would pile up hundreds of samples in one spot
        if (rd(buf, V.Speed) > 2) run.push({ lat: rd(buf, V.Lat), lon: rd(buf, V.Lon) })
      } else {
        if (!best || run.length > best.length) best = run
        run = []
      }
    }
    if (!best || run.length > best.length) best = run
    fs.closeSync(fd)
  } catch { if (fd !== undefined) try { fs.closeSync(fd) } catch {} }
}

if (!best || best.length < 50) {
  console.error(`no usable pit lane run found (${files} files of this track)`)
  process.exit(1)
}

// Even out the spacing; the raw samples bunch up wherever the car slowed
const K = 111320, cs = Math.cos(best[0].lat * Math.PI / 180)
const STEP = 5
const line = [[+best[0].lat.toFixed(7), +best[0].lon.toFixed(7)]]
let carry = 0
for (let i = 1; i < best.length; i++) {
  const d = Math.hypot((best[i].lon - best[i - 1].lon) * K * cs, (best[i].lat - best[i - 1].lat) * K)
  if (d > 60) continue                 // a jump: the car was reset or teleported
  carry += d
  if (carry >= STEP) { carry = 0; line.push([+best[i].lat.toFixed(7), +best[i].lon.toFixed(7)]) }
}
let len = 0
for (let i = 1; i < line.length; i++)
  len += Math.hypot((line[i][1] - line[i - 1][1]) * K * cs, (line[i][0] - line[i - 1][0]) * K)

T.pitLane = line
T.pitWidth = 12          // metres; iRacing does not state it, and 12 is typical
fs.writeFileSync(trackFile, JSON.stringify(T))
console.log(`${T.displayName}`)
console.log(`  ${files} files of this track, longest run through the pits ${best.length} samples`)
console.log(`  stored ${line.length} points, ${(len / 1000).toFixed(2)} km of pit lane`)
console.log(`  written -> ${trackFile} (${(fs.statSync(trackFile).size / 1024).toFixed(0)} kB)`)
