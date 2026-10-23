import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, PauseCircle, ArrowRight } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { graphqlErrorText } from '@/lib/apiClient'
import { todayChicago } from '@/lib/recurringRevision'
import { moveHeldCost, platesAndEldFor, stopCharging, type HeldCost } from '@/lib/truckInactive'
import type { ExpenseTypeData, RecurringExpenseData, TruckExpenseAllocationData } from '@/lib/apiClient'
import type { Equipment } from '@/types/equipment'

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const slotLabel = (slot: 'plates' | 'eld') => (slot === 'plates' ? 'Plates' : 'ELD')
/** Plates are thought of per year, the ELD per month — the way the truck form enters them. */
const amountLabel = (slot: 'plates' | 'eld', monthly: number) =>
  slot === 'plates' ? `${money(monthly * 12)}/yr` : `${money(monthly)}/mo`

export interface ExpenseSnapshot {
  recurring: RecurringExpenseData[]
  allocations: TruckExpenseAllocationData[]
  expenseTypes: ExpenseTypeData[]
}

/**
 * Mark a truck inactive. Insurance stops counting from the date; plates and ELD are asked
 * about one by one, because they usually keep billing after the truck is parked.
 */
export function MarkInactiveDialog(props: {
  truck: Equipment
  insuranceAnnual: number
  expenses: ExpenseSnapshot
  onDone: (patch: Pick<Equipment, 'active' | 'inactiveSince'>) => void
  onClose: () => void
}) {
  const [date, setDate] = useState(todayChicago())
  const costs = useMemo(
    () => platesAndEldFor(props.truck.id, date, props.expenses.recurring, props.expenses.allocations, props.expenses.expenseTypes),
    [props.truck.id, date, props.expenses],
  )
  // Assume they keep billing unless told otherwise.
  const [keep, setKeep] = useState<Record<string, boolean>>({})
  const keeps = (id: string) => keep[id] ?? true
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    try {
      for (const c of costs) {
        if (!keeps(c.recurring.id)) await stopCharging(c.recurring, date)
      }
      props.onDone({ active: false, inactiveSince: date })
      const held = costs.filter((c) => keeps(c.recurring.id)).length
      toast.success(`Unit ${props.truck.unitNumber} is inactive from ${date}`, {
        description: held ? `${held} cost${held === 1 ? '' : 's'} moved to the holding area` : undefined,
      })
      props.onClose()
    } catch (err) {
      toast.error(graphqlErrorText(err) || 'Could not mark the truck inactive')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) props.onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark unit #{props.truck.unitNumber} inactive</DialogTitle>
          <DialogDescription>Costs change from this date. Months before it are not touched.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block text-sm">
            <span className="font-semibold">Inactive from</span>
            <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="mt-1 block h-9 rounded-md border px-2 text-sm bg-background" />
          </label>

          <div className="rounded-md border p-3 text-sm">
            <div className="font-semibold">Insurance</div>
            <p className="text-muted-foreground mt-0.5">
              {props.insuranceAnnual > 0
                ? `${money(props.insuranceAnnual)}/yr comes out of the totals from ${date}.`
                : 'No insurance premium on file for this truck.'}
            </p>
          </div>

          {costs.length === 0 && (
            <p className="text-sm text-muted-foreground">No plates or ELD cost is on file for this truck.</p>
          )}
          {costs.map((c) => (
            <div key={c.recurring.id} className="rounded-md border p-3 text-sm">
              <div className="font-semibold">{slotLabel(c.slot)} · {amountLabel(c.slot, c.monthlyAmount)}</div>
              <p className="text-muted-foreground mt-0.5">Will {c.slot === 'plates' ? 'the plates' : 'the ELD'} still be charged?</p>
              <div className="mt-2 flex gap-4">
                <label className="flex items-center gap-1.5">
                  <input type="radio" name={c.recurring.id} checked={keeps(c.recurring.id)} onChange={() => setKeep({ ...keep, [c.recurring.id]: true })} />
                  Yes — hold it for another truck
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name={c.recurring.id} checked={!keeps(c.recurring.id)} onChange={() => setKeep({ ...keep, [c.recurring.id]: false })} />
                  No — stop it
                </label>
              </div>
            </div>
          ))}

          <div className="flex justify-end gap-2">
            <button onClick={props.onClose} disabled={saving} className="h-9 px-3 rounded-md border text-sm">Cancel</button>
            <button onClick={submit} disabled={saving} className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-foreground text-background text-sm font-semibold disabled:opacity-50">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <PauseCircle size={14} />} Mark inactive
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Plates and ELD still being paid for on parked trucks, waiting for a truck to take them. */
export function HoldingArea(props: {
  held: HeldCost[]
  activeTrucks: Equipment[]
  onChanged: () => void
}) {
  const [target, setTarget] = useState<Record<string, string>>({})
  const [from, setFrom] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  if (props.held.length === 0) return null

  const assign = async (h: HeldCost) => {
    const to = props.activeTrucks.find((t) => t.id === target[h.recurring.id])
    if (!to) return toast.error('Pick the truck that takes it over')
    const day = from[h.recurring.id] || todayChicago()
    setBusy(h.recurring.id)
    try {
      await moveHeldCost(h, to, day)
      toast.success(`${slotLabel(h.slot)} moved from #${h.truck.unitNumber} to #${to.unitNumber} from ${day}`)
      props.onChanged()
    } catch (err) {
      toast.error(graphqlErrorText(err) || 'Could not move it')
    } finally {
      setBusy(null)
    }
  }

  const stop = async (h: HeldCost) => {
    const day = from[h.recurring.id] || todayChicago()
    setBusy(h.recurring.id)
    try {
      await stopCharging(h.recurring, day)
      toast.success(`${slotLabel(h.slot)} from #${h.truck.unitNumber} stopped from ${day}`)
      props.onChanged()
    } catch (err) {
      toast.error(graphqlErrorText(err) || 'Could not stop it')
    } finally {
      setBusy(null)
    }
  }

  const monthlyTotal = props.held.reduce((s, h) => s + h.monthlyAmount, 0)
  return (
    <div style={{ border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)', marginBottom: 16 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Holding area</span>
        <span style={{ fontSize: 12.5, color: 'var(--ds-t3)' }}>
          Plates and ELD still being paid for on inactive trucks · {money(monthlyTotal)}/mo, still counted in expenses
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="w-full text-sm">
          <tbody>
            {props.held.map((h) => (
              <tr key={h.recurring.id} className="border-b last:border-0">
                <td className="px-4 py-2.5 whitespace-nowrap">
                  <div className="font-semibold">{slotLabel(h.slot)} · {amountLabel(h.slot, h.monthlyAmount)}</div>
                  <div className="text-xs text-muted-foreground">From #{h.truck.unitNumber}{h.truck.inactiveSince ? `, inactive from ${h.truck.inactiveSince}` : ''}</div>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    <select aria-label="Move to truck" value={target[h.recurring.id] ?? ''} onChange={(e) => setTarget({ ...target, [h.recurring.id]: e.target.value })} className="h-8 rounded-md border px-2 text-sm bg-background">
                      <option value="">Move to truck…</option>
                      {props.activeTrucks.map((t) => <option key={t.id} value={t.id}>#{t.unitNumber}</option>)}
                    </select>
                    <input aria-label="From date" type="date" value={from[h.recurring.id] ?? todayChicago()} onChange={(e) => setFrom({ ...from, [h.recurring.id]: e.target.value })} className="h-8 rounded-md border px-2 text-sm bg-background" />
                    <button onClick={() => assign(h)} disabled={busy !== null} className="inline-flex items-center gap-1 h-8 px-3 rounded-md bg-foreground text-background text-xs font-semibold disabled:opacity-50">
                      {busy === h.recurring.id ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />} Move
                    </button>
                    <button onClick={() => stop(h)} disabled={busy !== null} className="h-8 px-3 rounded-md border text-xs font-semibold disabled:opacity-50">Stop charging</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
