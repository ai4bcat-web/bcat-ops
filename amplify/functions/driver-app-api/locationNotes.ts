/**
 * A driver's comments on a place (Location.driverNotes). Each entry is {at, driverId, by,
 * text}; `at` plus `driverId` is the key — a driver can only touch their own.
 */
export interface StoredDriverNote { at?: string; driverId?: string; by?: string; text?: string }

export function parseDriverNotes(raw: unknown): StoredDriverNote[] {
  const v = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown } catch { return [] } })() : raw
  return Array.isArray(v) ? (v as StoredDriverNote[]).filter((n) => n && typeof n === 'object' && typeof n.text === 'string') : []
}

/** The index of this driver's note stamped `at`, or -1. */
export function ownNoteIndex(notes: readonly StoredDriverNote[], driverId: string, at: string): number {
  return notes.findIndex((n) => n.at === at && n.driverId === driverId)
}

export function withNoteText(notes: readonly StoredDriverNote[], i: number, text: string): StoredDriverNote[] {
  return notes.map((n, j) => (j === i ? { ...n, text } : n))
}

export function withoutNote(notes: readonly StoredDriverNote[], i: number): StoredDriverNote[] {
  return notes.filter((_, j) => j !== i)
}
