import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Pencil, Trash2, Receipt } from 'lucide-react'
import { TmsDialog } from '@/features/tms/kit/TmsDialog'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { TmsField } from '@/features/tms/kit/TmsField'
import { TmsInput, TmsTextarea } from '@/features/tms/kit/TmsInput'
import { TmsSelect } from '@/features/tms/kit/TmsSelect'
import { TmsBadge } from '@/features/tms/kit/TmsBadge'
import { useExpenseData, type ExpenseRecordData } from '@/hooks/useExpenseData'
import { useAuthUser } from '@/hooks/useAuth'
import {
  createFuelTransaction, updateFuelTransaction, deleteFuelTransaction, createAuditLog,
  type FuelTransaction,
} from '@/lib/apiClient'
import { errorText } from '@/lib/errorText'
import {
  MANUAL_CATEGORIES, MANUAL_METHODS, MANUAL_SOURCE, isManualFuelTx, manualMethodOf, manualFuelFields, manualNotes,
  expenseTypeCategoryFor, validateManualExpense, parseDollars,
  type ManualCategory, type ManualExpenseInput,
} from '@/lib/manualExpense'
import type { Equipment } from '@/types/equipment'
import type { Driver } from '@/types'

const money2 = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Audit `changes` are {field: {from, to}}: a create is null -> value, a delete value -> null. */
const added = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { from: null, to: v }]))
const removed = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { from: v, to: null }]))

type Editing = { kind: 'fuel'; tx: FuelTransaction } | { kind: 'record'; rec: ExpenseRecordData } | null

interface Row {
  key: string
  kind: 'fuel' | 'record'
  date: string
  category: string
  truckLabel: string
  detail: string
  method: string
  reference: string
  amount: number
  tx?: FuelTransaction
  rec?: ExpenseRecordData
}

interface SectionProps {
  trucks: Equipment[]
  drivers: Driver[]
  transactions: FuelTransaction[]
  onFuelChanged: () => void
  addOpen: boolean
  onAddOpenChange: (open: boolean) => void
  canManage: boolean
  canDelete: boolean
}

/** One-time expenses typed in by hand, beside the card fuel: the add dialog and the list with Manual badges. */
export function ManualExpensesSection({ trucks, drivers, transactions, onFuelChanged, addOpen, onAddOpenChange, canManage, canDelete }: SectionProps) {
  const data = useExpenseData()
  const user = useAuthUser()
  const [editing, setEditing] = useState<Editing>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const who = user?.email ?? 'unknown'

  const truckById = useMemo(() => new Map(trucks.map((t) => [t.id, t])), [trucks])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const tx of transactions) {
      if (!isManualFuelTx(tx)) continue
      out.push({
        key: `fuel:${tx.id}`, kind: 'fuel', date: tx.transactionDate, category: 'Fuel',
        truckLabel: tx.truckId && truckById.get(tx.truckId) ? `#${truckById.get(tx.truckId)!.unitNumber}` : tx.unitNumber ? `#${tx.unitNumber}` : '—',
        detail: [tx.locationName, tx.driverName ? `Driver ${tx.driverName}` : ''].filter(Boolean).join(' · '),
        method: manualMethodOf(tx), reference: tx.invoiceNumber ?? '', amount: tx.amount, tx,
      })
    }
    for (const rec of data.records) {
      if (rec.source !== MANUAL_SOURCE) continue
      const type = data.expenseTypes.find((t) => t.id === rec.expenseTypeId)
      out.push({
        key: `rec:${rec.id}`, kind: 'record', date: rec.transactionDate ?? rec.periodMonth ?? '',
        category: type?.name ?? 'Expense',
        truckLabel: rec.directTruckId && truckById.get(rec.directTruckId) ? `#${truckById.get(rec.directTruckId)!.unitNumber}` : '—',
        detail: rec.notes ?? '', method: '', reference: '', amount: rec.amount, rec,
      })
    }
    return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30)
  }, [transactions, data.records, data.expenseTypes, truckById])

  async function remove(row: Row) {
    try {
      if (row.kind === 'fuel' && row.tx) {
        await deleteFuelTransaction(row.tx.id)
        await createAuditLog({ entityType: 'FuelTransaction', entityId: row.tx.id, action: 'delete', user: who, changes: removed({ manual: true, amount: row.tx.amount, date: row.tx.transactionDate, reference: row.tx.invoiceNumber ?? null }) })
        onFuelChanged()
      } else if (row.rec) {
        await data.deleteRecord(row.rec.id)
        await createAuditLog({ entityType: 'ExpenseRecord', entityId: row.rec.id, action: 'delete', user: who, changes: removed({ manual: true, amount: row.rec.amount, date: row.rec.transactionDate ?? null, notes: row.rec.notes ?? null }) })
      }
      toast.success('Expense deleted')
    } catch (err) {
      toast.error(`Could not delete: ${errorText(err)}`)
    } finally {
      setPendingDelete(null)
    }
  }

  if (!canManage) return null

  return (
    <>
      <div style={{ background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 12, boxShadow: 'var(--tms-shadow)', overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--tms-border)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Receipt size={15} style={{ color: 'var(--tms-muted)' }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>One-time expenses</span>
          <span style={{ fontSize: 12, color: 'var(--tms-muted)', flex: 1 }}>· costs the fuel cards don’t capture</span>
          <TmsButton size="sm" variant="primary" onClick={() => onAddOpenChange(true)}>Add expense</TmsButton>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 760 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--tms-border)' }}>
                {['Date', 'Category', 'Truck', 'Details', 'Method', 'Ref', 'Amount', ''].map((h, i) => (
                  <th key={h || 'actions'} style={{ padding: '8px 16px', textAlign: i === 6 ? 'right' : 'left', fontSize: 11, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={8} style={{ padding: 24, textAlign: 'center', color: 'var(--tms-muted)', fontSize: 13 }}>No one-time expenses yet. Use Add expense for a Zelle fuel payment, a repair, a toll or a lumper.</td></tr>
              ) : rows.map((r) => (
                <tr key={r.key} style={{ borderBottom: '1px solid var(--tms-border)' }}>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{r.date}</td>
                  <td style={{ padding: '9px 16px', whiteSpace: 'nowrap' }}>
                    {r.category} <TmsBadge tone="gray">Manual</TmsBadge>
                  </td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{r.truckLabel}</td>
                  <td style={{ padding: '9px 16px', color: 'var(--tms-text-2)', maxWidth: 320 }}>{r.detail || '—'}</td>
                  <td style={{ padding: '9px 16px', color: 'var(--tms-text-2)' }}>{r.method || '—'}</td>
                  <td style={{ padding: '9px 16px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--tms-muted)' }}>{r.reference || '—'}</td>
                  <td style={{ padding: '9px 16px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{money2(r.amount)}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <TmsButton size="sm" variant="ghost" aria-label={`Edit expense ${r.reference || r.date}`} onClick={() => setEditing(r.kind === 'fuel' ? { kind: 'fuel', tx: r.tx! } : { kind: 'record', rec: r.rec! })}><Pencil size={13} /></TmsButton>
                    {canDelete ? (
                      pendingDelete === r.key ? (
                        <>
                          <TmsButton size="sm" variant="destructive" onClick={() => void remove(r)}>Delete</TmsButton>
                          <TmsButton size="sm" variant="ghost" onClick={() => setPendingDelete(null)}>Keep</TmsButton>
                        </>
                      ) : (
                        <TmsButton size="sm" variant="ghost" aria-label={`Delete expense ${r.reference || r.date}`} onClick={() => setPendingDelete(r.key)}><Trash2 size={13} /></TmsButton>
                      )
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(addOpen || editing) && (
        <ExpenseDialog
          key={editing ? (editing.kind === 'fuel' ? editing.tx.id : editing.rec.id) : 'new'}
          editing={editing}
          trucks={trucks}
          drivers={drivers}
          data={data}
          who={who}
          onClose={() => { setEditing(null); onAddOpenChange(false) }}
          onFuelChanged={onFuelChanged}
        />
      )}
    </>
  )
}

interface DialogProps {
  editing: Editing
  trucks: Equipment[]
  drivers: Driver[]
  data: ReturnType<typeof useExpenseData>
  who: string
  onClose: () => void
  onFuelChanged: () => void
}

function initialForm(editing: Editing): FormState {
  if (editing?.kind === 'fuel') {
    const tx = editing.tx
    const note = (tx.locationName ?? '').split(' — ')
    return {
      category: 'fuel', date: tx.transactionDate, amount: String(tx.amount), payee: note[0] ?? '', method: manualMethodOf(tx) || 'Other',
      reference: tx.invoiceNumber ?? '', note: note.slice(1).join(' — '), truckId: tx.truckId ?? '', driverId: '', proNumber: '',
    }
  }
  if (editing?.kind === 'record') {
    const rec = editing.rec
    return {
      category: 'other', date: rec.transactionDate ?? today(), amount: String(rec.amount), payee: '', method: 'Other', reference: '',
      note: rec.notes ?? '', truckId: rec.directTruckId ?? '', driverId: '', proNumber: '',
    }
  }
  return { category: 'fuel', date: today(), amount: '', payee: '', method: 'Zelle', reference: '', note: '', truckId: '', driverId: '', proNumber: '' }
}

interface FormState {
  category: ManualCategory
  date: string
  amount: string
  payee: string
  method: string
  reference: string
  note: string
  truckId: string
  driverId: string
  proNumber: string
}

function ExpenseDialog({ editing, trucks, drivers, data, who, onClose, onFuelChanged }: DialogProps) {
  const truckById = useMemo(() => new Map(trucks.map((t) => [t.id, t])), [trucks])
  const [form, setForm] = useState<FormState>(() => initialForm(editing))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }))

  const activeTrucks = trucks.filter((t) => t.active !== false)
  const activeDrivers = drivers.filter((d) => d.active && (d.type ?? 'driver') === 'driver')
  const isEdit = editing != null
  const isRecordEdit = editing?.kind === 'record'

  // Picking a driver fills in the truck they run; picking a truck leaves the driver as chosen.
  function pickDriver(id: string) {
    const d = drivers.find((x) => x.id === id)
    setForm((f) => ({ ...f, driverId: id, truckId: d?.assignedTruckId && truckById.has(d.assignedTruckId) ? d.assignedTruckId : f.truckId }))
  }

  async function save() {
    const amount = parseDollars(form.amount)
    const truck = truckById.get(form.truckId)
    const driver = drivers.find((d) => d.id === form.driverId)
    const input: ManualExpenseInput = {
      category: form.category, date: form.date, amount, payee: form.payee, method: form.method, reference: form.reference,
      note: form.note, truckId: form.truckId, unitNumber: truck?.unitNumber ?? '',
      driverName: driver?.name ?? (editing?.kind === 'fuel' ? editing.tx.driverName ?? '' : ''), proNumber: form.proNumber,
    }
    const problem = validateManualExpense(input)
    if (problem) { setError(problem.message); return }
    setSaving(true); setError(null)
    try {
      if (editing?.kind === 'fuel') {
        const f = manualFuelFields(input)
        await updateFuelTransaction(editing.tx.id, f)
        await createAuditLog({ entityType: 'FuelTransaction', entityId: editing.tx.id, action: 'update', user: who, changes: { amount: { from: editing.tx.amount, to: amount }, date: { from: editing.tx.transactionDate, to: form.date } } })
        onFuelChanged()
      } else if (editing?.kind === 'record') {
        await data.updateRecord(editing.rec.id, { amount, transactionDate: form.date, directTruckId: form.truckId, notes: form.note || null })
        await createAuditLog({ entityType: 'ExpenseRecord', entityId: editing.rec.id, action: 'update', user: who, changes: { amount: { from: editing.rec.amount, to: amount }, date: { from: editing.rec.transactionDate ?? null, to: form.date } } })
      } else if (form.category === 'fuel') {
        const created = await createFuelTransaction(manualFuelFields(input) as Parameters<typeof createFuelTransaction>[0])
        await createAuditLog({ entityType: 'FuelTransaction', entityId: created.id, action: 'create', user: who, changes: added({ manual: true, category: 'fuel', amount, date: form.date, truckId: form.truckId, method: form.method, reference: form.reference || null }) })
        onFuelChanged()
      } else {
        const wanted = expenseTypeCategoryFor(form.category)
        let type = data.expenseTypes.find((t) => t.category === wanted && t.active)
        if (!type) {
          type = await data.createType({ name: wanted === 'MAINTENANCE' ? 'Maintenance' : wanted === 'TOLLS' ? 'Tolls' : 'Other', category: wanted, defaultEntryMethod: 'MANUAL', active: true })
        }
        const created = await data.createRecord({
          expenseTypeId: type.id, allocationId: null, amount, periodMonth: null, transactionDate: form.date,
          entryMethod: 'MANUAL', directTruckId: form.truckId, notes: manualNotes(input), source: MANUAL_SOURCE,
        })
        await createAuditLog({ entityType: 'ExpenseRecord', entityId: created.id, action: 'create', user: who, changes: added({ manual: true, category: form.category, amount, date: form.date, truckId: form.truckId, method: form.method, reference: form.reference || null }) })
      }
      toast.success(isEdit ? 'Expense updated' : 'Expense added')
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      title={isEdit ? 'Edit one-time expense' : 'Add one-time expense'}
      description="For costs the fuel cards don’t capture. Fuel counts in the fuel totals for the truck."
      footer={(
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={saving}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add expense'}</TmsButton>
        </>
      )}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
        <TmsField label="Category">
          <TmsSelect value={form.category} onChange={(e) => set('category', e.target.value as ManualCategory)} disabled={isEdit}>
            {MANUAL_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </TmsSelect>
        </TmsField>
        <TmsField label="Date">
          <TmsInput type="date" value={form.date} onChange={(e) => set('date', e.target.value)} />
        </TmsField>
        <TmsField label="Amount ($)">
          <TmsInput inputMode="decimal" placeholder="0.00" value={form.amount} onChange={(e) => set('amount', e.target.value)} />
        </TmsField>
        <TmsField label="Driver">
          <TmsSelect value={form.driverId} onChange={(e) => pickDriver(e.target.value)} placeholder="None" disabled={isRecordEdit}>
            {activeDrivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </TmsSelect>
        </TmsField>
        <TmsField label="Truck">
          <TmsSelect value={form.truckId} onChange={(e) => set('truckId', e.target.value)} placeholder="Select truck…">
            {activeTrucks.map((t) => <option key={t.id} value={t.id}>#{t.unitNumber}</option>)}
          </TmsSelect>
        </TmsField>
        <TmsField label="Paid to">
          <TmsInput value={form.payee} onChange={(e) => set('payee', e.target.value)} placeholder="Person or company" disabled={isRecordEdit} />
        </TmsField>
        <TmsField label="Payment method">
          <TmsSelect value={form.method} onChange={(e) => set('method', e.target.value)} disabled={isRecordEdit}>
            {MANUAL_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </TmsSelect>
        </TmsField>
        <TmsField label="Reference #">
          <TmsInput value={form.reference} onChange={(e) => set('reference', e.target.value)} placeholder="Zelle or check number" disabled={isRecordEdit} />
        </TmsField>
        <TmsField label="Shipment PRO (optional)">
          <TmsInput value={form.proNumber} onChange={(e) => set('proNumber', e.target.value)} disabled={isEdit} />
        </TmsField>
      </div>
      <div style={{ marginTop: 12 }}>
        <TmsField label="Note">
          <TmsTextarea rows={2} value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="fuel 11.24.26" />
        </TmsField>
      </div>
      {error ? <div role="alert" style={{ marginTop: 12, color: 'var(--tms-badge-red)', fontSize: 13 }}>{error}</div> : null}
    </TmsDialog>
  )
}
