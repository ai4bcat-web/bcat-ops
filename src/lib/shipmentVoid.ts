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
