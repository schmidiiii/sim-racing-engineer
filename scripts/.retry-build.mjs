// Overpass answers 504 under load for minutes at a time. build-all retries six
// times back to back, which all land inside the same bad spell; this waits
// between attempts instead.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const dir = 'C:/Users/schmi/Documents/iRacing/telemetry/'
const rows = JSON.parse(fs.readFileSync('scripts/.buildable.json', 'utf8'))
const want = process.argv.slice(2)
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
for (const id of want) {
  const r = rows.find(x => String(x.id) === id)
  if (!r) { console.log(`${id}  not in the buildable list`); continue }
  if (fs.existsSync(`src/data/tracks/${id}.json`)) { console.log(`${id}  already built`); continue }
  let done = false
  for (let a = 1; a <= 8 && !done; a++) {
    try {
      const out = execFileSync('node', ['scripts/build-track.mjs', dir + r.file],
        { encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] })
      const pts = (out.match(/stored (\d+) points/) || [])[1]
      const gaps = (out.match(/no OSM geometry: \d+ of \d+ \((\d+)%/) || [])[1]
      if (pts) { console.log(`${id}  ${r.name}: ${pts} points, ${gaps}% without OSM`); done = true }
      else { console.log(`${id}  attempt ${a}: no geometry`) }
    } catch (e) {
      const msg = String(e.stdout || e.message).split('\n').filter(Boolean).pop()
      console.log(`${id}  attempt ${a}: ${msg}`)
    }
    if (!done) sleep(45000)
  }
}
