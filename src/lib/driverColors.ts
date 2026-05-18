import type { ColorKey } from '@/types'

export interface DriverColor {
  border: string   // left border + avatar ring
  bg: string       // card background (light tint)
  text: string     // primary text color
  dot: string      // dot in driver rail
  avatarBg: string // avatar circle background
}

export const COLOR_MAP: Record<ColorKey, DriverColor> = {
  // Row 1
  'driver-1':  { border: '#60a5fa', bg: 'rgba(96,165,250,0.10)',   text: '#1d4ed8', dot: '#60a5fa', avatarBg: '#93c5fd'  }, // sky blue
  'driver-2':  { border: '#34d399', bg: 'rgba(52,211,153,0.10)',   text: '#065f46', dot: '#34d399', avatarBg: '#6ee7b7'  }, // mint
  'driver-3':  { border: '#fbbf24', bg: 'rgba(251,191,36,0.10)',   text: '#92400e', dot: '#fbbf24', avatarBg: '#fcd34d'  }, // amber
  'driver-4':  { border: '#a78bfa', bg: 'rgba(167,139,250,0.10)',  text: '#5b21b6', dot: '#a78bfa', avatarBg: '#c4b5fd'  }, // lavender
  'driver-5':  { border: '#fb7185', bg: 'rgba(251,113,133,0.10)',  text: '#9f1239', dot: '#fb7185', avatarBg: '#fda4af'  }, // rose
  'driver-6':  { border: '#22d3ee', bg: 'rgba(34,211,238,0.10)',   text: '#0e7490', dot: '#22d3ee', avatarBg: '#67e8f9'  }, // cyan
  // Row 2
  'driver-7':  { border: '#818cf8', bg: 'rgba(129,140,248,0.10)',  text: '#3730a3', dot: '#818cf8', avatarBg: '#a5b4fc'  }, // indigo
  'driver-8':  { border: '#e879f9', bg: 'rgba(232,121,249,0.10)',  text: '#86198f', dot: '#e879f9', avatarBg: '#f0abfc'  }, // fuchsia
  'driver-9':  { border: '#fb923c', bg: 'rgba(251,146,60,0.10)',   text: '#9a3412', dot: '#fb923c', avatarBg: '#fdba74'  }, // orange
  'driver-10': { border: '#2dd4bf', bg: 'rgba(45,212,191,0.10)',   text: '#0f766e', dot: '#2dd4bf', avatarBg: '#5eead4'  }, // teal
  'driver-11': { border: '#a3e635', bg: 'rgba(163,230,53,0.10)',   text: '#3f6212', dot: '#a3e635', avatarBg: '#bef264'  }, // lime
  'driver-12': { border: '#f472b6', bg: 'rgba(244,114,182,0.10)',  text: '#9d174d', dot: '#f472b6', avatarBg: '#f9a8d4'  }, // pink
  // Broker
  'broker':    { border: '#94a3b8', bg: 'rgba(148,163,184,0.08)',  text: '#475569', dot: '#94a3b8', avatarBg: '#cbd5e1'  }, // slate
}

export const UNASSIGNED_COLOR: DriverColor = {
  border: '#cbd5e1',
  bg: 'rgba(203,213,225,0.10)',
  text: '#64748b',
  dot: '#cbd5e1',
  avatarBg: '#e2e8f0',
}

export function getColor(colorKey?: ColorKey | null): DriverColor {
  if (!colorKey) return UNASSIGNED_COLOR
  return COLOR_MAP[colorKey] ?? UNASSIGNED_COLOR
}
