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
  'driver-1':  { border: '#1d4ed8', bg: 'rgba(29,78,216,0.10)',    text: '#1e3a8a', dot: '#1d4ed8', avatarBg: '#3b82f6'  }, // blue
  'driver-2':  { border: '#ca8a04', bg: 'rgba(202,138,4,0.10)',    text: '#713f12', dot: '#ca8a04', avatarBg: '#eab308'  }, // yellow
  'driver-3':  { border: '#d97706', bg: 'rgba(217,119,6,0.10)',    text: '#92400e', dot: '#d97706', avatarBg: '#f59e0b'  }, // amber
  'driver-4':  { border: '#7c3aed', bg: 'rgba(124,58,237,0.10)',   text: '#4c1d95', dot: '#7c3aed', avatarBg: '#8b5cf6'  }, // violet
  'driver-5':  { border: '#0284c7', bg: 'rgba(2,132,199,0.10)',    text: '#0c4a6e', dot: '#0284c7', avatarBg: '#0ea5e9'  }, // sky
  'driver-6':  { border: '#0891b2', bg: 'rgba(8,145,178,0.10)',    text: '#164e63', dot: '#0891b2', avatarBg: '#06b6d4'  }, // cyan
  // Row 2
  'driver-7':  { border: '#4338ca', bg: 'rgba(67,56,202,0.10)',    text: '#312e81', dot: '#4338ca', avatarBg: '#6366f1'  }, // indigo
  'driver-8':  { border: '#a21caf', bg: 'rgba(162,28,175,0.10)',   text: '#701a75', dot: '#a21caf', avatarBg: '#d946ef'  }, // fuchsia
  'driver-9':  { border: '#ea580c', bg: 'rgba(234,88,12,0.10)',    text: '#7c2d12', dot: '#ea580c', avatarBg: '#f97316'  }, // orange
  'driver-10': { border: '#0d9488', bg: 'rgba(13,148,136,0.10)',   text: '#134e4a', dot: '#0d9488', avatarBg: '#14b8a6'  }, // teal
  'driver-11': { border: '#9333ea', bg: 'rgba(147,51,234,0.10)',   text: '#581c87', dot: '#9333ea', avatarBg: '#a855f7'  }, // purple
  'driver-12': { border: '#db2777', bg: 'rgba(219,39,119,0.10)',   text: '#831843', dot: '#db2777', avatarBg: '#ec4899'  }, // pink
  // Broker
  'broker':    { border: '#64748b', bg: 'rgba(100,116,139,0.08)',  text: '#334155', dot: '#64748b', avatarBg: '#94a3b8'  }, // slate
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

// ── Load highlight palette — highlighter-marker style ─────────────────────────
// Used for load.colorKey planning colors. Deliberately distinct from driver identity colors.
export const LOAD_HIGHLIGHT_PALETTE: { key: ColorKey; hex: string; label: string }[] = [
  { key: 'driver-1',  hex: '#FDE047', label: 'Yellow'  },
  { key: 'driver-2',  hex: '#FDBA74', label: 'Orange'  },
  { key: 'driver-3',  hex: '#F9A8D4', label: 'Pink'    },
  { key: 'driver-4',  hex: '#F0ABFC', label: 'Fuchsia' },
  { key: 'driver-5',  hex: '#C4B5FD', label: 'Violet'  },
  { key: 'driver-6',  hex: '#93C5FD', label: 'Blue'    },
  { key: 'driver-7',  hex: '#67E8F9', label: 'Cyan'    },
  { key: 'driver-8',  hex: '#5EEAD4', label: 'Teal'    },
  { key: 'driver-9',  hex: '#BEF264', label: 'Lime'    },
  { key: 'driver-10', hex: '#A5B4FC', label: 'Indigo'  },
  { key: 'driver-11', hex: '#7DD3FC', label: 'Sky'     },
  { key: 'driver-12', hex: '#FDA4AF', label: 'Rose'    },
]

export function getHighlightHex(colorKey?: ColorKey | null): string | null {
  if (!colorKey || colorKey === 'broker') return null
  return LOAD_HIGHLIGHT_PALETTE.find((p) => p.key === colorKey)?.hex ?? null
}
