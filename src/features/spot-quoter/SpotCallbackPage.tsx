/**
 * Quotes › Spot inbox, OAuth return — placeholder reserved by Step AA. Step AB overwrites
 * this file (same export).
 */
import { TmsEmptyState, TmsPage } from '@/features/tms/kit'

export function SpotCallbackPage() {
  return (
    <TmsPage title="Spot inbox">
      <TmsEmptyState title="Arrives with Step AB" message="The e-mail connection return lands here." />
    </TmsPage>
  )
}
