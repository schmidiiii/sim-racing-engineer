export interface CornerDef {
  turn: number
  name: string
  lat: number
  lon: number
}

const SPA_CORNERS: CornerDef[] = [
  { turn: 1,  name: 'La Source',   lat: 50.4373, lon: 5.9709 },
  { turn: 2,  name: 'Eau Rouge',   lat: 50.4355, lon: 5.9678 },
  { turn: 3,  name: 'Raidillon',   lat: 50.4371, lon: 5.9661 },
  { turn: 4,  name: 'Les Combes',  lat: 50.4432, lon: 5.9623 },
  { turn: 5,  name: 'Malmedy',     lat: 50.4449, lon: 5.9643 },
  { turn: 6,  name: 'Rivage',      lat: 50.4464, lon: 5.9692 },
  { turn: 7,  name: 'Pouhon',      lat: 50.4450, lon: 5.9822 },
  { turn: 8,  name: 'Les Fagnes',  lat: 50.4411, lon: 5.9882 },
  { turn: 9,  name: 'Stavelot',    lat: 50.4385, lon: 5.9940 },
  { turn: 10, name: 'Blanchimont', lat: 50.4328, lon: 5.9882 },
  { turn: 11, name: 'Bus Stop',    lat: 50.4348, lon: 5.9768 },
]

const TRACK_CORNERS: Array<{ pattern: RegExp; corners: CornerDef[] }> = [
  { pattern: /spa/i, corners: SPA_CORNERS },
]

export function getCornersForTrack(trackName: string): CornerDef[] {
  return TRACK_CORNERS.find(e => e.pattern.test(trackName))?.corners ?? []
}
