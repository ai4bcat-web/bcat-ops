import { TmsBadge } from '@/features/tms/kit'
import { duplicateTooltip, type DuplicateInfo } from '@/lib/customerDuplicates'

/** "Possible duplicate" badge; renders nothing when the customer shares no name with another account. */
export function PossibleDuplicateBadge({ info }: { info: DuplicateInfo | undefined }) {
  if (!info) return null
  return (
    <TmsBadge tone="orange" title={duplicateTooltip(info)} data-testid="possible-duplicate">
      Possible duplicate
    </TmsBadge>
  )
}
