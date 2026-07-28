// Orthophoto helpers: fetch official aerial imagery and read the track out of it.
//
// OpenStreetMap gives a centreline but no width, and around the pits its naming
// is ambiguous enough that the line itself drifts off the tarmac. Aerial imagery
// settles both: at 28 cm per pixel a 1.5 m kerb is five pixels across, so the
// real asphalt edge can simply be measured.
//
// Sources are national open-data services, not Google or Bing — those forbid
// deriving your own geometry from their imagery, which is exactly what this does.

import fs from 'node:fs'
import zlib from 'node:zlib'

export const EARTH = 111320

// WMS services covering the circuits we care about, best resolution first.
// `layers` and `crs` differ per service, so each carries its own request shape.
export const ORTHO_SOURCES = [
  {
    name: 'Wallonia ORTHO_LAST',
    // Spa-Francorchamps. Open data, derivative use permitted.
    covers: b => b.lat > 49.4 && b.lat < 50.9 && b.lon > 2.7 && b.lon < 6.5,
    url: (bbox, w, h) =>
      'https://geoservices.wallonie.be/arcgis/services/IMAGERIE/ORTHO_LAST/MapServer/WMSServer'
      + '?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=0&STYLES=&CRS=CRS:84'
      + `&BBOX=${bbox.join(',')}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png`,
  },
  {
    name: 'Baden-Württemberg DOP20',
    // Hockenheimring. LGL open data at 20 cm.
    covers: b => b.lat > 47.5 && b.lat < 49.8 && b.lon > 7.5 && b.lon < 10.5,
    // This one rejects CRS:84 and wants EPSG:4326, which in WMS 1.3.0 means
    // latitude first — hence the swapped bbox
    url: ([west, south, east, north], w, h) =>
      'https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ATKIS_DOP_20_C'
      + '?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=IMAGES_DOP_20_RGB&STYLES=&CRS=EPSG:4326'
      + `&BBOX=${[south, west, north, east].join(',')}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png`,
  },
]

export function pickSource(lat, lon) {
  return ORTHO_SOURCES.find(s => s.covers({ lat, lon })) ?? null
}

// Minimal PNG reader — enough for what these services return (8-bit RGB or RGBA,
// and the palette form one of them uses). No dependency worth pulling in for it.
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20)
  const depth = buf[24], colour = buf[25]
  if (depth !== 8) throw new Error('unsupported bit depth ' + depth)
  let i = 8, idat = [], plte = null, trns = null
  while (i < buf.length - 8) {
    const len = buf.readUInt32BE(i), type = buf.toString('ascii', i + 4, i + 8)
    if (type === 'IDAT') idat.push(buf.slice(i + 8, i + 8 + len))
    else if (type === 'PLTE') plte = buf.slice(i + 8, i + 8 + len)
    else if (type === 'tRNS') trns = buf.slice(i + 8, i + 8 + len)
    else if (type === 'IEND') break
    i += 12 + len
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour]
  if (!channels) throw new Error('unsupported colour type ' + colour)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let o = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[o++]
    const line = raw.slice(o, o + stride); o += stride
    const cur = out.slice(y * stride, (y + 1) * stride)
    const prev = y ? out.slice((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      cur[x] = v & 255
    }
  }
  // Normalise everything to RGB so callers need not care
  const rgb = Buffer.alloc(width * height * 3)
  for (let p = 0; p < width * height; p++) {
    let r, g, bl
    if (colour === 3) { const k = out[p]; r = plte[k * 3]; g = plte[k * 3 + 1]; bl = plte[k * 3 + 2] }
    else if (colour === 0 || colour === 4) { r = g = bl = out[p * channels] }
    else { r = out[p * channels]; g = out[p * channels + 1]; bl = out[p * channels + 2] }
    rgb[p * 3] = r; rgb[p * 3 + 1] = g; rgb[p * 3 + 2] = bl
  }
  return { width, height, rgb, hasAlpha: colour === 4 || colour === 6 || !!trns }
}

// A fetched tile, with the geo-referencing needed to look pixels up by position
export class Tile {
  constructor(bbox, img) {
    this.bbox = bbox                    // [west, south, east, north]
    this.img = img
  }
  // Nearest-pixel sample; null outside the tile
  at(lat, lon) {
    const [w, s, e, n] = this.bbox
    if (lon < w || lon > e || lat < s || lat > n) return null
    const px = Math.min(this.img.width - 1, Math.floor((lon - w) / (e - w) * this.img.width))
    const py = Math.min(this.img.height - 1, Math.floor((n - lat) / (n - s) * this.img.height))
    const o = (py * this.img.width + px) * 3
    return [this.img.rgb[o], this.img.rgb[o + 1], this.img.rgb[o + 2]]
  }
}

export async function fetchTile(source, bbox, w, h, cacheDir) {
  const key = `${source.name.replace(/\W+/g, '_')}_${bbox.map(v => v.toFixed(5)).join('_')}_${w}x${h}.png`
  const path = cacheDir ? `${cacheDir}/${key}` : null
  if (path && fs.existsSync(path)) return new Tile(bbox, decodePng(fs.readFileSync(path)))
  const r = await fetch(source.url(bbox, w, h), {
    headers: { 'User-Agent': 'sim-racing-engineer track builder' },
  })
  const body = Buffer.from(await r.arrayBuffer())
  const ct = r.headers.get('content-type') || ''
  if (!r.ok || !ct.includes('image')) {
    throw new Error(`${source.name}: HTTP ${r.status} ${ct} ${body.toString('latin1').slice(0, 120)}`)
  }
  if (path) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(path, body) }
  return new Tile(bbox, decodePng(body))
}

// Is this pixel asphalt? Track surface is grey: low saturation, mid to dark.
// Grass and trees are green, gravel and sand are warm, paint is near-white.
export function isAsphalt([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
  const sat = mx ? (mx - mn) / mx : 0
  return sat < 0.20 && mx > 40 && mx < 165
}

// Track paint: bright and unsaturated. Kerbs are the saturated red/yellow ones.
export function isPaint([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
  return mx > 165 && (mx ? (mx - mn) / mx : 0) < 0.18
}

export function isKerb([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
  const sat = mx ? (mx - mn) / mx : 0
  // red or yellow, clearly coloured and bright
  return mx > 90 && sat > 0.30 && r >= g && g >= b - 20
}

// Bilinear sample, so a profile stepped finer than the pixel grid varies
// smoothly instead of staircasing
export function sampleSmooth(tile, lat, lon) {
  const [w, s, e, n] = tile.bbox
  if (lon < w || lon > e || lat < s || lat > n) return null
  const { width, height, rgb } = tile.img
  const fx = (lon - w) / (e - w) * width - 0.5
  const fy = (n - lat) / (n - s) * height - 0.5
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(fx)))
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(fy)))
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1)
  const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0))
  const px = (x, y, c) => rgb[(y * width + x) * 3 + c]
  const out = []
  for (let c = 0; c < 3; c++) {
    const a = px(x0, y0, c) * (1 - tx) + px(x1, y0, c) * tx
    const b = px(x0, y1, c) * (1 - tx) + px(x1, y1, c) * tx
    out.push(a * (1 - ty) + b * ty)
  }
  return out
}

export const luminance = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b

// Find the painted track edge along one side of a profile.
//
// The asphalt-versus-grass test cannot work at a modern circuit: the runoff is
// asphalt too, so there is no material change to find. What does mark the edge
// is the white line, and although at 28 cm per pixel it is only about half a
// pixel wide, it still lifts the pixels it touches well clear of the tarmac
// around them. So this looks for that ridge — brightness above the local
// surroundings — rather than for a change of surface.
export function findPaintedEdge(profile, step, minM, maxM) {
  const n = profile.length
  const lo = Math.round(minM / step), hi = Math.min(n - 1, Math.round(maxM / step))
  const WIN = Math.max(2, Math.round(1.5 / step))     // compare against ±1.5 m
  let best = null
  for (let i = lo; i <= hi; i++) {
    let around = 0, count = 0
    for (let k = i - WIN; k <= i + WIN; k++) {
      if (k < 0 || k >= n || Math.abs(k - i) <= 1) continue
      around += profile[k]; count++
    }
    if (!count) continue
    const ridge = profile[i] - around / count
    if (!best || ridge > best.ridge) best = { at: i * step, ridge }
  }
  return best
}
