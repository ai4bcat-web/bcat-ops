import { TmsAlert } from '@/features/tms/kit'
import type { DashVisibility } from '@/lib/dashboards/types'
import { SCOPED_BANNER } from './labels'


/** Printed on every dashboard a non-viewAll user opens (the server already filtered the rows). */
export function VisibilityBanner({ visibility }: { visibility: DashVisibility | null | undefined }) {
  if (!visibility || visibility.viewAll) return null
  return (
    <TmsAlert tone="blue" className="dash-banner" icon={false}>
      <span data-testid="dash-visibility-banner">{SCOPED_BANNER}</span>
    </TmsAlert>
  )
}
