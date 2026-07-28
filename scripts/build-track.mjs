// Build a stored centreline for one track from OpenStreetMap.
//
// The viewer used to lay the road around the *driven* line, which put the
// reference lap dead centre by construction — you could never see yourself run
// wide. iRacing's GPS turns out to match the real world to within 3 m (checked
// at Spa against a surveyed reference), so the true centreline can simply be
// taken from OSM and stored.
//
// OSM returns every raceway in the area as unordered fragments: the kart track,
// the old circuit, pit lanes and every layout variant. A reference lap from an
// .ibt file sorts that out — anything the driver did not actually drive over is
// dropped, and what remains is ordered by position around the lap.
//
//   node scripts/build-track.mjs "<path to .ibt>"
//
// Writes src/data/tracks/<TrackID>.json.

import fs from 'node:fs'
import path from 'node:path'

const KEEP_M = 18          // how far off the driven line OSM geometry may sit
const SPACING_M = 8        // resample step of the stored centreline
const EARTH = 111320

// Only things that are plainly not a circuit. Names cannot be trusted to
// separate the track from its pit lane: at Spa the start/finish straight itself
// is mapped as "Pit Lane" and "Support Pit Lane", and filtering on that wiped
// out 44% of the lap. Which strand is the racing line is decided below, by
// where the car actually drove.
const NOT_THE_CIRCUIT = /paddock|karting|kart|service|access|runoff/i

function readIbt(file) {
  const fd = fs.openSync(file, 'r')
  const st = fs.fstatSync(fd)
  const h = Buffer.alloc(112)
  fs.readSync(fd, h, 0, 112, 0)
  const sInfoLen = h.readInt32LE(16), sInfoOff = h.readInt32LE(20)
  const nVars = h.readInt32LE(24), varOff = h.readInt32LE(28)
  const bufLen = h.readInt32LE(36), bufOff = h.readInt32LE(52)

  const yamlBuf = Buffer.alloc(sInfoLen)
  fs.readSync(fd, yamlBuf, 0, sInfoLen, sInfoOff)
  const yaml = yamlBuf.toString('latin1')           // iRacing declares ISO_8859_1
  const field = k => {
    const m = yaml.match(new RegExp(`^[ \\t]*${k}:[ \\t]*(.*)$`, 'm'))
    return m ? m[1].trim() : ''
  }

  const vh = Buffer.alloc(nVars * 144)
  fs.readSync(fd, vh, 0, vh.length, varOff)
  const V = {}
  for (let i = 0; i < nVars; i++) {
    const o = i * 144
    const name = vh.toString('latin1', o + 16, o + 48).replace(/\0.*/, '')
    if (['Lat', 'Lon', 'Alt', 'Speed', 'Lap', 'LapDistPct', 'OnPitRoad'].includes(name))
      V[name] = { type: vh.readInt32LE(o), off: vh.readInt32LE(o + 4) }
  }
  const read = (b, v) => v.type === 5 ? b.readDoubleLE(v.off)
                       : v.type === 4 ? b.readFloatLE(v.off)
                       : v.type === 1 ? b.readUInt8(v.off)
                       : b.readInt32LE(v.off)

  const nRec = Math.floor((st.size - bufOff) / bufLen)
  const rec = Buffer.alloc(bufLen)
  const byLap = {}
  for (let s = 0; s < nRec; s++) {
    fs.readSync(fd, rec, 0, bufLen, bufOff + s * bufLen)
    if (read(rec, V.Speed) < 15) continue
    const lap = read(rec, V.Lap)
    ;(byLap[lap] ||= []).push({
      lat: read(rec, V.Lat), lon: read(rec, V.Lon),
      alt: read(rec, V.Alt), pct: read(rec, V.LapDistPct),
      pits: V.OnPitRoad ? !!read(rec, V.OnPitRoad) : false,
    })
  }
  fs.closeSync(fd)

  // The longest lap is not the best reference: an out-lap or a session where
  // the car was reset to the grid carries position jumps of tens of metres,
  // and the stored centreline inherits every one of them as a kink. Take the
  // longest lap that actually runs continuously and covers the whole lap.
  const cosL = Math.cos((Object.values(byLap)[0]?.[0]?.lat ?? 0) * Math.PI / 180)
  const quality = pts => {
    let jump = 0
    for (let i = 1; i < pts.length; i++)
      jump = Math.max(jump, Math.hypot((pts[i].lon - pts[i - 1].lon) * 111320 * cosL,
                                       (pts[i].lat - pts[i - 1].lat) * 111320))
    const span = Math.max(...pts.map(p => p.pct)) - Math.min(...pts.map(p => p.pct))
    return { jump, span }
  }
  const scored = Object.entries(byLap)
    .map(([n, pts]) => ({ n, pts, pitted: pts.some(p => p.pits), ...quality(pts) }))
    .filter(l => l.pts.length > 200)
  // A lap through the pit lane still runs continuously and still covers the
  // whole lap, so the jump and span tests wave it through — and at Spa the pit
  // lane sits 15 to 20 m beside the start/finish straight, which is exactly how
  // far the stored centreline ended up off the racing line there.
  const clean = scored.filter(l => l.jump < 15 && l.span > 0.985 && !l.pts.some(p => p.pits))
  if (!clean.length) {
    const best = scored.sort((a, b) => a.jump - b.jump)[0]
    if (!best) throw new Error('no usable lap in ' + file)
    console.log(`  note: no clean lap — best available jumps ${best.jump.toFixed(0)} m`)
    return { yaml, field, lap: best.pts }
  }
  clean.sort((a, b) => b.pts.length - a.pts.length)
  if (scored.length > clean.length)
    console.log(`  reference lap ${clean[0].n} of ${scored.length} (${scored.filter(l => l.pitted).length} used the pit lane, `
      + `${scored.length - clean.length - scored.filter(l => l.pitted).length} had jumps or partial coverage)`)
  return { yaml, field, lap: clean[0].pts }
}

async function overpass(bbox) {
  const q = `[out:json][timeout:90];
    way["highway"="raceway"](${bbox.join(',')});
    out geom;`
  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'User-Agent': 'sim-racing-engineer track builder (github.com/schmidiiii/sim-racing-engineer)',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'data=' + encodeURIComponent(q),
  })
  if (!r.ok) throw new Error('Overpass returned ' + r.status)
  return (await r.json()).elements.filter(e => e.geometry)
}

async function build(ibtPath) {
  const { field, lap } = readIbt(ibtPath)
  const trackId = field('TrackID')
  const name = field('TrackDisplayName')
  const config = field('TrackConfigName')
  const shortName = field('TrackName')

  // Metre-space projection about the track, so distances are honest
  const lat0 = lap.reduce((s, p) => s + p.lat, 0) / lap.length
  const cosLat = Math.cos(lat0 * Math.PI / 180)
  const XY = p => ({ x: p.lon * EARTH * cosLat, y: p.lat * EARTH })
  const lapXY = lap.map(XY)

  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180
  for (const p of lap) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat)
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon)
  }
  const pad = 0.003
  const ways = await overpass([minLat - pad, minLon - pad, maxLat + pad, maxLon + pad])

  // Distance to the driven line as a polyline, not just to its samples, plus
  // the lap position it corresponds to — that ordering is what turns loose
  // fragments back into a lap.
  const nearest = p => {
    let best = Infinity, bestPct = 0
    for (let i = 1; i < lapXY.length; i++) {
      const a = lapXY[i - 1], b = lapXY[i]
      const dx = b.x - a.x, dy = b.y - a.y
      const l2 = dx * dx + dy * dy
      let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0
      t = Math.max(0, Math.min(1, t))
      const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
      if (d < best) {
        best = d
        // interpolate the lap position across the segment, minding the wrap
        let p0 = lap[i - 1].pct, p1 = lap[i].pct
        if (p1 < p0 - 0.5) p1 += 1
        bestPct = (p0 + (p1 - p0) * t) % 1
      }
    }
    return { d: best, pct: bestPct }
  }

  const kept = []
  const pit = []
  let considered = 0, byName = 0
  for (const w of ways) {
    const wayName = (w.tags || {}).name || ''
    if (NOT_THE_CIRCUIT.test(wayName)) {
      byName += w.geometry.length
      // The pit lane was only ever discarded because it runs close enough to
      // the track to pollute the centreline. It is worth drawing in its own
      // right, so it is ordered the same way — by the lap position of the
      // nearest point of the driven line — and kept separately.
      if (/paddock/i.test(wayName)) {
        for (const g of w.geometry) {
          const r = nearest(XY(g))
          if (r.d < 120) pit.push({ lat: g.lat, lon: g.lon, pct: r.pct })
        }
      }
      continue
    }
    for (const g of w.geometry) {
      considered++
      const p = XY(g)
      const r = nearest(p)
      if (r.d < KEEP_M) kept.push({ lat: g.lat, lon: g.lon, pct: r.pct, d: r.d })
    }
  }
  if (kept.length < 50) throw new Error(`only ${kept.length} OSM points matched — no usable geometry`)

  kept.sort((a, b) => a.pct - b.pct)

  // Ways that share tarmac — a layout variant, or a stretch mapped twice —
  // interleave once sorted by lap position, and the line then saw-tooths
  // between them. Left in, the road, kerbs and white lines all inherit it.
  // Collapsing each short slice of the lap to its median position merges the
  // duplicates, and one stray line cannot drag the median off the real one.
  let lapLengthM = 0
  for (let i = 1; i < lapXY.length; i++)
    lapLengthM += Math.hypot(lapXY[i].x - lapXY[i - 1].x, lapXY[i].y - lapXY[i - 1].y)
  const BIN = 4 / lapLengthM                       // one bin per ~4 m of lap
  const bins = new Map()
  for (const k of kept) {
    const b = Math.floor(k.pct / BIN)
    if (!bins.has(b)) bins.set(b, [])
    bins.get(b).push(k)
  }
  const median = xs => xs.slice().sort((a, b) => a - b)[xs.length >> 1]
  const merged = [...bins.keys()].sort((a, b) => a - b).map(b => {
    const g = bins.get(b)
    return { lat: median(g.map(p => p.lat)), lon: median(g.map(p => p.lon)), pct: b * BIN }
  })
  const collapsed = kept.length - merged.length

  // Chaining the OSM points directly still saw-tooths where a neighbouring
  // layout runs alongside (Spa carries a "Moto layout"), because two separate
  // lines get interleaved lap positions. So the OSM geometry is used only for
  // what it is actually needed for — how far the true centre lies to the side
  // of the driven line — and that offset is carried on the driven line, which
  // is smooth by construction. A stray point can then shift the offset a
  // little, but it can no longer double the line back on itself.
  // Raw GPS wanders by a metre or so between samples, which at an 8 m step is
  // enough to kink the line on its own — the viewer smooths the driven line for
  // the same reason before it builds anything off it.
  const smooth = (() => {
    let span = 0
    for (let i = 1; i < lapXY.length; i++)
      span += Math.hypot(lapXY[i].x - lapXY[i - 1].x, lapXY[i].y - lapXY[i - 1].y)
    const perSample = span / Math.max(1, lapXY.length - 1)
    const w = Math.max(1, Math.round(6 / perSample))       // +/- 6 m
    return lapXY.map((_, i) => {
      let sx = 0, sy = 0, n = 0
      for (let k = i - w; k <= i + w; k++) {
        const j = (k + lapXY.length) % lapXY.length
        sx += lapXY[j].x; sy += lapXY[j].y; n++
      }
      return { x: sx / n, y: sy / n }
    })
  })()

  const stations = []
  {
    let acc = 0
    for (let i = 1; i < smooth.length; i++) {
      const seg = Math.hypot(smooth[i].x - smooth[i - 1].x, smooth[i].y - smooth[i - 1].y)
      acc += seg
      if (acc < SPACING_M) continue
      acc = 0
      const a = smooth[Math.max(0, i - 4)], b = smooth[Math.min(smooth.length - 1, i + 4)]
      const tx = b.x - a.x, ty = b.y - a.y
      const l = Math.hypot(tx, ty) || 1
      stations.push({ i, x: smooth[i].x, y: smooth[i].y, px: -ty / l, py: tx / l, pct: lap[i].pct })
    }
  }
  // Signed sideways distance from the driven line to each OSM point
  const HALF_BIN = 12 / lapLengthM
  // A racing line stays on the track, so the true centre can only be about half
  // a width away from it. Anything past that is a mismatch — geometry from
  // another part of the circuit landing on this lap position — and letting it
  // through put 9% of Spa's stored line off the tarmac entirely.
  const MAX_OFF = 12
  const rawOffset = stations.map(st => {
    const near = merged.filter(m => {
      let d = Math.abs(m.pct - st.pct)
      return Math.min(d, 1 - d) < HALF_BIN
    })
    // Several strands can sit near one lap position — the circuit and its pit
    // lane run side by side for the whole straight. The driver was on the
    // circuit, so the nearest strand is the right one; a median across them
    // would split the difference and steer the road into the pit wall.
    const offs = near.map(m => {
      const P = XY(m)
      return (P.x - st.x) * st.px + (P.y - st.y) * st.py
    }).filter(o => Math.abs(o) <= MAX_OFF)
    if (!offs.length) return null
    let best = offs[0]
    for (const o of offs) if (Math.abs(o) < Math.abs(best)) best = o
    // Keep everything within a road's width of it; drop the parallel strand
    const same = offs.filter(o => Math.abs(o - best) < 8)
    return median(same)
  })
  // Gaps. Carrying an offset straight across one is wrong: at Spa the start
  // straight runs beside the pit lane, which the name filter removes, and a
  // 12 m offset dragged over that gap put the road a full track width off the
  // line the cars actually drove. Where OSM knows nothing the driven line is
  // the best information there is, so the offset eases back to zero and picks
  // the OSM shape up again at the far side.
  const FADE = 6                                   // stations, ~50 m
  const missing = rawOffset.map(o => o == null)
  for (let i = 0; i < rawOffset.length; i++) {
    if (!missing[i]) continue
    let a = i, b = i
    while (a >= 0 && missing[a]) a--
    while (b < rawOffset.length && missing[b]) b++
    const distA = a >= 0 ? i - a : Infinity
    const distB = b < rawOffset.length ? b - i : Infinity
    const va = a >= 0 ? rawOffset[a] : 0
    const vb = b < rawOffset.length ? rawOffset[b] : 0
    // Weight each side by how far away it is, and let both fade out with it
    const wa = distA < FADE ? (1 - distA / FADE) : 0
    const wb = distB < FADE ? (1 - distB / FADE) : 0
    rawOffset[i] = (wa + wb) > 0 ? (va * wa + vb * wb) / (wa + wb) * Math.max(wa, wb) : 0
  }
  const gapStations = missing.filter(Boolean).length
  const W = 3
  const offset = rawOffset.map((_, i) => {
    const w = []
    for (let k = i - W; k <= i + W; k++) w.push(rawOffset[(k + rawOffset.length) % rawOffset.length])
    return median(w)
  })

  // Where a neighbouring layout is picked up the offset can still jump from one
  // side of the track to the other between two stations — 18 m over an 8 m step
  // is a 66 degree kink, and every kerb and white line is built off this. The
  // true centre cannot slide sideways that fast relative to a driven lap, so
  // the rate is capped; run both ways round so neither end is favoured.
  const MAX_SLEW = 1.2                              // metres per 8 m station
  for (let pass = 0; pass < 2; pass++) {
    for (let n = 0; n < offset.length; n++) {
      const i = pass ? offset.length - 1 - n : n
      const j = (i - (pass ? -1 : 1) + offset.length) % offset.length
      const d = offset[i] - offset[j]
      if (Math.abs(d) > MAX_SLEW) offset[i] = offset[j] + Math.sign(d) * MAX_SLEW
    }
  }

  // Clamping alone leaves a staircase, and a staircase reverses curvature at
  // every step — which is worse than the spikes it removed, because the corner
  // detector reads that as the road bending the other way and flicks the kerbs
  // across the track. A mean over ~40 m turns the steps back into a curve.
  const SMOOTH = 5
  const smoothed = offset.map((_, i) => {
    let sum = 0
    for (let k = i - SMOOTH; k <= i + SMOOTH; k++) sum += offset[(k + offset.length) % offset.length]
    return sum / (SMOOTH * 2 + 1)
  })
  for (let i = 0; i < offset.length; i++) offset[i] = smoothed[i]

  const line = stations.map((st, i) => {
    const x = st.x + st.px * offset[i], y = st.y + st.py * offset[i]
    return [+(y / EARTH).toFixed(7), +(x / (EARTH * cosLat)).toFixed(7)]
  })
  const offAbs = offset.map(Math.abs).sort((a, b) => a - b)

  // Pit lane: ordered by lap position, then thinned to the same step. It is a
  // single strand, so it needs none of the offset machinery above.
  pit.sort((a, b) => a.pct - b.pct)
  const pitLine = []
  for (const p of pit) {
    const last = pitLine[pitLine.length - 1]
    if (!last) { pitLine.push([+p.lat.toFixed(7), +p.lon.toFixed(7)]); continue }
    const d = Math.hypot((p.lon - last[1]) * EARTH * cosLat, (p.lat - last[0]) * EARTH)
    if (d > 200) continue                      // a jump to the far end: skip
    if (d >= SPACING_M) pitLine.push([+p.lat.toFixed(7), +p.lon.toFixed(7)])
  }

  const ds = kept.map(k => k.d).sort((x, y) => x - y)
  const q = p => ds[Math.floor(ds.length * p)]
  let gapMax = 0
  for (let i = 1; i < merged.length; i++) gapMax = Math.max(gapMax, (merged[i].pct - merged[i - 1].pct) * 100)

  const out = {
    trackId: Number(trackId),
    trackName: shortName,
    displayName: name,
    config,
    source: 'OpenStreetMap contributors, ODbL',
    generated: new Date().toISOString().slice(0, 10),
    // Metres; OSM carries no width, so this is a nominal figure per track type
    width: 12,
    centreline: line,
    pitLane: pitLine.length > 20 ? pitLine : undefined,
  }
  const dir = path.join('src', 'data', 'tracks')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${trackId}.json`)
  fs.writeFileSync(file, JSON.stringify(out))

  console.log(`${name}${config ? ' — ' + config : ''}  (TrackID ${trackId}, "${shortName}")`)
  console.log(`  OSM points considered ${considered}, dropped by name ${byName}, kept ${kept.length}, merged away ${collapsed} overlapping`)
  console.log(`  driven line vs true centreline: median ${q(0.5).toFixed(1)} m, p90 ${q(0.9).toFixed(1)} m, max ${ds[ds.length - 1].toFixed(1)} m`)
  console.log(`  largest gap around the lap: ${gapMax.toFixed(1)}%`)
  console.log(`  sideways shift applied: median ${offAbs[offAbs.length >> 1].toFixed(1)} m, p90 ${offAbs[Math.floor(offAbs.length * 0.9)].toFixed(1)} m, max ${offAbs[offAbs.length - 1].toFixed(1)} m`)
  console.log(`  stations with no OSM geometry: ${gapStations} of ${stations.length} (${(gapStations / stations.length * 100).toFixed(0)}% — the driven line is used there)`)
  console.log(`  pit lane: ${pitLine.length} points${pitLine.length > 20 ? '' : ' (too few — not stored)'}`)
  console.log(`  stored ${line.length} points at ${SPACING_M} m spacing -> ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} kB)`)
  // A saw-tooth would wreck every kerb and white line offset from this, so it
  // is checked rather than assumed: an 8 m step round a 30 m hairpin turns ~15°
  let worstTurn = 0, kinks = 0
  const M2 = line.map(([la, lo]) => ({ x: lo * EARTH * cosLat, y: la * EARTH }))
  for (let i = 2; i < M2.length; i++) {
    const ax = M2[i - 1].x - M2[i - 2].x, ay = M2[i - 1].y - M2[i - 2].y
    const bx = M2[i].x - M2[i - 1].x, by = M2[i].y - M2[i - 1].y
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by)
    if (!la || !lb) continue
    const ang = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) * 180 / Math.PI
    if (ang > worstTurn) worstTurn = ang
    if (ang > 40) kinks++
  }
  console.log(`  sharpest turn between steps ${worstTurn.toFixed(0)}°, kinks over 40°: ${kinks}`)
  if (gapMax > 8) console.log('  WARNING: large gap — check the layout matched')
  if (kinks) console.log('  WARNING: kinks remain — kerbs and lines will be ragged')
  return out
}

const args = process.argv.slice(2)
if (!args.length) {
  console.error('usage: node scripts/build-track.mjs "<path to .ibt>" [more.ibt ...]')
  process.exit(1)
}
for (const a of args) {
  try { await build(a) } catch (e) { console.error(`FAILED ${path.basename(a)}: ${e.message}`) }
  console.log()
}
