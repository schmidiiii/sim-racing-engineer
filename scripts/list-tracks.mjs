// Which tracks can be built from the telemetry on this machine, and from which
// file. A track needs one lap that ran the whole circuit without entering the
// pits — the reference the stored geometry is laid onto.
import fs from 'node:fs'
const dir = 'C:/Users/schmi/Documents/iRacing/telemetry/'
const byTrack = new Map()
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
    const g = k => { const m = yaml.match(new RegExp(`^[ \t]*${k}:[ \t]*(.*)$`, 'm')); return m ? m[1].trim() : '' }
    const id = g('TrackID')
    const vh = Buffer.alloc(nv * 144); fs.readSync(fd, vh, 0, vh.length, vho)
    const V = {}
    for (let i = 0; i < nv; i++) {
      const o = i * 144
      const n = vh.toString('latin1', o + 16, o + 48).replace(/\0.*/, '')
      if (['Speed', 'Lap', 'LapDistPct', 'OnPitRoad'].includes(n)) V[n] = { t: vh.readInt32LE(o), o: vh.readInt32LE(o + 4) }
    }
    const rd = (b, v) => v.t === 5 ? b.readDoubleLE(v.o) : v.t === 4 ? b.readFloatLE(v.o)
                       : v.t === 1 ? b.readUInt8(v.o) : b.readInt32LE(v.o)
    const nS = Math.floor((st.size - bo) / bl), buf = Buffer.alloc(bl), laps = {}
    for (let s = 0; s < nS; s += 8) {
      fs.readSync(fd, buf, 0, bl, bo + s * bl)
      if (rd(buf, V.Speed) < 15) continue
      const k = rd(buf, V.Lap)
      const l = laps[k] ||= { n: 0, min: 1, max: 0, pit: false }
      l.n++; l.min = Math.min(l.min, rd(buf, V.LapDistPct)); l.max = Math.max(l.max, rd(buf, V.LapDistPct))
      if (V.OnPitRoad && rd(buf, V.OnPitRoad)) l.pit = true
    }
    const good = Object.values(laps).filter(l => l.n > 50 && !l.pit && l.max - l.min > 0.98)
    const cur = byTrack.get(id)
    const score = good.reduce((m, l) => Math.max(m, l.n), 0)
    if (!cur || score > cur.score)
      byTrack.set(id, { id, name: g('TrackDisplayName'), cfg: g('TrackConfigName'),
                        len: g('TrackLength'), file: f, score, laps: good.length })
  } catch { /* unreadable file */ } finally { if (fd !== undefined) fs.closeSync(fd) }
}
const rows = [...byTrack.values()].sort((a, b) => b.score - a.score)
console.log(`${rows.length} distinct tracks in the telemetry folder\n`)
console.log('  id    clean laps   track')
for (const r of rows)
  console.log(`  ${String(r.id).padStart(4)}  ${String(r.laps).padStart(6)}       ${r.name}${r.cfg ? ' — ' + r.cfg : ''}${r.score ? '' : '   (no usable lap)'}`)
fs.writeFileSync('scripts/.buildable.json', JSON.stringify(rows.filter(r => r.score > 0), null, 1))
console.log(`\n${rows.filter(r => r.score > 0).length} can be built now -> scripts/.buildable.json`)
