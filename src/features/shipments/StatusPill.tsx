import { boardRowTone, statusWithProgress, type ShipmentRow } from './shipmentViews'

/**
 * The board status as a pill in its row's color ("OPEN 0/2", "DELIVERED 2/2"). The tone is the row's own
 * (boardRowTone), so a pill and the row behind it always agree.
 */
export function StatusPill({ row }: { row: ShipmentRow }) {
  return <span className="tms-status-pill" data-tone={boardRowTone(row)} data-testid="status-pill">{statusWithProgress(row)}</span>
}
