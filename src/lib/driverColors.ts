import type { ColorKey } from '@/types'

export interface DriverColor {
  border: string   // left border + avatar ring
  bg: string       // card background (dark semi-transparent tint)
  text: string     // primary text color (light, readable on dark)
  dot: string      // dot in driver rail
  avatarBg: string // avatar circle background
}

export const COLOR_MAP: Record<ColorKey, DriverColor> = {
  'driver-1': { border: '#60a5fa', bg: 'rgba(59,130,246,0.13)',  text: '#93c5fd', dot: '#60a5fa', avatarBg: 'rgba(59,130,246,0.25)'  }, // blue
  'driver-2': { border: '#34d399', bg: 'rgba(16,185,129,0.13)',  text: '#6ee7b7', dot: '#34d399', avatarBg: 'rgba(16,185,129,0.25)'  }, // emerald
  'driver-3': { border: '#fbbf24', bg: 'rgba(245,158,11,0.13)',  text: '#fde68a', dot: '#fbbf24', avatarBg: 'rgba(245,158,11,0.25)'  }, // amber
  'driver-4': { border: '#a78bfa', bg: 'rgba(139,92,246,0.13)',  text: '#c4b5fd', dot: '#a78bfa', avatarBg: 'rgba(139,92,246,0.25)'  }, // violet
  'driver-5': { border: '#fb7185', bg: 'rgba(244,63,94,0.13)',   text: '#fda4af', dot: '#fb7185', avatarBg: 'rgba(244,63,94,0.25)'   }, // rose
  'driver-6': { border: '#22d3ee', bg: 'rgba(6,182,212,0.13)',   text: '#67e8f9', dot: '#22d3ee', avatarBg: 'rgba(6,182,212,0.25)'   }, // cyan
  'broker':   { border: '#94a3b8', bg: 'rgba(100,116,139,0.13)', text: '#cbd5e1', dot: '#94a3b8', avatarBg: 'rgba(100,116,139,0.25)' }, // slate
}

export const UNASSIGNED_COLOR: DriverColor = {
  border: '#fbbf24',
  bg: 'rgba(251,191,36,0.13)',
  text: '#fde68a',
  dot: '#fbbf24',
  avatarBg: 'rgba(251,191,36,0.25)',
}

export function getColor(colorKey?: ColorKey | null): DriverColor {
  if (!colorKey) return UNASSIGNED_COLOR
  return COLOR_MAP[colorKey] ?? UNASSIGNED_COLOR
}
