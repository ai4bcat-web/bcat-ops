import { useState } from 'react'
import { Plus, Pencil, Trash2, Check, X, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Equipment } from '@/types/equipment'
import type {
  ExpenseDataState,
  ExpenseTypeData,
  TruckExpenseAllocationData,
  RecurringExpenseData,
} from '@/hooks/useExpenseData'

const CATEGORIES = ['FUEL','INSURANCE','FINANCING','LEASE','MAINTENANCE','PERMITS','TOLLS','OTHER'] as const
const ENTRY_METHODS = ['FIXED','MANUAL','AUTO_INGESTED'] as const

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

// ── Inline text field ──────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground font-medium">{label}</label>
      {children}
    </div>
  )
}

function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn('h-8 rounded-md border border-slate-200 px-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-slate-300', className)}
      {...props}
    />
  )
}

function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  return (
    <select
      className={cn('h-8 rounded-md border border-slate-200 px-2 text-xs focus:outline-none focus:ring-2 focus:ring-slate-300 bg-white', className)}
      {...props}
    >
      {children}
    </select>
  )
}

// ── Expense Types tab ─────────────────────────────────────────────────────────

function ExpenseTypesTab({ data }: { data: ExpenseDataState }) {
  const [adding, setAdding]     = useState(false)
  const [editId, setEditId]     = useState<string | null>(null)
  const [saving, setSaving]     = useState(false)
  const [form, setForm]         = useState({ name: '', category: 'OTHER' as ExpenseTypeData['category'], defaultEntryMethod: 'MANUAL' as ExpenseTypeData['defaultEntryMethod'], active: true, notes: '' })

  function openAdd() {
    setForm({ name: '', category: 'OTHER', defaultEntryMethod: 'MANUAL', active: true, notes: '' })
    setAdding(true)
    setEditId(null)
  }

  function openEdit(t: ExpenseTypeData) {
    setForm({ name: t.name, category: t.category, defaultEntryMethod: t.defaultEntryMethod, active: t.active, notes: t.notes ?? '' })
    setEditId(t.id)
    setAdding(false)
  }

  async function save() {
    if (!form.name.trim()) return
    setSaving(true)
    try {
      if (editId) {
        await data.updateType(editId, form)
        setEditId(null)
      } else {
        await data.createType(form)
        setAdding(false)
      }
    } finally {
      setSaving(false)
    }
  }

  async function del(id: string) {
    if (!confirm('Delete this expense type?')) return
    await data.deleteType(id)
  }

  const sorted = [...data.expenseTypes].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Expense Types</h3>
          <p className="text-xs text-muted-foreground">Categories of costs tracked across your fleet</p>
        </div>
        <Button size="sm" className="h-8 gap-1.5" onClick={openAdd}><Plus className="size-3.5" /> Add Type</Button>
      </div>

      {(adding || editId) && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Liability Insurance" />
          </Field>
          <Field label="Category">
            <Select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as ExpenseTypeData['category'] }))}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Entry Method">
            <Select value={form.defaultEntryMethod} onChange={(e) => setForm((f) => ({ ...f, defaultEntryMethod: e.target.value as ExpenseTypeData['defaultEntryMethod'] }))}>
              {ENTRY_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          </Field>
          <Field label="Notes">
            <Input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="optional" />
          </Field>
          <div className="col-span-full flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} />
              Active
            </label>
            <div className="flex gap-2 ml-auto">
              <Button size="sm" variant="outline" className="h-7" onClick={() => { setAdding(false); setEditId(null) }}><X className="size-3.5" /></Button>
              <Button size="sm" className="h-7 gap-1" disabled={saving} onClick={save}>
                {saving ? <RefreshCw className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save
              </Button>
            </div>
          </div>
        </div>
      )}

      <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
        <table className="w-full text-xs">
          <thead className="bg-slate-50">
            <tr>
              {['Name','Category','Entry Method','Active','Notes',''].map((h) => (
                <th key={h} className="text-left px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground text-xs">No expense types yet</td></tr>
            )}
            {sorted.map((t) => (
              <tr key={t.id} className={cn('border-t border-slate-100', editId === t.id && 'bg-slate-50')}>
                <td className="px-4 py-3 font-medium">{t.name}</td>
                <td className="px-4 py-3 text-muted-foreground">{t.category}</td>
                <td className="px-4 py-3 text-muted-foreground">{t.defaultEntryMethod}</td>
                <td className="px-4 py-3">
                  <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', t.active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500')}>
                    {t.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground max-w-[160px] truncate">{t.notes || '—'}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5 justify-end">
                    <button onClick={() => openEdit(t)} className="p-1 rounded hover:bg-slate-100 text-muted-foreground hover:text-foreground transition-colors"><Pencil className="size-3.5" /></button>
                    <button onClick={() => del(t.id)} className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors"><Trash2 className="size-3.5" /></button>
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

// ── Allocations tab ───────────────────────────────────────────────────────────

function AllocationsTab({ data, trucks }: { data: ExpenseDataState; trucks: Equipment[] }) {
  const [adding, setAdding]   = useState(false)
  const [editId, setEditId]   = useState<string | null>(null)
  const [saving, setSaving]   = useState(false)
  const [form, setForm]       = useState({
    expenseTypeId:    '',
    allocationMethod: 'SPLIT_EVEN' as TruckExpenseAllocationData['allocationMethod'],
    truckIds:         [] as string[],
    notes:            '',
  })

  function openAdd() {
    setForm({ expenseTypeId: '', allocationMethod: 'SPLIT_EVEN', truckIds: [], notes: '' })
    setAdding(true)
    setEditId(null)
  }

  function openEdit(a: TruckExpenseAllocationData) {
    setForm({
      expenseTypeId: a.expenseTypeId,
      allocationMethod: a.allocationMethod,
      truckIds: a.truckIds ?? [],
      notes: a.notes ?? '',
    })
    setEditId(a.id)
    setAdding(false)
  }

  function toggleTruck(id: string) {
    setForm((f) => ({
      ...f,
      truckIds: f.truckIds.includes(id) ? f.truckIds.filter((t) => t !== id) : [...f.truckIds, id],
    }))
  }

  async function save() {
    if (!form.expenseTypeId) return
    setSaving(true)
    try {
      if (editId) {
        await data.updateAlloc(editId, form)
        setEditId(null)
      } else {
        await data.createAlloc(form)
        setAdding(false)
      }
    } finally {
      setSaving(false)
    }
  }

  async function del(id: string) {
    if (!confirm('Delete this allocation?')) return
    await data.deleteAlloc(id)
  }

  const typeMap = new Map(data.expenseTypes.map((t) => [t.id, t]))
  const truckMap = new Map(trucks.map((t) => [t.id, t]))
  const sorted = [...data.allocations].sort((a, b) => {
    const ta = typeMap.get(a.expenseTypeId)?.name ?? ''
    const tb = typeMap.get(b.expenseTypeId)?.name ?? ''
    return ta.localeCompare(tb)
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Allocations</h3>
          <p className="text-xs text-muted-foreground">Defines how costs split across trucks</p>
        </div>
        <Button size="sm" className="h-8 gap-1.5" onClick={openAdd}><Plus className="size-3.5" /> Add Allocation</Button>
      </div>

      {(adding || editId) && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Expense Type">
              <Select value={form.expenseTypeId} onChange={(e) => setForm((f) => ({ ...f, expenseTypeId: e.target.value }))}>
                <option value="">Select type…</option>
                {data.expenseTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
            <Field label="Method">
              <Select value={form.allocationMethod} onChange={(e) => setForm((f) => ({ ...f, allocationMethod: e.target.value as TruckExpenseAllocationData['allocationMethod'] }))}>
                <option value="SPLIT_EVEN">Split Evenly</option>
                <option value="DIRECT">Direct (one truck)</option>
              </Select>
            </Field>
            <Field label="Notes">
              <Input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="optional" className="col-span-2" />
            </Field>
          </div>
          <div>
            <p className="text-xs text-muted-foreground font-medium mb-1.5">Trucks</p>
            <div className="flex flex-wrap gap-2">
              {trucks.filter((t) => t.type === 'truck' && t.active).map((t) => (
                <label
                key={t.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px',
                  borderRadius: 20, border: '1px solid', fontSize: 12, cursor: 'pointer', userSelect: 'none',
                  background: form.truckIds.includes(t.id) ? 'var(--ds-blue)' : 'var(--ds-bg)',
                  borderColor: form.truckIds.includes(t.id) ? 'var(--ds-blue)' : 'var(--ds-border)',
                  color: form.truckIds.includes(t.id) ? '#fff' : 'var(--ds-t2)',
                }}
              >
                  <input type="checkbox" className="sr-only" checked={form.truckIds.includes(t.id)} onChange={() => toggleTruck(t.id)} />
                  #{t.unitNumber}
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="outline" className="h-7" onClick={() => { setAdding(false); setEditId(null) }}><X className="size-3.5" /></Button>
            <Button size="sm" className="h-7 gap-1" disabled={saving} onClick={save}>
              {saving ? <RefreshCw className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save
            </Button>
          </div>
        </div>
      )}

      <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
        <table className="w-full text-xs">
          <thead className="bg-slate-50">
            <tr>
              {['Expense Type','Method','Trucks','Notes',''].map((h) => (
                <th key={h} className="text-left px-4 py-3 font-medium text-muted-foreground">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground text-xs">No allocations yet</td></tr>
            )}
            {sorted.map((a) => (
              <tr key={a.id} className={cn('border-t border-slate-100', editId === a.id && 'bg-slate-50')}>
                <td className="px-4 py-3 font-medium">{typeMap.get(a.expenseTypeId)?.name ?? a.expenseTypeId}</td>
                <td className="px-4 py-3 text-muted-foreground">{a.allocationMethod === 'SPLIT_EVEN' ? 'Split Evenly' : 'Direct'}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {(a.truckIds ?? []).map((id) => (
                      <span key={id} className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-mono">
                        #{truckMap.get(id)?.unitNumber ?? id.slice(-4)}
                      </span>
                    ))}
                    {(a.truckIds ?? []).length === 0 && <span className="text-muted-foreground/40">—</span>}
                  </div>
                </td>
                <td className="px-4 py-3 text-muted-foreground max-w-[160px] truncate">{a.notes || '—'}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5 justify-end">
                    <button onClick={() => openEdit(a)} className="p-1 rounded hover:bg-slate-100 text-muted-foreground hover:text-foreground transition-colors"><Pencil className="size-3.5" /></button>
                    <button onClick={() => del(a.id)} className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors"><Trash2 className="size-3.5" /></button>
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

// ── Recurring tab ─────────────────────────────────────────────────────────────

function RecurringTab({ data }: { data: ExpenseDataState }) {
  const [adding, setAdding] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm]     = useState({
    expenseTypeId: '',
    allocationId:  '',
    monthlyAmount: '',
    startMonth:    '',
    endMonth:      '',
    active:        true,
    notes:         '',
  })

  function openAdd() {
    setForm({ expenseTypeId: '', allocationId: '', monthlyAmount: '', startMonth: '', endMonth: '', active: true, notes: '' })
    setAdding(true)
    setEditId(null)
  }

  function openEdit(r: RecurringExpenseData) {
    setForm({
      expenseTypeId: r.expenseTypeId,
      allocationId:  r.allocationId,
      monthlyAmount: String(r.monthlyAmount),
      startMonth:    r.startMonth,
      endMonth:      r.endMonth ?? '',
      active:        r.active,
      notes:         r.notes ?? '',
    })
    setEditId(r.id)
    setAdding(false)
  }

  async function save() {
    if (!form.expenseTypeId || !form.allocationId || !form.monthlyAmount || !form.startMonth) return
    setSaving(true)
    try {
      const payload = {
        expenseTypeId: form.expenseTypeId,
        allocationId:  form.allocationId,
        monthlyAmount: parseFloat(form.monthlyAmount),
        startMonth:    form.startMonth,
        endMonth:      form.endMonth || null,
        active:        form.active,
        notes:         form.notes || null,
      }
      if (editId) {
        await data.updateRecur(editId, payload)
        setEditId(null)
      } else {
        await data.createRecur(payload)
        setAdding(false)
      }
    } finally {
      setSaving(false)
    }
  }

  async function del(id: string) {
    if (!confirm('Delete this recurring expense?')) return
    await data.deleteRecur(id)
  }

  const typeMap  = new Map(data.expenseTypes.map((t) => [t.id, t]))
  const allocMap = new Map(data.allocations.map((a) => [a.id, a]))
  const sorted   = [...data.recurring].sort((a, b) => b.startMonth.localeCompare(a.startMonth))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Recurring Expenses</h3>
          <p className="text-xs text-muted-foreground">Fixed monthly costs generated automatically on the 1st</p>
        </div>
        <Button size="sm" className="h-8 gap-1.5" onClick={openAdd}><Plus className="size-3.5" /> Add Recurring</Button>
      </div>

      {(adding || editId) && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 grid grid-cols-2 md:grid-cols-3 gap-3">
          <Field label="Expense Type">
            <Select value={form.expenseTypeId} onChange={(e) => setForm((f) => ({ ...f, expenseTypeId: e.target.value }))}>
              <option value="">Select type…</option>
              {data.expenseTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Allocation">
            <Select value={form.allocationId} onChange={(e) => setForm((f) => ({ ...f, allocationId: e.target.value }))}>
              <option value="">Select allocation…</option>
              {data.allocations.map((a) => <option key={a.id} value={a.id}>{typeMap.get(a.expenseTypeId)?.name ?? a.id} — {a.allocationMethod}</option>)}
            </Select>
          </Field>
          <Field label="Monthly Amount ($)">
            <Input type="number" min="0" step="0.01" value={form.monthlyAmount} onChange={(e) => setForm((f) => ({ ...f, monthlyAmount: e.target.value }))} placeholder="0.00" />
          </Field>
          <Field label="Start Month (YYYY-MM)">
            <Input value={form.startMonth} onChange={(e) => setForm((f) => ({ ...f, startMonth: e.target.value }))} placeholder="2026-01" />
          </Field>
          <Field label="End Month (YYYY-MM, optional)">
            <Input value={form.endMonth} onChange={(e) => setForm((f) => ({ ...f, endMonth: e.target.value }))} placeholder="ongoing" />
          </Field>
          <Field label="Notes">
            <Input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="optional" />
          </Field>
          <div className="col-span-full flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} />
              Active
            </label>
            <div className="flex gap-2 ml-auto">
              <Button size="sm" variant="outline" className="h-7" onClick={() => { setAdding(false); setEditId(null) }}><X className="size-3.5" /></Button>
              <Button size="sm" className="h-7 gap-1" disabled={saving} onClick={save}>
                {saving ? <RefreshCw className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save
              </Button>
            </div>
          </div>
        </div>
      )}

      <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
        <table className="w-full text-xs">
          <thead className="bg-slate-50">
            <tr>
              {['Expense Type','Allocation','$/Month','Start','End','Active','Notes',''].map((h) => (
                <th key={h} className="text-left px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-muted-foreground text-xs">No recurring expenses yet</td></tr>
            )}
            {sorted.map((r) => (
              <tr key={r.id} className={cn('border-t border-slate-100', editId === r.id && 'bg-slate-50')}>
                <td className="px-4 py-3 font-medium">{typeMap.get(r.expenseTypeId)?.name ?? '—'}</td>
                <td className="px-4 py-3 text-muted-foreground">
                  {allocMap.get(r.allocationId) ? `${allocMap.get(r.allocationId)!.allocationMethod}` : '—'}
                </td>
                <td className="px-4 py-3 tabular-nums font-medium">{fmtMoney(r.monthlyAmount)}</td>
                <td className="px-4 py-3 text-muted-foreground font-mono">{r.startMonth}</td>
                <td className="px-4 py-3 text-muted-foreground font-mono">{r.endMonth ?? 'ongoing'}</td>
                <td className="px-4 py-3">
                  <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', r.active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500')}>
                    {r.active ? 'Active' : 'Paused'}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground max-w-[140px] truncate">{r.notes || '—'}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5 justify-end">
                    <button onClick={() => openEdit(r)} className="p-1 rounded hover:bg-slate-100 text-muted-foreground hover:text-foreground transition-colors"><Pencil className="size-3.5" /></button>
                    <button onClick={() => del(r.id)} className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors"><Trash2 className="size-3.5" /></button>
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

// ── Manual Entry tab ──────────────────────────────────────────────────────────

function ManualEntryTab({ data, trucks }: { data: ExpenseDataState; trucks: Equipment[] }) {
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)
  const [form, setForm]     = useState({
    expenseTypeId:   '',
    allocationId:    '',
    directTruckId:   '',
    amount:          '',
    periodMonth:     '',
    transactionDate: '',
    notes:           '',
  })

  async function submit() {
    if (!form.expenseTypeId || !form.amount) return
    if (!form.allocationId && !form.directTruckId) {
      alert('Select an allocation or a direct truck.')
      return
    }
    setSaving(true)
    try {
      await data.createRecord({
        expenseTypeId:   form.expenseTypeId,
        allocationId:    form.allocationId || null,
        amount:          parseFloat(form.amount),
        periodMonth:     form.periodMonth || null,
        transactionDate: form.transactionDate || null,
        entryMethod:     'MANUAL',
        directTruckId:   form.directTruckId || null,
        notes:           form.notes || null,
        source:          'manual-entry',
      })
      setForm({ expenseTypeId: '', allocationId: '', directTruckId: '', amount: '', periodMonth: '', transactionDate: '', notes: '' })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Manual Expense Entry</h3>
        <p className="text-xs text-muted-foreground">Record a one-off cost not covered by recurring or fuel import</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 grid grid-cols-2 md:grid-cols-3 gap-3 max-w-2xl">
        <Field label="Expense Type">
          <Select value={form.expenseTypeId} onChange={(e) => setForm((f) => ({ ...f, expenseTypeId: e.target.value, allocationId: '', directTruckId: '' }))}>
            <option value="">Select type…</option>
            {data.expenseTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="Amount ($)">
          <Input type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} placeholder="0.00" />
        </Field>
        <Field label="Allocation (split)">
          <Select value={form.allocationId} onChange={(e) => setForm((f) => ({ ...f, allocationId: e.target.value, directTruckId: '' }))}>
            <option value="">None</option>
            {data.allocations
              .filter((a) => !form.expenseTypeId || a.expenseTypeId === form.expenseTypeId)
              .map((a) => <option key={a.id} value={a.id}>{a.allocationMethod} — {(a.truckIds ?? []).length} truck(s)</option>)}
          </Select>
        </Field>
        <Field label="– or – Direct Truck">
          <Select value={form.directTruckId} onChange={(e) => setForm((f) => ({ ...f, directTruckId: e.target.value, allocationId: '' }))}>
            <option value="">None</option>
            {trucks.filter((t) => t.type === 'truck' && t.active).map((t) => <option key={t.id} value={t.id}>#{t.unitNumber}</option>)}
          </Select>
        </Field>
        <Field label="Period Month (for recurring-style)">
          <Input value={form.periodMonth} onChange={(e) => setForm((f) => ({ ...f, periodMonth: e.target.value }))} placeholder="2026-05" />
        </Field>
        <Field label="Transaction Date (for one-off)">
          <Input type="date" value={form.transactionDate} onChange={(e) => setForm((f) => ({ ...f, transactionDate: e.target.value }))} />
        </Field>
        <Field label="Notes">
          <Input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="optional" className="md:col-span-3" />
        </Field>
        <div className="col-span-full flex items-center gap-3">
          <Button className="h-8 gap-1.5" disabled={saving} onClick={submit}>
            {saving ? <RefreshCw className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Add Record
          </Button>
          {saved && <span className="text-xs text-emerald-600 font-medium flex items-center gap-1"><Check className="size-3.5" /> Saved</span>}
        </div>
      </div>

      {/* Recent manual entries */}
      {data.records.filter((r) => r.source === 'manual-entry').length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground font-medium mb-2">Recent manual entries</p>
          <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  {['Type','Amount','Period/Date','Truck','Notes',''].map((h) => (
                    <th key={h} className="text-left px-4 py-3 font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...data.records.filter((r) => r.source === 'manual-entry')]
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .slice(0, 20)
                  .map((r) => {
                    const typeName = data.expenseTypes.find((t) => t.id === r.expenseTypeId)?.name ?? '—'
                    const truckNum = trucks.find((t) => t.id === r.directTruckId)?.unitNumber
                    return (
                      <tr key={r.id} className="border-t border-slate-100">
                        <td className="px-4 py-3 font-medium">{typeName}</td>
                        <td className="px-4 py-3 tabular-nums">{fmtMoney(r.amount)}</td>
                        <td className="px-4 py-3 font-mono text-muted-foreground">{r.periodMonth ?? r.transactionDate ?? '—'}</td>
                        <td className="px-4 py-3 text-muted-foreground">{truckNum ? `#${truckNum}` : '—'}</td>
                        <td className="px-4 py-3 text-muted-foreground max-w-[140px] truncate">{r.notes || '—'}</td>
                        <td className="px-4 py-3">
                          <button onClick={() => { if (confirm('Delete?')) data.deleteRecord(r.id) }} className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors">
                            <Trash2 className="size-3.5" />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

type ManageTab = 'types' | 'allocations' | 'recurring' | 'manual'

const MANAGE_TABS: { value: ManageTab; label: string }[] = [
  { value: 'types',       label: 'Expense Types'   },
  { value: 'allocations', label: 'Allocations'     },
  { value: 'recurring',   label: 'Recurring'       },
  { value: 'manual',      label: 'Manual Entry'    },
]

export function ExpenseManageView({ data, trucks }: { data: ExpenseDataState; trucks: Equipment[] }) {
  const [tab, setTab] = useState<ManageTab>('types')

  return (
    <div className="space-y-5">
      {/* Sub-tab bar */}
      <div style={{ display: 'flex', background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 9, padding: 3, gap: 2 }}>
        {MANAGE_TABS.map((t) => {
          const active = tab === t.value
          return (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              style={{
                padding: '4px 14px', borderRadius: 7, border: 'none', cursor: 'pointer',
                fontSize: 12.5, fontWeight: active ? 600 : 500, fontFamily: 'inherit',
                background: active ? '#fff' : 'transparent',
                color: active ? 'var(--ds-t1)' : 'var(--ds-t3)',
                boxShadow: active ? 'var(--sh-sm)' : 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {tab === 'types'       && <ExpenseTypesTab  data={data} />}
      {tab === 'allocations' && <AllocationsTab   data={data} trucks={trucks} />}
      {tab === 'recurring'   && <RecurringTab     data={data} />}
      {tab === 'manual'      && <ManualEntryTab   data={data} trucks={trucks} />}
    </div>
  )
}
