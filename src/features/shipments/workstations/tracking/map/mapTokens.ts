import type { MapTone } from './mapModel'

/** Kit tokens both renderers paint with; resolved by `useTmsTokens`, never literals. */
export const MAP_TOKENS = [
  '--tms-primary', '--tms-card', '--tms-surface', '--tms-muted', '--tms-border',
  '--tms-badge-blue', '--tms-badge-blue-tint', '--tms-badge-green', '--tms-badge-orange', '--tms-badge-red',
] as const

export type MapColours = Record<(typeof MAP_TOKENS)[number], string>

/** green < 15 min, amber 15-60, gray after that. */
export function toneColour(tone: MapTone, tk: MapColours): string {
  if (tone === 'fresh') return tk['--tms-badge-green']
  return tone === 'aging' ? tk['--tms-badge-orange'] : tk['--tms-muted']
}
