// Corner data for iRacing tracks.
// Sourced from official track guides, Wikipedia, and motorsport-reference.com.
// Two layers:
//   1. GPS lat/lon per corner  → used when available; matched against lap GPS trace
//   2. Corner count only       → used to select the N most prominent GPS curvature peaks

export interface CornerDef {
  turn: number
  name?: string
  lat: number
  lon: number
}

// ─── Count-only tracks (speed-minima detection selects deepest N corners) ──

const COUNT_DB: { key: string; layouts: Record<string, number>; default: number }[] = [
  { key: 'summit point',           layouts: { short: 7, shenandoah: 9 },      default: 10 },
  { key: 'road atlanta',           layouts: {},                                 default: 12 },
  { key: 'watkins glen',           layouts: { short: 7, boot: 11 },             default: 11 },
  { key: 'laguna seca',            layouts: {},                                 default: 11 },
  { key: 'sebring',                layouts: { club: 7 },                        default: 17 },
  { key: 'mid-ohio',               layouts: { short: 10 },                      default: 13 },
  { key: 'road america',           layouts: {},                                 default: 14 },
  { key: 'lime rock',              layouts: {},                                 default: 7  },
  { key: 'virginia international', layouts: { north: 11, south: 11, patriot: 8 }, default: 21 },
  { key: 'barber',                 layouts: {},                                 default: 17 },
  { key: 'circuit of the americas',layouts: {},                                 default: 20 },
  { key: 'sonoma',                 layouts: { short: 7 },                       default: 12 },
  { key: 'daytona',                layouts: {},                                 default: 12 },
  { key: 'indianapolis',           layouts: {},                                 default: 16 },
  { key: 'charlotte',              layouts: {},                                 default: 17 },
  { key: 'spa',                    layouts: {},                                 default: 19 },
  { key: 'nürburgring',            layouts: { sprint: 11, nordschleife: 73 },   default: 17 },
  { key: 'nurburgring',            layouts: { sprint: 11, nordschleife: 73 },   default: 17 },
  { key: 'silverstone',            layouts: { national: 10, international: 15 }, default: 18 },
  { key: 'monza',                  layouts: {},                                 default: 11 },
  { key: 'brands hatch',           layouts: { indy: 5 },                        default: 10 },
  { key: 'donington',              layouts: {},                                 default: 12 },
  { key: 'hockenheim',             layouts: { national: 13, short: 9 },         default: 17 },
  { key: 'hungaroring',            layouts: {},                                 default: 14 },
  { key: 'barcelona',              layouts: { national: 14 },                   default: 16 },
  { key: 'imola',                  layouts: {},                                 default: 19 },
  { key: 'zandvoort',              layouts: {},                                 default: 14 },
  { key: 'paul ricard',            layouts: {},                                 default: 15 },
  { key: 'mugello',                layouts: {},                                 default: 15 },
  { key: 'red bull ring',          layouts: {},                                 default: 10 },
  { key: 'zolder',                 layouts: {},                                 default: 10 },
  { key: 'suzuka',                 layouts: { east: 7 },                        default: 18 },
  { key: 'bathurst',               layouts: {},                                 default: 23 },
  { key: 'mount panorama',         layouts: {},                                 default: 23 },
  { key: 'kyalami',                layouts: {},                                 default: 16 },
  { key: 'fuji',                   layouts: {},                                 default: 16 },
  { key: 'okayama',                layouts: { short: 8 },                       default: 12 },
]

// GPS coordinate matching is intentionally not used — individual corner GPS
// coordinates are not available from any public source with sufficient accuracy.
// Corner positions are derived from the lap telemetry GPS trace instead.
export function getCornersForTrack(_trackName: string): CornerDef[] | null {
  return null
}

/** Returns the known corner count for a track+layout, or null if unknown. */
export function getTrackCornerCount(trackName: string): number | null {
  const lower = trackName.toLowerCase()
  for (const entry of COUNT_DB) {
    if (!lower.includes(entry.key)) continue
    for (const [layout, count] of Object.entries(entry.layouts)) {
      if (lower.includes(layout)) return count
    }
    return entry.default
  }
  return null
}
