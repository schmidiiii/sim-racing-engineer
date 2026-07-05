const CORNER: Record<string, string> = {
  LF: 'Left Front', RF: 'Right Front', LR: 'Left Rear', RR: 'Right Rear',
}

const SUFFIX: Record<string, string> = {
  speed: 'Speed',
  shockDefl: 'Shock',
  shockVel: 'Shock Vel.',
  rideHeight: 'Ride Height',
  wheelSlip: 'Slip',
  slip: 'Slip Angle',
  slipRatio: 'Slip Ratio',
  tempL: 'Temp (L)',
  tempM: 'Temp (M)',
  tempR: 'Temp (R)',
  tempCL: 'Temp (L)',
  tempCM: 'Temp (M)',
  tempCR: 'Temp (R)',
  temp: 'Temperature',
  press: 'Pressure',
  pressure: 'Pressure',
}

const EXPLICIT: Record<string, string> = {
  Speed: 'Speed',
  Throttle: 'Throttle',
  Brake: 'Brake',
  Gear: 'Gear',
  RPM: 'RPM',
  OilTemp: 'Oil Temp',
  FuelLevel: 'Fuel Level',
  FuelUsePerHour: 'Fuel Use/h',
  SteeringWheelAngle: 'Steering Angle',
  SteeringWheelTorque: 'Steering Torque',
  dcBrakeBias: 'Brake Bias',
  Pitch: 'Pitch',
  Roll: 'Roll',
}

export function channelLabel(name: string): string {
  if (EXPLICIT[name]) return EXPLICIT[name]
  const corner = Object.keys(CORNER).find(k => name.startsWith(k))
  if (corner) {
    const suffix = name.slice(corner.length)
    return `${CORNER[corner]} ${SUFFIX[suffix] ?? suffix}`
  }
  return name
}

export interface ChannelGroupDef {
  label: string
  viewType?: 'setup' | 'delta' | 'braking' | 'cornerSpeed' | 'lapMap'
  channels: string[]
  units: Record<string, string>
  transforms: Record<string, (v: number) => number>
  yDomains: Record<string, [number | 'auto', number | 'auto']>
  minVarianceToShow?: number  // skip channels with max-min below this threshold
}

const mps2kph = (v: number) => v * 3.6
const ratio2pct = (v: number) => v * 100
const rad2deg = (v: number) => v * (180 / Math.PI)
const m2mm = (v: number) => v * 1000

export const CHANNEL_GROUPS: ChannelGroupDef[] = [
  // ── Driving analysis ──────────────────────────────────────────────────────
  {
    label: 'General',
    channels: ['Speed', 'Throttle', 'Brake', 'Gear'],
    units: { Speed: 'km/h', Throttle: '%', Brake: '%', Gear: '' },
    transforms: { Speed: mps2kph, Throttle: ratio2pct, Brake: ratio2pct },
    yDomains: { Throttle: [0, 100], Brake: [0, 100], Speed: [0, 'auto'], Gear: [0, 'auto'] },
  },
  {
    label: 'Braking',
    viewType: 'braking',
    channels: [],
    units: {},
    transforms: {},
    yDomains: {},
  },
  {
    label: 'Corner Speed',
    viewType: 'cornerSpeed',
    channels: [],
    units: {},
    transforms: {},
    yDomains: {},
  },
  {
    label: 'Delta',
    viewType: 'delta',
    channels: [],
    units: {},
    transforms: {},
    yDomains: {},
  },
  // ── Tyres ─────────────────────────────────────────────────────────────────
  {
    label: 'Tyre Temp',
    // LFtempL/M/R = instantaneous surface temps (dynamic, vary during lap)
    // LFtempCL/CM/CR = static averaged/baseline values (always constant in IBT)
    channels: [
      'LFtempL', 'LFtempM', 'LFtempR',
      'RFtempL', 'RFtempM', 'RFtempR',
      'LRtempL', 'LRtempM', 'LRtempR',
      'RRtempL', 'RRtempM', 'RRtempR',
    ],
    units: Object.fromEntries([
      'LFtempL', 'LFtempM', 'LFtempR',
      'RFtempL', 'RFtempM', 'RFtempR',
      'LRtempL', 'LRtempM', 'LRtempR',
      'RRtempL', 'RRtempM', 'RRtempR',
    ].map(c => [c, '°C'])),
    transforms: {},
    yDomains: {},
    minVarianceToShow: 1,
  },
  {
    label: 'Tyre Pressure',
    channels: ['LFpressure', 'RFpressure', 'LRpressure', 'RRpressure'],
    units: { LFpressure: 'kPa', RFpressure: 'kPa', LRpressure: 'kPa', RRpressure: 'kPa' },
    transforms: {},
    yDomains: {},
  },
  {
    label: 'Wheel Speed',
    channels: ['LFspeed', 'RFspeed', 'LRspeed', 'RRspeed'],
    units: { LFspeed: 'km/h', RFspeed: 'km/h', LRspeed: 'km/h', RRspeed: 'km/h' },
    transforms: { LFspeed: mps2kph, RFspeed: mps2kph, LRspeed: mps2kph, RRspeed: mps2kph },
    yDomains: { LFspeed: [0, 'auto'], RFspeed: [0, 'auto'], LRspeed: [0, 'auto'], RRspeed: [0, 'auto'] },
  },
  {
    label: 'Wheel Spin',
    // Computed slip ratio = (wheel_speed - car_speed) / car_speed * 100
    // Falls back to direct LFwheelSlip channels if present (some iRacing cars have them)
    channels: ['LFslipRatio', 'RFslipRatio', 'LRslipRatio', 'RRslipRatio', 'LFwheelSlip', 'RFwheelSlip', 'LRwheelSlip', 'RRwheelSlip'],
    units: {
      LFslipRatio: '%', RFslipRatio: '%', LRslipRatio: '%', RRslipRatio: '%',
      LFwheelSlip: '%', RFwheelSlip: '%', LRwheelSlip: '%', RRwheelSlip: '%',
    },
    transforms: { LFwheelSlip: ratio2pct, RFwheelSlip: ratio2pct, LRwheelSlip: ratio2pct, RRwheelSlip: ratio2pct },
    yDomains: {},
  },
  // ── Suspension ────────────────────────────────────────────────────────────
  {
    label: 'Ride Height',
    channels: ['LFrideHeight', 'RFrideHeight', 'LRrideHeight', 'RRrideHeight'],
    units: { LFrideHeight: 'mm', RFrideHeight: 'mm', LRrideHeight: 'mm', RRrideHeight: 'mm' },
    transforms: { LFrideHeight: m2mm, RFrideHeight: m2mm, LRrideHeight: m2mm, RRrideHeight: m2mm },
    yDomains: {},
  },
  {
    label: 'Rake',
    channels: ['Pitch', 'Roll'],
    units: { Pitch: 'deg', Roll: 'deg' },
    transforms: { Pitch: rad2deg, Roll: rad2deg },
    yDomains: {},
  },
  {
    label: 'Shocks',
    channels: ['LFshockDefl', 'RFshockDefl', 'LRshockDefl', 'RRshockDefl'],
    units: { LFshockDefl: 'mm', RFshockDefl: 'mm', LRshockDefl: 'mm', RRshockDefl: 'mm' },
    transforms: { LFshockDefl: m2mm, RFshockDefl: m2mm, LRshockDefl: m2mm, RRshockDefl: m2mm },
    yDomains: {},
  },
  {
    label: 'Shocks Hist',
    channels: ['LFshockVel', 'RFshockVel', 'LRshockVel', 'RRshockVel'],
    units: { LFshockVel: 'm/s', RFshockVel: 'm/s', LRshockVel: 'm/s', RRshockVel: 'm/s' },
    transforms: {},
    yDomains: {},
  },
  // ── Car ───────────────────────────────────────────────────────────────────
  {
    label: 'Setup',
    viewType: 'setup',
    channels: [],
    units: {},
    transforms: {},
    yDomains: {},
  },
]
