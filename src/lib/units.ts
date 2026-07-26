// Unit system for every value shown to the user. Telemetry always arrives in SI
// (m/s, °C, litres, kPa), so conversion happens purely at display time — nothing
// downstream of a chart or a HUD ever sees imperial numbers.

export type UnitSystem = 'metric' | 'imperial'

const KPH_PER_MPS = 3.6
const MPH_PER_MPS = 2.236936
const L_PER_GAL = 3.785412
const KPA_PER_PSI = 6.894757
const MM_PER_IN = 25.4
const KM_PER_MI = 1.609344

// ── Speed: telemetry is m/s ──────────────────────────────────────────────────
export const speedFromMps = (mps: number, u: UnitSystem) => mps * (u === 'imperial' ? MPH_PER_MPS : KPH_PER_MPS)
export const speedUnit = (u: UnitSystem) => (u === 'imperial' ? 'mph' : 'km/h')

// Already-converted km/h values (weather panel, corner tables)
export const speedFromKph = (kph: number, u: UnitSystem) => (u === 'imperial' ? kph / KM_PER_MI : kph)

// ── Temperature: telemetry is °C ─────────────────────────────────────────────
export const tempFromC = (c: number, u: UnitSystem) => (u === 'imperial' ? c * 9 / 5 + 32 : c)
export const tempUnit = (u: UnitSystem) => (u === 'imperial' ? '°F' : '°C')

// ── Fuel: telemetry is litres ────────────────────────────────────────────────
export const fuelFromL = (l: number, u: UnitSystem) => (u === 'imperial' ? l / L_PER_GAL : l)
export const fuelUnit = (u: UnitSystem) => (u === 'imperial' ? 'gal' : 'L')

// ── Pressure: telemetry is kPa ───────────────────────────────────────────────
export const pressureFromKpa = (kpa: number, u: UnitSystem) => (u === 'imperial' ? kpa / KPA_PER_PSI : kpa)
export const pressureUnit = (u: UnitSystem) => (u === 'imperial' ? 'psi' : 'kPa')

// ── Small distances: telemetry is mm (ride height, travel) ───────────────────
export const lengthFromMm = (mm: number, u: UnitSystem) => (u === 'imperial' ? mm / MM_PER_IN : mm)
export const lengthUnitMm = (u: UnitSystem) => (u === 'imperial' ? 'in' : 'mm')

// Convert a value that a channel group already produced in a metric unit
export function convertByUnit(value: number, metricUnit: string, u: UnitSystem): number {
  if (u === 'metric') return value
  switch (metricUnit) {
    case 'km/h': return value / KM_PER_MI
    case '°C':   return value * 9 / 5 + 32
    case 'kPa':  return value / KPA_PER_PSI
    case 'L':    return value / L_PER_GAL
    case 'mm':   return value / MM_PER_IN
    default:     return value
  }
}

// Imperial label for a metric one; anything without an imperial form stays put
export function unitLabel(metricUnit: string, u: UnitSystem): string {
  if (u === 'metric') return metricUnit
  switch (metricUnit) {
    case 'km/h': return 'mph'
    case '°C':   return '°F'
    case 'kPa':  return 'psi'
    case 'L':    return 'gal'
    case 'mm':   return 'in'
    default:     return metricUnit
  }
}
