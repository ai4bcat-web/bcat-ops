/**
 * One Save for the whole Load Review rail (Ryne 2026-11-16: "You should be able to click save on the whole rail and it should
 * update any information that got updated"). Each section that has unsaved edits registers a pending save here; the rail's
 * footer runs them all in one go, in a fixed order (the customer first, then the order and stops, then charges and tags), and
 * re-runs the review once at the end. A section that fails keeps its edits and shows its own error; the others still save.
 */
import { createContext, useContext, useEffect, useRef } from 'react'

export interface PendingSave {
  /** Shown in the footer and in the leave-with-unsaved-changes prompt. */
  label: string
  /** Lower saves first: customer 0, PO 10, stops 20, driver 30, division 40, sales rep 50, charges 60. */
  order: number
  /** Saves the section's edits through its own server action and clears its draft. Throws on failure. */
  run: () => Promise<unknown>
}

export interface RailSaveRegistry {
  set: (key: string, pending: PendingSave | null) => void
  /** The last failure per section, in plain English (cleared when the section saves or its edits are undone). */
  errorOf: (key: string) => string | null
}

export const RailSaveContext = createContext<RailSaveRegistry | null>(null)

/** Registers (or clears) a section's pending save. `pending` is read at save time, so its draft is always current. */
export function useRailPending(key: string, pending: PendingSave | null): string | null {
  const registry = useContext(RailSaveContext)
  const latest = useRef(pending)
  useEffect(() => { latest.current = pending })
  const dirty = pending != null
  const label = pending?.label
  const order = pending?.order
  useEffect(() => {
    if (!registry) return
    registry.set(key, dirty ? { label: label ?? key, order: order ?? 99, run: () => latest.current?.run() ?? Promise.resolve() } : null)
  }, [registry, key, dirty, label, order])
  useEffect(() => () => registry?.set(key, null), [registry, key])
  return registry?.errorOf(key) ?? null
}

/** Server messages a person should never see, mapped to what to do. */
export function plainSaveError(label: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  if (/must be a string|is required|cannot be empty/i.test(raw) && /^\w+ (must be|is required|cannot be)/.test(raw)) {
    return `${label} could not be saved: a required field is missing (${raw}). Fill it in and save again.`
  }
  if (/conditional|version|changed since|stale|updatedAt/i.test(raw)) {
    return `${label} could not be saved because someone else changed it meanwhile. Re-check, then save again.`
  }
  return `${label} could not be saved: ${raw || 'unknown error'}`
}

/** Runs every pending save in order. Returns the failures by section key (empty when everything saved). */
export async function runPendingSaves(pending: ReadonlyMap<string, PendingSave>): Promise<Map<string, string>> {
  const failures = new Map<string, string>()
  const ordered = [...pending.entries()].sort((a, b) => a[1].order - b[1].order)
  for (const [key, save] of ordered) {
    try { await save.run() } catch (err) { failures.set(key, plainSaveError(save.label, err)) }
  }
  return failures
}
