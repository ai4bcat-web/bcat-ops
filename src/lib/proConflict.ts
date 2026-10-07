/**
 * Is this Pro # free to use on the load being saved?
 *
 * Two loads must never share a Pro #: it is the key everything downstream joins on —
 * PODs, rate cons, the factoring queue, the driver apps. So a save that would CREATE
 * that state is refused.
 *
 * But a save that merely leaves an existing collision in place must not be. On 7 Oct
 * a double-click on "Create Load" produced two records for 14578, and the refusal then
 * locked BOTH copies: every edit of either one — moving a date, assigning a driver —
 * was rejected for a duplicate the editor had not introduced and could not see. The
 * right response to pre-existing bad data is to say so and let the work proceed; the
 * duplicate gets cleaned up separately.
 *
 * Pure so the three outcomes can be pinned without a form.
 */
export interface ProConflictLoad { id: string; aljexId?: string | null }

export type ProConflict =
  | { kind: 'none' }
  /** The save would introduce the collision: refuse it. */
  | { kind: 'block'; other: ProConflictLoad }
  /** The collision was already there before this edit: allow it, but say so. */
  | { kind: 'warn'; other: ProConflictLoad }

const norm = (s: string | null | undefined) => (s ?? '').trim()

export function proConflict(
  loads: readonly ProConflictLoad[],
  aljexId: string | null | undefined,
  /** The load being edited; null/undefined when creating. */
  current?: ProConflictLoad | null,
): ProConflict {
  const pro = norm(aljexId)
  if (!pro) return { kind: 'none' }
  const other = loads.find((l) => l.id !== current?.id && norm(l.aljexId) === pro)
  if (!other) return { kind: 'none' }
  const introduced = !current || norm(current.aljexId) !== pro
  return introduced ? { kind: 'block', other } : { kind: 'warn', other }
}
