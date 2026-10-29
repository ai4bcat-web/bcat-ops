/**
 * The client's view of "this shipment is void".
 *
 * Step R made `voidedAt` the only way out of a working set, but every shipment
 * soft-deleted before R still carries `deletedAt` and nothing else. Both markers mean
 * the same thing — the shipment has left the board — so every client reader has to
 * look at both. The Lambda-side twin lives in `amplify/functions/_shared/voided.ts`;
 * this is the `src/` half, importable by the pure libs and the hooks.
 */
export function isShipmentVoided(
  s: { voidedAt?: string | null; deletedAt?: string | null } | null | undefined,
): boolean {
  return Boolean(s?.voidedAt || s?.deletedAt)
}

/**
 * The same question asked of a load.
 *
 * The calendar, dispatch, the appointment queue, the settlements and the pay
 * hooks all read the Load table and never join a shipment, so Step R mirrors the
 * void onto the load itself. A load whose shipment was voided is not live work:
 * it is out of every working set, and only the Voided tab, the shipment's
 * History tab and the audit log still show it.
 */
export function isLoadVoided(l: { voidedAt?: string | null } | null | undefined): boolean {
  return Boolean(l?.voidedAt)
}
