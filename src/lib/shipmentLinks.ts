/**
 * Where "open this shipment" goes: the tabbed shipment editor under View → Active shipments (Edit PRO,
 * the order sections, the right panel and the shipment tools below the form). There is no separate
 * detail drawer or page any more; `/tms/shipments/:id` only redirects here (Ryne, 2026-11-16).
 */
export function shipmentEditorPath(shipmentId: string): string {
  return `/tms/shipments/${encodeURIComponent(shipmentId)}/edit`
}
