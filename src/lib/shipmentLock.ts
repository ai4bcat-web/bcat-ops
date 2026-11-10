/** The 10-minute shipment edit lock, as the client reads it off a row. */
export interface LockFields { editLockUserId?: string | null; editLockUserName?: string | null; editLockExpiresAt?: string | null }

export const LOCK_REFRESH_MS = 4 * 60_000

/**
 * A form nobody has touched for this long no longer holds the lock: the refresh tick lets go of it instead of renewing it, so a tab
 * left open (or forgotten) frees the shipment within LOCK_IDLE_MS + LOCK_REFRESH_MS, and taking it back is automatic when the person returns.
 */
export const LOCK_IDLE_MS = 3 * 60_000

/** Who holds a live lock other than `me`, or null when it is free, expired or mine. */
export function lockHeldByOther(row: LockFields | null | undefined, me: string | null | undefined, nowMs: number): { by: string; until: string } | null {
  if (!row?.editLockUserId || !row.editLockExpiresAt) return null
  const until = Date.parse(row.editLockExpiresAt)
  if (!Number.isFinite(until) || until <= nowMs) return null
  if (me && row.editLockUserId.toLowerCase() === me.toLowerCase()) return null
  return { by: row.editLockUserName || row.editLockUserId, until: row.editLockExpiresAt }
}

/** Whoever holds a live lock on this row (me included), or null when it is free or expired. */
export function liveLockOf(row: LockFields | null | undefined, nowMs: number): { userId: string; by: string; until: string } | null {
  if (!row?.editLockUserId || !row.editLockExpiresAt) return null
  const until = Date.parse(row.editLockExpiresAt)
  if (!Number.isFinite(until) || until <= nowMs) return null
  return { userId: row.editLockUserId, by: row.editLockUserName || row.editLockUserId, until: row.editLockExpiresAt }
}
