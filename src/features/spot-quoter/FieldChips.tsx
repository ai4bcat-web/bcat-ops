/**
 * The per-field state chip: Intake's five-state vocabulary, derived by `fieldStatusOf`
 * (never recomputed here), so the page and the server agree on what "Check this" means.
 */
import { TmsBadge, type TmsTone } from '@/features/tms/kit'
import { fieldStatusOf } from '@/lib/spot/fields'
import type { SpotExtraction, SpotFieldMeta, SpotFieldStatus } from '@/lib/spot/types'

const CHIP: Record<SpotFieldStatus, { label: string; tone: TmsTone }> = {
  AUTO: { label: 'Auto-filled', tone: 'green' },
  LOW: { label: 'Check this', tone: 'orange' },
  MISSING: { label: 'Missing', tone: 'red' },
  CONFIRMED: { label: 'Confirmed', tone: 'blue' },
  INVALID: { label: 'Invalid', tone: 'red' },
}

export function FieldChip({
  fieldKey,
  extraction,
  fieldMeta,
}: {
  fieldKey: string
  extraction: SpotExtraction
  fieldMeta: SpotFieldMeta | null | undefined
}) {
  const status = fieldStatusOf(fieldKey, extraction, fieldMeta ?? {})
  const chip = CHIP[status]
  return (
    <TmsBadge tone={chip.tone} data-testid={`spot-field-chip-${fieldKey}`} data-status={status}>
      {chip.label}
    </TmsBadge>
  )
}
