// Build a stored track from the TUM racetrack database.
//
// TUMFTM/racetrack-database carries 25 circuits as centreline plus the track
// width to the left and right of it, every five metres. They built it the same
// way we did — centrelines from OpenStreetMap, widths measured off satellite
// imagery — but they did it once, carefully, per circuit, and their result is
// complete where ours has gaps.
//
// The catch is that their coordinates are local metres with an arbitrary origin
// and rotation. That is fixable precisely: we have the car's exact position, so
// the two shapes can be laid on top of each other. Because a circuit outline is
// distinctive, the fit locks in — and its residual doubles as a check that we
// matched the right layout.
//
// The reference the shape is laid onto can be a driven lap, or — when there is
// no clean lap to be had, or no telemetry for that circuit at all — the raceway
// as OpenStreetMap has it. OSM is georeferenced too, and TUM's centrelines came
// from there in the first place, so it aligns at least as well. That matters
// beyond one track: most circuits will never have a lap recorded for them.
//
//   node scripts/build-track-tum.mjs Spa "<reference .ibt>"
//   node scripts/build-track-tum.mjs Hockenheim "<any .ibt of that track>" --osm

import fs from 'node:fs'
import path from 'node:path'

const EARTH = 111320
const BASE = 'https://raw.githubusercontent.com/TUMFTM/racetrack-database/master/tracks/'
const FIT_N = 360        // points used to search the alignment

const [trackName, ibtPath] = process.argv.slice(2)
if (!trackName || !ibtPath) {
  console.error('usage: node scripts/build-track-tum.mjs <TrackName> "<reference .ibt>"')
  process.exit(1)
}

// ── the reference lap, from telemetry ────────────────────────────────────────
function readIbt(file) {
  const fd = fs.openSync(file, 'r'), st = fs.fstatSync(fd)
  const h = Buffer.alloc(112); fs.readSync(fd, h, 0, 112, 0)
  const sLen = h.readInt32LE(16), sOff = h.readInt32LE(20)
  const nVars = h.readInt32LE(24), vOff = h.readInt32LE(28)
  const bufLen = h.readInt32LE(36), bufOff = h.readInt32LE(52)
  const yamlBuf = Buffer.alloc(sLen); fs.readSync(fd, yamlBuf, 0, sLen, sOff)
  const yaml = yamlBuf.toString('latin1')
  const field = k => {
    const m = yaml.match(new RegExp(`^[ \\t]*${k}:[ \\t]*(.*)$`, 'm'))
    return m ? m[1].trim() : ''
  }
  const vh = Buffer.alloc(nVars * 144); fs.readSync(fd, vh, 0, vh.length, vOff)
  const V = {}
  for (let i = 0; i < nVars; i++) {
    const o = i * 144
    const n = vh.toString('latin1', o + 16, o + 48).replace(/\0.*/, '')
    if (['Lat', 'Lon', 'Speed', 'Lap', 'LapDistPct', 'OnPitRoad'].includes(n))
      V[n] = { type: vh.readInt32LE(o), off: vh.readInt32LE(o + 4) }
  }
  const read = (b, v) => v.type === 5 ? b.readDoubleLE(v.off)
                       : v.type === 4 ? b.readFloatLE(v.off)
                       : v.type === 1 ? b.readUInt8(v.off)
                       : b.readInt32LE(v.off)
  const nRec = Math.floor((st.size - bufOff) / bufLen), rec = Buffer.alloc(bufLen)
  const byLap = {}
  for (let s = 0; s < nRec; s += 2) {
    fs.readSync(fd, rec, 0, bufLen, bufOff + s * bufLen)
    if (read(rec, V.Speed) < 15) continue
    if (V.OnPitRoad && read(rec, V.OnPitRoad)) continue      // pit lane is not the circuit
    ;(byLap[read(rec, V.Lap)] ||= []).push({
      lat: read(rec, V.Lat), lon: read(rec, V.Lon), pct: read(rec, V.LapDistPct),
    })
  }
  fs.closeSync(fd)
  const full = Object.entries(byLap)
    .filter(([, p]) => p.length > 400 &&
      Math.max(...p.map(q => q.pct)) - Math.min(...p.map(q => q.pct)) > 0.98)
    .sort((a, b) => b[1].length - a[1].length)
  if (!full.length) throw new Error('no complete racing lap in ' + path.basename(file))
  return { field, lap: full[0][1], lapNo: full[0][0] }
}

const { field, lap, lapNo } = readIbt(ibtPath)
console.log(`reference: lap ${lapNo} of ${path.basename(ibtPath)} (${lap.length} samples)`)

const lat0 = lap.reduce((s, p) => s + p.lat, 0) / lap.length
const cosLat = Math.cos(lat0 * Math.PI / 180)
const lonOff = lap.reduce((s, p) => s + p.lon, 0) / lap.length
// Local metres about the lap, so both shapes live in the same kind of space
const toM = p => ({ x: (p.lon - lonOff) * EARTH * cosLat, y: (p.lat - lat0) * EARTH })
const toLatLon = q => [lat0 + q.y / EARTH, lonOff + q.x / (EARTH * cosLat)]

// ── the database track ───────────────────────────────────────────────────────
const csvUrl = BASE + trackName + '.csv'
const res = await fetch(csvUrl, { headers: { 'User-Agent': 'sim-racing-engineer' } })
if (!res.ok) { console.error(`${csvUrl}: HTTP ${res.status}`); process.exit(1) }
const rows = (await res.text()).trim().split('\n')
  .filter(l => l.trim() && !l.startsWith('#'))
  .map(l => l.split(',').map(Number))
  .map(([x, y, wr, wl]) => ({ x, y, wr, wl }))
console.log(`database: ${trackName}.csv, ${rows.length} points\n`)

// Resample a closed loop to n evenly spaced points, carrying the widths along
function resample(pts, n) {
  const cum = [0]
  for (let i = 1; i <= pts.length; i++) {
    const a = pts[i - 1], b = pts[i % pts.length]
    cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y))
  }
  const total = cum[pts.length]
  const out = []
  for (let k = 0; k < n; k++) {
    const d = total * k / n
    let i = 1
    while (i < cum.length - 1 && cum[i] < d) i++
    const t = (d - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1])
    const a = pts[i - 1], b = pts[i % pts.length]
    out.push({
      x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
      wr: a.wr != null ? a.wr + (b.wr - a.wr) * t : null,
      wl: a.wl != null ? a.wl + (b.wl - a.wl) * t : null,
    })
  }
  return out
}

const useOsm = process.argv.includes('--osm')

// OSM as an alternative reference.
//
// It arrives as loose fragments, and matching a shape to an unordered cloud
// goes wrong: the fit has to start from the two centroids, and OSM's is pulled
// off centre because it packs vertices into corners and leaves straights
// bare. Chaining the fragments back into one line first restores the ordering
// the exact fit needs — the same ordering a driven lap would have given.
async function osmWays() {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180
  for (const p of lap) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat)
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon)
  }
  const pad = 0.003
  const q = `[out:json][timeout:90];way["highway"="raceway"]`
    + `(${minLat - pad},${minLon - pad},${maxLat + pad},${maxLon + pad});out geom;`
  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'User-Agent': 'sim-racing-engineer', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(q),
  })
  if (!r.ok) throw new Error('Overpass returned ' + r.status)
  return (await r.json()).elements
    .filter(w => w.geometry && !/paddock|kart|service|access/i.test((w.tags || {}).name || ''))
    .map(w => w.geometry.map(g => toM({ lat: g.lat, lon: g.lon })))
    .filter(g => g.length > 1)
}

const chainLength = c => {
  let d = 0
  for (let i = 1; i < c.length; i++) d += Math.hypot(c[i].x - c[i - 1].x, c[i].y - c[i - 1].y)
  return d
}

// Walk from one fragment to the next, always taking the nearest loose end. The
// pit lane branches off the same junctions, so the chain that comes closest to
// the circuit's known length is the one to keep.
function chainWays(ways, targetLen) {
  let best = null
  for (let seed = 0; seed < ways.length; seed++) {
    for (const flip of [false, true]) {
      const used = new Set([seed])
      let chain = flip ? [...ways[seed]].reverse() : [...ways[seed]]
      for (;;) {
        const tail = chain[chain.length - 1]
        let pick = null
        for (let i = 0; i < ways.length; i++) {
          if (used.has(i)) continue
          const w = ways[i]
          const dh = Math.hypot(w[0].x - tail.x, w[0].y - tail.y)
          const dt = Math.hypot(w[w.length - 1].x - tail.x, w[w.length - 1].y - tail.y)
          const d = Math.min(dh, dt)
          if (d < 40 && (!pick || d < pick.d)) pick = { i, d, rev: dt < dh }
        }
        if (!pick) break
        used.add(pick.i)
        const w = pick.rev ? [...ways[pick.i]].reverse() : ways[pick.i]
        chain = chain.concat(w)
      }
      const len = chainLength(chain)
      const off = Math.abs(len - targetLen)
      if (chain.length > 20 && (!best || off < best.off)) best = { chain, len, off }
    }
  }
  return best
}

const A = resample(lap.map(toM), FIT_N)          // drivenconst A = resample(lap.map(toM), FIT_N)          // driven
const B = resample(rows, FIT_N)                  // database

const centreOf = P => {
  const cx = P.reduce((s2, p) => s2 + p.x, 0) / P.length
  const cy = P.reduce((s2, p) => s2 + p.y, 0) / P.length
  return { cx, cy, pts: P.map(p => ({ ...p, x: p.x - cx, y: p.y - cy })) }
}
const b0 = centreOf(B)

// Best rigid fit for a given index shift and handedness. The rotation that
// minimises the squared distance has a closed form, so only the shift and the
// mirror have to be searched — and a circuit outline is distinctive enough that
// the right combination stands out by a wide margin.
function fitFor(shift, mirror) {
  let sxy = 0, sxx = 0
  for (let i = 0; i < FIT_N; i++) {
    const a = a0.pts[i]
    const b = b0.pts[(i + shift) % FIT_N]
    const bx = mirror ? -b.x : b.x
    sxx += bx * a.x + b.y * a.y
    sxy += bx * a.y - b.y * a.x
  }
  const ang = Math.atan2(sxy, sxx)
  const c = Math.cos(ang), s = Math.sin(ang)
  let err = 0
  for (let i = 0; i < FIT_N; i++) {
    const a = a0.pts[i]
    const b = b0.pts[(i + shift) % FIT_N]
    const bx = mirror ? -b.x : b.x
    const rx = bx * c - b.y * s, ry = bx * s + b.y * c
    err += (rx - a.x) ** 2 + (ry - a.y) ** 2
  }
  return { ang, mirror, shift, rms: Math.sqrt(err / FIT_N) }
}

// The reference the database shape gets laid onto: a driven lap, or the OSM
// raceway chained back into one line when no clean lap is available.
let refPts = A
if (useOsm) {
  const ways = await osmWays()
  const dbLen = chainLength([...rows, rows[0]])
  const got = chainWays(ways, dbLen)
  if (!got) throw new Error('could not chain the OSM ways into a line')
  // A chain of the right length can still be scrambled: the greedy walk can
  // jump across the circuit at a junction and come back later. Big steps and a
  // loop that does not close are what that looks like.
  let maxStep = 0
  for (let i = 1; i < got.chain.length; i++)
    maxStep = Math.max(maxStep, Math.hypot(got.chain[i].x - got.chain[i - 1].x, got.chain[i].y - got.chain[i - 1].y))
  const closeGap = Math.hypot(
    got.chain[0].x - got.chain[got.chain.length - 1].x,
    got.chain[0].y - got.chain[got.chain.length - 1].y)
  console.log(`reference: ${ways.length} OSM ways chained to ${(got.len / 1000).toFixed(3)} km`
    + ` (database says ${(dbLen / 1000).toFixed(3)} km)`)
  console.log(`           largest step in the chain ${maxStep.toFixed(0)} m, loop closes to ${closeGap.toFixed(0)} m`)
  if (got.off > dbLen * 0.15) {
    console.error('chained length is too far off — the fragments do not form this circuit')
    process.exit(1)
  }
  refPts = resample(got.chain, FIT_N)
}
const a0 = centreOf(refPts)

let best = null
for (const mirror of [false, true])
  for (let shift = 0; shift < FIT_N; shift++) {
    const f = fitFor(shift, mirror)
    if (!best || f.rms < best.rms) best = f
  }
console.log(`alignment: rotate ${(best.ang * 180 / Math.PI).toFixed(2)}°`
  + `${best.mirror ? ', mirrored' : ''}, start offset ${(best.shift / FIT_N * 100).toFixed(1)}% of the lap`)
console.log(`fit residual: ${best.rms.toFixed(2)} m`
  + (useOsm ? ' (database centreline vs OpenStreetMap)' : ' (driven line vs database centreline)')) 
if (best.rms > 12) {
  console.error('\nresidual too large — this is probably the wrong track or layout')
  process.exit(1)
}

// Place every database point into the world
const c = Math.cos(best.ang), s = Math.sin(best.ang)
const place = p => {
  const bx = (best.mirror ? -(p.x - b0.cx) : (p.x - b0.cx)), by = p.y - b0.cy
  return { x: bx * c - by * s + a0.cx, y: bx * s + by * c + a0.cy,
           wl: best.mirror ? p.wr : p.wl, wr: best.mirror ? p.wl : p.wr }
}
const placed = rows.map(place)

const trackId = field('TrackID')
const out = {
  trackId: Number(trackId),
  trackName: field('TrackName'),
  displayName: field('TrackDisplayName'),
  config: field('TrackConfigName'),
  source: 'TUM racetrack-database (OpenStreetMap centreline, widths from satellite imagery)'
    + (useOsm ? ', aligned to OpenStreetMap' : ', aligned to a driven lap'),
  generated: new Date().toISOString().slice(0, 10),
  fitResidual: +best.rms.toFixed(2),
  centreline: placed.map(p => toLatLon(p).map(v => +v.toFixed(7))),
  // Metres from the centreline to each edge, in the car's own sense of left and
  // right — this is what the flat nominal width was standing in for
  edgeLeft: placed.map(p => +p.wl.toFixed(2)),
  edgeRight: placed.map(p => +p.wr.toFixed(2)),
}
const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1]
out.width = +(med(out.edgeLeft) + med(out.edgeRight)).toFixed(1)

const dir = path.join('src', 'data', 'tracks')
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, `${trackId}.json`)
fs.writeFileSync(file, JSON.stringify(out))
console.log(`\n${out.displayName} — ${out.config}  (TrackID ${trackId})`)
console.log(`  ${out.centreline.length} points, width ${out.width} m median `
  + `(${(Math.min(...out.edgeLeft) + Math.min(...out.edgeRight)).toFixed(1)}–`
  + `${(Math.max(...out.edgeLeft) + Math.max(...out.edgeRight)).toFixed(1)} m)`)
console.log(`  written -> ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} kB)`)
