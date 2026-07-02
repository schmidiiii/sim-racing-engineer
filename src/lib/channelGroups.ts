export interface ChannelGroupDef {
  label: string
  channels: string[]
  units?: Record<string, string>
}

export const CHANNEL_GROUPS: ChannelGroupDef[] = [
  {
    label: 'General',
    channels: ['Speed', 'Throttle', 'Brake', 'Gear'],
  },
  {
    label: 'Steering',
    channels: ['SteeringWheelAngle', 'SteeringWheelTorque'],
  },
  {
    label: 'Wheel Speed',
    channels: ['LFspeed', 'RFspeed', 'LRspeed', 'RRspeed'],
  },
  {
    label: 'Suspension',
    channels: ['LFshockDefl', 'RFshockDefl', 'LRshockDefl', 'RRshockDefl'],
  },
  {
    label: 'Tyres',
    channels: ['LFtempCL', 'RFtempCL', 'LRtempCL', 'RRtempCL'],
  },
  {
    label: 'Engine',
    channels: ['RPM', 'FuelLevel', 'FuelUsePerHour', 'OilTemp'],
  },
]
