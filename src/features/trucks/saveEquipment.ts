import { toast } from 'sonner'
import { provisionTruckCosts, applyTruckCosts, readTruckCosts, hasAnyTruckCost, type TruckCostInputs } from '@/lib/truckCosts'
import { setUnitPremiumCurrentPeriod } from '@/lib/insuranceClient'
import type { ExpenseDataState } from '@/hooks/useExpenseData'
import type { Equipment } from '@/types/equipment'
import type { ComplianceDocument } from '@/types'
import { assetDocExpiryUpdates } from '@/lib/fileHub'

type EquipmentData = Omit<Equipment, 'id' | 'createdAt' | 'updatedAt'>

/**
 * Saves the equipment form: the unit itself plus a truck's recurring operating costs and its insurance premium.
 * The Trucks page and the asset profile both call this, so an edit lands in the same records either way.
 * Returns the saved unit (the new one on an add).
 */
export function saveEquipment({ existing, data, costs, addEquipment, updateEquipment, expenseData, certificates }: {
  existing: Equipment | null
  data: EquipmentData
  costs?: TruckCostInputs
  addEquipment: (e: EquipmentData) => Equipment
  updateEquipment: (id: string, patch: Partial<EquipmentData>) => void
  expenseData: Pick<ExpenseDataState, 'recurring' | 'allocations' | 'expenseTypes' | 'refresh'>
  /**
   * The unit's uploaded certificates. An uploaded insurance / IFTA / IRP certificate is what
   * the app judges the unit on, so a new date typed here is written to it as well — otherwise
   * the edit saved but nothing on screen changed.
   */
  certificates?: {
    docFor: (unitId: string, documentType: string) => ComplianceDocument | undefined
    setExpiration: (doc: ComplianceDocument, date: string) => Promise<unknown>
  }
}): Equipment | null {
  if (existing) {
    const id = existing.id
    const unit = data.unitNumber
    updateEquipment(id, data)
    const certUpdates = certificates
      ? assetDocExpiryUpdates(existing, data, (type) => certificates.docFor(id, type))
      : []
    if (certUpdates.length === 0) {
      toast.success(`Unit ${unit} updated`)
    } else {
      Promise.all(certUpdates.map(({ doc, date }) => certificates!.setExpiration(doc, date)))
        .then(() => toast.success(`Unit ${unit} updated · ${certUpdates.map((u) => u.doc.title || u.doc.documentType).join(', ')} certificate date updated`))
        .catch((err) => toast.warning(`Unit ${unit} updated, but the uploaded certificate's date could not be changed: ${err instanceof Error ? err.message : 'unknown error'}`))
    }
    // Upsert this truck's recurring operating costs (create / update amount / clear).
    if (costs) {
      const { existing: current } = readTruckCosts(id, expenseData.recurring, expenseData.allocations, expenseData.expenseTypes)
      applyTruckCosts(id, unit, costs, current)
        .then(() => expenseData.refresh())
        .catch((err) => console.error('[applyTruckCosts] failed', err))
      // Insurance lives in the Insurance module (current period) — same record the
      // Insurance page edits, so the two stay in sync and it feeds the P&L.
      if (data.type === 'truck') {
        setUnitPremiumCurrentPeriod('TRUCK', id, unit, Math.round((costs.insuranceAnnual ?? 0) * 100))
          .catch((err) => console.error('[insurance save] failed', err))
      }
    }
    return existing
  }
  const truck = addEquipment(data)
  toast.success(`Unit ${truck.unitNumber} added`)
  // Provision recurring costs captured on the add-truck form so they flow into
  // Expenses + Profitability. Fire-and-forget.
  if (costs && hasAnyTruckCost(costs)) {
    provisionTruckCosts(truck.id, truck.unitNumber, costs)
      .then((n) => { if (n > 0) { toast('Operating costs added', { description: `${n} recurring cost${n === 1 ? '' : 's'} created for unit ${truck.unitNumber}` }); expenseData.refresh() } })
      .catch((err) => console.error('[provisionTruckCosts] failed', err))
  }
  if (costs && data.type === 'truck' && (costs.insuranceAnnual ?? 0) > 0) {
    setUnitPremiumCurrentPeriod('TRUCK', truck.id, truck.unitNumber, Math.round((costs.insuranceAnnual ?? 0) * 100))
      .catch((err) => console.error('[insurance save] failed', err))
  }
  return truck
}
