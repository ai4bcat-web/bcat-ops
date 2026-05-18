import type { ColorKey } from '@/types'

export interface DriverColor {
  border: string   // left border + avatar ring
  bg: string       // card background (dark semi-transparent tint)
  text: string     // primary text color (light, readable on dark)
  dot: string      // dot in driver rail
  avatarBg: string // avatar circle background
}

export const COLOR_MAP: Record<ColorKey, DriverColor> = {
  'driver-1': { border: '#2563eb', bg: 'rgba(59,130,246,0.08)',  text: '#1d4ed8', dot: '#3b82f6', avatarBg: 'rgba(59,130,246,0.18)'  }, // blue
  'driver-2': { border: '#059669', bg: 'rgba(16,185,129,0.08)',  text: '#065f46', dot: '#10b981', avatarBg: 'rgba(16,185,129,0.18)'  }, // emerald
  'driver-3': { border: '#d97706', bg: 'rgba(245,158,11,0.08)',  text: '#92400e', dot: '#f59e0b', avatarBg: 'rgba(245,158,11,0.18)'  }, // amber
  'driver-4': { border: '#7c3aed', bg: 'rgba(139,92,246,0.08)',  text: '#4c1d95', dot: '#8b5cf6', avatarBg: 'rgba(139,92,246,0.18)'  }, // violet
  'driver-5': { border: '#e11d48', bg: 'rgba(244,63,94,0.08)',   text: '#9f1239', dot: '#f43f5e', avatarBg: 'rgba(244,63,94,0.18)'   }, // rose
  'driver-6': { border: '#0891b2', bg: 'rgba(6,182,212,0.08)',   text: '#164e63', dot: '#06b6d4', avatarBg: 'rgba(6,182,212,0.18)'   }, // cyan
  'broker':   { border: '#475569', bg: 'rgba(100,116,139,0.08)', text: '#1e293b', dot: '#64748b', avatarBg: 'rgba(100,116,139,0.18)' }, // slate
}

export const UNASSIGNED_COLOR: DriverColor = {
  border: '#9ca3af',
  bg: 'rgba(156,163,175,0.10)',
  text: '#374151',
  dot: '#9ca3af',
  avatarBg: 'rgba(156,163,175,0.20)',
}

export function getColor(colorKey?: ColorKey | null): DriverColor {
  if (!colorKey) return UNASSIGNED_COLOR
  return COLOR_MAP[colorKey] ?? UNASSIGNED_COLOR
}
