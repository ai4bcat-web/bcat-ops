/**
 * The marker for imported Aljex history (PHASE0-plan §8.4). Imported shipments carry no documents in BCAT Ops
 * (they live in the Aljex archive), so the badge says so, and the gate lists show "Waived (legacy import)"
 * instead of "Missing".
 */
import { TmsBadge } from '@/features/tms/kit'
import { LEGACY_DOCS_LABEL } from './legacyLabels'

export interface LegacyBadgeProps {
  legacyImported?: boolean | null
  /** `Shipment.importRunId`, shown in the tooltip. */
  importRunId?: string | null
  /** When the shipment row was written (the import date). */
  importedAt?: string | null
  className?: string
}

/** Renders nothing unless the shipment is flagged: only the import engine ever sets the flag. */
export function LegacyBadge({ legacyImported, importRunId, importedAt, className }: LegacyBadgeProps) {
  if (legacyImported !== true) return null
  const when = importedAt ? new Date(importedAt).toLocaleDateString() : null
  const title = `Imported from Aljex${when ? ` on ${when}` : ''}${importRunId ? ` (run ${importRunId})` : ''}. Paperwork and driver checks do not apply to history.`
  return (
    <TmsBadge tone="gray" className={className} title={title} data-testid="legacy-badge">
      {LEGACY_DOCS_LABEL}
    </TmsBadge>
  )
}
