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
    channels: ['SteeringWheelAngle'],
  },
  {
    label: 'Wheel Speed',
    channels: ['LFspeed', 'RFspeed', 'LRspeed', 'RRspeed'],
  },
  {
    label: 'Suspension',
    channels: ['LFshockDefl', 'RFshockDefl', 'LRshockDefl', 'RRshockDefl'],
  },
]
