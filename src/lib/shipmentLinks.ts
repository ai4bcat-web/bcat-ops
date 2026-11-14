/**
 * Where "open this shipment" goes: the tabbed shipment editor under View → Active shipments, exactly
 * as the shipments board's PRO link opens it (a PRO tab in the strip, Edit PRO, the order sections and
 * the right panel). The read-only `/tms/shipments/:id` page is the drawer's "Open full page" and is
 * not where a PRO link should land (Ryne, 2026-11-14).
 */
export function shipmentEditorPath(shipmentId: string): string {
  return `/tms/shipments/${encodeURIComponent(shipmentId)}/edit`
}
