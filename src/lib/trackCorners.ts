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

// ─── GPS corner definitions (high-precision tracks) ────────────────────────

const SUMMIT_POINT_MAIN: CornerDef[] = [
  { turn: 1,  lat: 39.2136, lon: -77.8702 },
  { turn: 2,  lat: 39.2101, lon: -77.8723 },
  { turn: 3,  lat: 39.2073, lon: -77.8736 },
  { turn: 4,  lat: 39.2073, lon: -77.8779 },
  { turn: 5,  lat: 39.2068, lon: -77.8795 },
  { turn: 6,  lat: 39.2047, lon: -77.8826 },
  { turn: 7,  lat: 39.2074, lon: -77.8855 },
  { turn: 8,  lat: 39.2103, lon: -77.8859 },
  { turn: 9,  lat: 39.2115, lon: -77.8843 },
  { turn: 10, lat: 39.2134, lon: -77.8812 },
]

const ROAD_ATLANTA: CornerDef[] = [
  { turn: 1,  name: 'T1',           lat: 34.1518, lon: -83.8153 },
  { turn: 2,  name: 'T2',           lat: 34.1514, lon: -83.8130 },
  { turn: 3,  name: 'T3',           lat: 34.1512, lon: -83.8098 },
  { turn: 4,  name: 'T4/Esses',     lat: 34.1500, lon: -83.8071 },
  { turn: 5,  name: 'T5',           lat: 34.1492, lon: -83.8043 },
  { turn: 6,  name: 'T6',           lat: 34.1481, lon: -83.8033 },
  { turn: 7,  name: 'T7 (Hairpin)', lat: 34.1459, lon: -83.8053 },
  { turn: 8,  name: 'T8',           lat: 34.1465, lon: -83.8082 },
  { turn: 9,  name: 'T9',           lat: 34.1478, lon: -83.8114 },
  { turn: 10, name: 'T10',          lat: 34.1488, lon: -83.8141 },
  { turn: 11, name: 'T11',          lat: 34.1504, lon: -83.8163 },
  { turn: 12, name: 'T12 (Bridge)', lat: 34.1518, lon: -83.8173 },
]

const SPA: CornerDef[] = [
  { turn: 1,  name: 'La Source',    lat: 50.4373, lon: 5.9709 },
  { turn: 2,  name: 'Eau Rouge',    lat: 50.4355, lon: 5.9678 },
  { turn: 3,  name: 'Raidillon',    lat: 50.4371, lon: 5.9661 },
  { turn: 4,  name: 'Les Combes',   lat: 50.4432, lon: 5.9623 },
  { turn: 5,  name: 'Malmedy',      lat: 50.4449, lon: 5.9643 },
  { turn: 6,  name: 'Rivage',       lat: 50.4464, lon: 5.9692 },
  { turn: 7,  name: 'Pouhon',       lat: 50.4450, lon: 5.9822 },
  { turn: 8,  name: 'Les Fagnes',   lat: 50.4411, lon: 5.9882 },
  { turn: 9,  name: 'Stavelot',     lat: 50.4385, lon: 5.9940 },
  { turn: 10, name: 'Blanchimont',  lat: 50.4328, lon: 5.9882 },
  { turn: 11, name: 'Bus Stop',     lat: 50.4348, lon: 5.9768 },
]

const WATKINS_GLEN_FULL: CornerDef[] = [
  { turn: 1,  name: 'The 90',            lat: 42.3363, lon: -76.9272 },
  { turn: 2,  name: 'Outer Loop',        lat: 42.3340, lon: -76.9249 },
  { turn: 3,  name: 'Inner Loop entry',  lat: 42.3317, lon: -76.9258 },
  { turn: 4,  name: 'Inner Loop exit',   lat: 42.3304, lon: -76.9270 },
  { turn: 5,  name: 'Toe of Boot',       lat: 42.3290, lon: -76.9298 },
  { turn: 6,  name: 'Heel of Boot',      lat: 42.3296, lon: -76.9323 },
  { turn: 7,  name: 'Laces',             lat: 42.3313, lon: -76.9340 },
  { turn: 8,  name: 'T8',               lat: 42.3341, lon: -76.9328 },
  { turn: 9,  name: 'T9',               lat: 42.3353, lon: -76.9312 },
  { turn: 10, name: 'Bus Stop',          lat: 42.3367, lon: -76.9294 },
  { turn: 11, name: 'T11',              lat: 42.3378, lon: -76.9278 },
]

const LAGUNA_SECA: CornerDef[] = [
  { turn: 1,  lat: 36.5843, lon: -121.7546 },
  { turn: 2,  lat: 36.5848, lon: -121.7524 },
  { turn: 3,  lat: 36.5836, lon: -121.7506 },
  { turn: 4,  lat: 36.5815, lon: -121.7495 },
  { turn: 5,  lat: 36.5797, lon: -121.7515 },
  { turn: 6,  lat: 36.5800, lon: -121.7548 },
  { turn: 7,  lat: 36.5789, lon: -121.7574 },
  { turn: 8,  name: 'Corkscrew entry', lat: 36.5808, lon: -121.7590 },
  { turn: 9,  name: 'Corkscrew exit',  lat: 36.5820, lon: -121.7594 },
  { turn: 10, lat: 36.5832, lon: -121.7580 },
  { turn: 11, lat: 36.5840, lon: -121.7563 },
]

// ─── Count-only tracks (GPS curvature selects best N peaks) ────────────────

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

// ─── GPS track registry ────────────────────────────────────────────────────

const GPS_DB: { pattern: RegExp; corners: CornerDef[] }[] = [
  { pattern: /summit point/i,  corners: SUMMIT_POINT_MAIN },
  { pattern: /road atlanta/i,  corners: ROAD_ATLANTA },
  { pattern: /spa/i,           corners: SPA },
  { pattern: /watkins glen/i,  corners: WATKINS_GLEN_FULL },
  { pattern: /laguna seca/i,   corners: LAGUNA_SECA },
]

/** Returns GPS corner definitions for a track if available, otherwise null. */
export function getCornersForTrack(trackName: string): CornerDef[] | null {
  const entry = GPS_DB.find(e => e.pattern.test(trackName))
  return entry ? entry.corners : null
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
