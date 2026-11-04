/**
 * Quotes › Spot inbox — placeholder reserved by Step AA. Step AB overwrites this file
 * (same export); the route and nav row already exist.
 */
import { TmsEmptyState, TmsPage } from '@/features/tms/kit'

export function SpotInboxPage() {
  return (
    <TmsPage title="Spot inbox">
      <TmsEmptyState title="Arrives with Step AB" message="Spot quote requests from e-mail will land here." />
    </TmsPage>
  )
}
