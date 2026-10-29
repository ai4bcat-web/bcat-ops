/**
 * Everything one shipment's screen needs, assembled once: the bundle, the customer it
 * belongs to, the charge-code catalog and pricing defaults that apply to it, the credit
 * answer for its draft banner, and the bound action handlers.
 *
 * The drawer and the full page both call this, so the two can never drift apart.
 */
import { useCallback, useEffect, useState } from 'react'
import { checkCredit } from '@/lib/apiClient'
import { useShipment } from '@/hooks/useShipment'
import { useShipmentActions, type ShipmentActions } from './useShipmentActions'
import type { CreditSummary } from '@/lib/customerCredit'
import type { ShipmentDetailProps } from './components/ShipmentDetail'
import type {
  ChargeCodeDef, CustomerRecord, LocationRecord, PricingDefaults, RequiredReference, ShipmentBundle, TmsSettings,
} from '@/types/tms'

export interface ShipmentContextOptions {
  customers: CustomerRecord[]
  locations: LocationRecord[]
  settings: TmsSettings | null
  isAdmin: boolean
  currentUser: string
}

export interface ShipmentContext {
  bundle: ShipmentBundle | null
  loading: boolean
  error: string | null
  cancelDeleteAdminOnly: boolean
  actions: ShipmentActions
  detailProps: ShipmentDetailProps
}

export function useShipmentContext(
  shipmentId: string | null,
  options: ShipmentContextOptions,
  onChanged?: () => void,
): ShipmentContext {
  const { bundle, loading, error, replace } = useShipment(shipmentId)
  const [credit, setCredit] = useState<CreditSummary | null>(null)

  // A mutation returns the whole bundle, so the screen updates from the response and the
  // board is told to re-list; neither side re-fetches this shipment.
  const onBundle = useCallback((next: ShipmentBundle) => {
    replace(next)
    onChanged?.()
  }, [replace, onChanged])

  const actions = useShipmentActions(bundle, onBundle)

  // An unresolved shipment carries no `customerId`, so this never matches and the credit
  // effect below never fires for one: there is no customer to ask about yet.
  const customer = options.customers.find((c) => c.id === bundle?.shipment.customerId) ?? null
  const customerId = customer?.id ?? null
  const isDraft = bundle?.shipment.status === 'DRAFT'

  // The draft banner needs the server's own credit answer, not a local recomputation —
  // exposure spans every load of every shipment for this customer.
  // No synchronous setState before the first await (react-hooks/set-state-in-effect):
  // the non-draft case resolves to null through the same chain.
  useEffect(() => {
    let live = true
    const answer = isDraft && customerId
      ? checkCredit({ customerId, projectedCents: 0 }).catch(() => null)
      : Promise.resolve(null)
    answer.then((summary) => { if (live) setCredit(summary) })
    return () => { live = false }
  }, [isDraft, customerId])

  const settings = options.settings
  const catalog: ChargeCodeDef[] = settings?.chargeCodes ?? []
  const pricing: PricingDefaults | null = customer?.pricingDefaults ?? null
  const requiredReferences: RequiredReference[] =
    customer?.requiredReferences ?? settings?.defaultRequiredReferences ?? []

  return {
    bundle,
    loading,
    error,
    cancelDeleteAdminOnly: settings?.cancelDeleteAdminOnly ?? false,
    actions,
    detailProps: {
      // `bundle` is non-null wherever detailProps is rendered; the callers gate on it.
      bundle: bundle as ShipmentBundle,
      customer,
      customers: options.customers,
      locations: options.locations,
      catalog,
      pricing,
      marginFloorBps: settings?.marginFloorBps ?? null,
      requiredReferences,
      credit,
      currentUser: options.currentUser,
      isAdmin: options.isAdmin,
      actions,
    },
  }
}
