// Build stored geometry for every track a reference lap exists for.
// Overpass rate-limits and times out often, so each track gets a few attempts.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const dir = 'C:/Users/schmi/Documents/iRacing/telemetry/'
const rows = JSON.parse(fs.readFileSync('scripts/.buildable.json', 'utf8'))
const skip = new Set((process.argv[2] || '').split(',').filter(Boolean))
for (const r of rows) {
  const out = `src/data/tracks/${r.id}.json`
  if (skip.has(String(r.id)) || fs.existsSync(out)) {
    console.log(`${String(r.id).padStart(4)}  ${r.name.slice(0, 38).padEnd(40)} already built`)
    continue
  }
  let done = false
  // Overpass rate-limits hard and answers 504 under load. The data is there —
  // the earlier run lost nine tracks to this alone — so it is worth waiting it
  // out rather than treating a refusal as "no geometry".
  for (let attempt = 1; attempt <= 6 && !done; attempt++) {
    try {
      const res = execFileSync('node', ['scripts/build-track.mjs', dir + r.file],
        { encoding: 'utf8', timeout: 240000, stdio: ['ignore', 'pipe', 'pipe'] })
      const stored = (res.match(/stored (\d+) points/) || [])[1]
      const kinks = (res.match(/kinks over 40°: (\d+)/) || [])[1]
      const gaps = (res.match(/no OSM geometry: \d+ of \d+ \((\d+)%/) || [])[1]
      if (stored) {
        console.log(`${String(r.id).padStart(4)}  ${r.name.slice(0, 38).padEnd(40)} ${String(stored).padStart(5)} pts, `
          + `${gaps ?? '?'}% without OSM, ${kinks ?? '?'} kinks`)
        done = true
      } else {
        console.log(`${String(r.id).padStart(4)}  ${r.name.slice(0, 38).padEnd(40)} no geometry`)
        done = true
      }
    } catch (e) {
      const all = ((e.stdout || '') + (e.stderr || ''))
      if (attempt === 6) console.log(`${String(r.id).padStart(4)}  ${r.name.slice(0, 38).padEnd(40)} FAILED: `
        + (all.match(/FAILED[^\n]*|Overpass returned \d+/) || ['unknown'])[0].slice(0, 60))
      else await new Promise(res2 => setTimeout(res2, 45000 + attempt * 15000))
    }
  }
}
console.log('\n' + fs.readdirSync('src/data/tracks').length + ' track files in src/data/tracks')
