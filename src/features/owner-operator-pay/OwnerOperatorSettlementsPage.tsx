import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { OWNER_OP_FIRST_PERIOD } from '@/lib/ownerOperatorTrips'
import { OwnerOperatorPayPage } from './OwnerOperatorPayPage'
import { DriverPayPage } from '@/features/driver-pay/DriverPayPage'
import { OwnerOperatorSettlementsSwitch, type SettlementsView } from './OwnerOperatorSettlementsSwitch'

/**
 * Owner Operator Settlements: the one settlements page for owner operators. A week an owner operator was paid Amazon style (pinned to
 * Amazon, any week before Sep 27, or an overlap week that stays Amazon) is its 'Amazon week' view, with exactly the Amazon calculation,
 * statements and charges it always had; every other week is the standard owner-operator view. The week is shared by both views.
 * `/driver-pay` redirects here (`?view=amazon`), carrying `week` and `driver` so old links and bookmarks keep working.
 */
export function OwnerOperatorSettlementsPage() {
  const { isAdmin, isOwner, hasPageAccess } = useAuth()
  const [params, setParams] = useSearchParams()
  const everything = isAdmin || isOwner
  const canStandard = everything || hasPageAccess('ownerOperatorPay')
  const canAmazon = everything || hasPageAccess('driverPay')
  const asked: SettlementsView = params.get('view') === 'amazon' ? 'amazon' : 'standard'
  const view: SettlementsView = !canStandard ? 'amazon' : !canAmazon ? 'standard' : asked
  const [week, setWeek] = useState<string | null>(params.get('week'))
  const [driver] = useState<string | null>(params.get('driver'))

  const setView = (next: SettlementsView) => {
    const p = new URLSearchParams(params)
    if (next === 'amazon') p.set('view', 'amazon'); else p.delete('view')
    setParams(p, { replace: true })
  }
  // Going back past the first owner-operator week (Sep 27) can only be Amazon weeks: move there instead of stopping.
  const onWeek = (next: string) => {
    setWeek(next)
    if (view === 'standard' && canAmazon && next < OWNER_OP_FIRST_PERIOD) setView('amazon')
  }
  const viewSwitch = <OwnerOperatorSettlementsSwitch active={view} onChange={setView} canStandard={canStandard} canAmazon={canAmazon} />

  return view === 'amazon'
    ? <DriverPayPage week={week} onWeek={onWeek} viewSwitch={viewSwitch} initialDriverId={driver} />
    : <OwnerOperatorPayPage week={week} onWeek={onWeek} viewSwitch={viewSwitch} initialDriverId={driver} />
}
