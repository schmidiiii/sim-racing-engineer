// Add a margin to a track's stored width.
//
// The database widths run to the painted edge, which is where the *lap* ends,
// not where the tarmac does — a car riding the kerb is legitimately outside
// them. A small margin lets the drawn road cover what is actually driveable.
//
//   node scripts/widen-track.mjs src/data/tracks/403.json 0.8
import fs from 'node:fs'
const [file, byStr] = process.argv.slice(2)
const by = Number(byStr)
if (!file || !Number.isFinite(by)) {
  console.error('usage: node scripts/widen-track.mjs <track json> <metres per side>')
  process.exit(1)
}
const T = JSON.parse(fs.readFileSync(file, 'utf8'))
const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1]
const before = T.edgeLeft ? med(T.edgeLeft) + med(T.edgeRight) : T.width
if (T.edgeLeft && T.edgeRight) {
  T.edgeLeft = T.edgeLeft.map(v => +(v + by).toFixed(2))
  T.edgeRight = T.edgeRight.map(v => +(v + by).toFixed(2))
  T.width = +(med(T.edgeLeft) + med(T.edgeRight)).toFixed(1)
} else {
  T.width = +(T.width + by * 2).toFixed(1)
}
// Remember it, so a rebuild does not silently drop the margin
T.widenedBy = +((T.widenedBy ?? 0) + by).toFixed(2)
fs.writeFileSync(file, JSON.stringify(T))
console.log(`${T.displayName}: ${before.toFixed(1)} m -> ${T.width.toFixed(1)} m `
  + `(+${(by * 2).toFixed(1)} m, ${by} per side; total margin now ${T.widenedBy} m per side)`)
