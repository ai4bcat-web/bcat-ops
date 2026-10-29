/**
 * Fixing what a carrier is owed, from the AP desk.
 *
 * AP settles the buy side long after the customer's side is done, so the carrier's
 * lines stay editable past the invoice freeze — but only until a bill is recorded
 * against them. A recorded bill names an exact number that somebody is about to pay;
 * moving the lines under it would make the bill and the charges disagree with nobody
 * the wiser. That is why this refuses outright rather than saving and hoping: the bill
 * is voided first, and then the lines are fixed.
 *
 * The editor is the shipment's own `FinancialLines` grid, fed this assignment's CARRIER
 * rows and nothing else, so the arithmetic is `computeFinancials` exactly as it is on
 * the Financials tab. `UPDATE_CARRIER_CHARGES` takes this assignment's lines only and
 * re-derives the load's cached cost itself.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { FinancialLines } from '@/features/shipments/components/FinancialLines'
import {
  getShipmentBundle, getTmsSettings, graphqlErrorText, listCustomers, updateCarrierCharges,
} from '@/lib/apiClient'
import type { LoadChargeInput, PricingDefaults, ShipmentBundle, TmsSettings } from '@/types/tms'

export function UpdateCarrierChargesDialog({ loadCarrierId, shipmentId, open, onOpenChange, onDone }: {
  loadCarrierId: string
  shipmentId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [bundle, setBundle] = useState<ShipmentBundle | null>(null)
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [pricing, setPricing] = useState<PricingDefaults | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() =>
    Promise.all([getShipmentBundle(shipmentId), getTmsSettings(), listCustomers()])
      .then(([shipmentBundle, tmsSettings, customers]) => {
        const customer = customers.find((row) => row.id === shipmentBundle.shipment.customerId) ?? null
        setBundle(shipmentBundle)
        setSettings(tmsSettings)
        setPricing(customer?.pricingDefaults ?? null)
        setError(null)
      })
      .catch((err: unknown) => { setError(graphqlErrorText(err)) })
      .finally(() => setLoading(false)),
  [shipmentId])

  useEffect(() => { load() }, [load])

  const assignment = bundle?.loadCarriers.find((row) => row.id === loadCarrierId) ?? null
  const leg = bundle?.loads.find((row) => row.id === assignment?.loadId) ?? null
  const ours = (bundle?.charges ?? []).filter(
    (row) => row.side === 'CARRIER' && row.loadCarrierId === loadCarrierId,
  )

  const save = async (charges: LoadChargeInput[]) => {
    if (!bundle) return
    // The grid renders both sides; only the carrier's are this assignment's money, and
    // the Lambda refuses the rest by name. Saying so here is kinder than a round trip.
    if (charges.some((line) => line.side !== 'CARRIER')) {
      throw new Error('Only carrier lines belong on this form. Customer charges are edited on the shipment.')
    }
    await updateCarrierCharges({
      loadCarrierId,
      expectedVersion: bundle.shipment.version ?? 1,
      charges: charges.map((line) => ({ ...line, loadCarrierId, loadId: assignment?.loadId ?? line.loadId ?? null })),
    })
    toast.success('Carrier charges saved')
    onDone()
  }

  const billed = assignment?.invoiceId != null || assignment?.chargesFinalizedAt != null

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Carrier charges${assignment?.carrierName ? ` — ${assignment.carrierName}` : ''}`}
      className="tms-dialog-xl"
      footer={<TmsButton variant="ghost" onClick={() => onOpenChange(false)}>Close</TmsButton>}
    >
      {loading && (
        <p className="flex items-center gap-2 tms-muted">
          <Loader2 size={14} className="animate-spin" /> Reading the shipment…
        </p>
      )}

      {!loading && !assignment && (
        <p style={{ color: 'var(--tms-badge-red)' }}>
          {error ?? 'That assignment is no longer on this shipment.'}
        </p>
      )}

      {!loading && assignment && assignment.kind !== 'CARRIER' && (
        <p className="tms-muted">
          This leg runs on our own equipment. It is settled through driver pay, not through AP,
          and has no carrier charges to edit.
        </p>
      )}

      {!loading && assignment && assignment.kind === 'CARRIER' && billed && (
        <p className="tms-muted">
          A bill is already recorded against this assignment, so its charges are final —
          a bill names an exact amount and somebody is about to pay it. Void the bill first,
          then fix the lines and record it again.
        </p>
      )}

      {!loading && assignment && assignment.kind === 'CARRIER' && !billed && (
        <div className="max-h-[70vh] overflow-auto">
          <FinancialLines
            charges={ours}
            catalog={settings?.chargeCodes ?? []}
            context={{ miles: leg?.miles ?? null }}
            pricing={pricing}
            marginFloorBps={settings?.marginFloorBps ?? null}
            onSave={save}
          />
          {error && <p className="mt-2 text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
        </div>
      )}
    </TmsDialog>
  )
}
