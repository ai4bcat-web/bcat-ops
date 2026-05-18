import { useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  Truck, Container, Plus, Pencil, Trash2, ChevronDown, ChevronUp,
  CheckCircle2, AlertTriangle, Clock, Wrench, FileText, X, Check,
} from 'lucide-react'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { Equipment, MaintenanceTask, MaintenanceInvoice, EquipmentType, Ownership, TaskPriority, TaskStatus } from '@/types/equipment'

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().slice(0, 10) }

type ExpiryState = 'overdue' | 'expiring' | 'ok' | 'none'

function expiryState(dateStr?: string): ExpiryState {
  if (!dateStr) return 'none'
  const days = Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000)
  if (days < 0) return 'overdue'
  if (days <= 30) return 'expiring'
  return 'ok'
}

function ExpiryBadge({ date, label }: { date?: string; label: string }) {
  const state = expiryState(date)
  if (state === 'none') return <span className="text-xs text-slate-400">—</span>
  const styles: Record<ExpiryState, string> = {
    overdue:  'bg-red-50 text-red-700 border-red-200',
    expiring: 'bg-amber-50 text-amber-700 border-amber-200',
    ok:       'bg-emerald-50 text-emerald-700 border-emerald-200',
    none:     '',
  }
  const icon: Record<ExpiryState, React.ReactNode> = {
    overdue:  <AlertTriangle className="size-3" />,
    expiring: <Clock className="size-3" />,
    ok:       <CheckCircle2 className="size-3" />,
    none:     null,
  }
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border', styles[state])}>
      {icon[state]}{label}: {date}
    </span>
  )
}

function DateCell({ date }: { date?: string }) {
  const state = expiryState(date)
  if (state === 'none') return <span className="text-muted-foreground/40 text-xs">—</span>
  const cls = state === 'overdue' ? 'text-red-600 font-semibold' : state === 'expiring' ? 'text-amber-600 font-semibold' : 'text-emerald-700'
  const icon = state === 'overdue' ? <AlertTriangle className="size-3 shrink-0" /> : state === 'expiring' ? <Clock className="size-3 shrink-0" /> : null
  return <span className={cn('inline-flex items-center gap-1 text-xs font-mono', cls)}>{icon}{date}</span>
}

function priorityColor(p: TaskPriority) {
  return p === 'high' ? 'bg-red-50 text-red-700 border-red-200'
       : p === 'med'  ? 'bg-amber-50 text-amber-700 border-amber-200'
       :                'bg-slate-50 text-slate-600 border-slate-200'
}

function formatCents(cents: number) {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// ── Equipment Form Modal ───────────────────────────────────────────────────────

interface EquipmentFormProps {
  initial?: Partial<Equipment>
  onSave: (data: Omit<Equipment, 'id' | 'createdAt' | 'updatedAt'>) => void
  onClose: () => void
}

function EquipmentForm({ initial, onSave, onClose }: EquipmentFormProps) {
  const [form, setForm] = useState({
    type:                    (initial?.type ?? 'truck') as EquipmentType,
    unitNumber:              initial?.unitNumber ?? '',
    nickname:                initial?.nickname ?? '',
    make:                    initial?.make ?? '',
    model:                   initial?.model ?? '',
    year:                    initial?.year?.toString() ?? '',
    plate:                   initial?.plate ?? '',
    vin:                     initial?.vin ?? '',
    mileage:                 initial?.mileage?.toString() ?? '',
    ownership:               (initial?.ownership ?? 'owned') as Ownership,
    insured:                 initial?.insured ?? true,
    active:                  initial?.active ?? true,
    onTollwayAccount:        initial?.onTollwayAccount ?? false,
    dotInspectionDate:       initial?.dotInspectionDate ?? '',
    insuranceExpirationDate: initial?.insuranceExpirationDate ?? '',
    iftaExpirationDate:      initial?.iftaExpirationDate ?? '',
    irpExpirationDate:       initial?.irpExpirationDate ?? '',
    bobtailInsuranceDate:    initial?.bobtailInsuranceDate ?? '',
    fleetManagerAssignee:    initial?.fleetManagerAssignee ?? '',
    notes:                   initial?.notes ?? '',
  })

  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }))
  const isTruck = form.type === 'truck'

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    onSave({
      type: form.type,
      unitNumber: form.unitNumber.trim(),
      nickname: form.nickname.trim() || undefined,
      make: form.make.trim(),
      model: form.model.trim(),
      year: form.year ? parseInt(form.year) : undefined,
      plate: form.plate.trim() || undefined,
      vin: form.vin.trim() || undefined,
      mileage: form.mileage ? parseInt(form.mileage) : undefined,
      ownership: form.ownership,
      insured: form.insured,
      active: form.active,
      onTollwayAccount: form.onTollwayAccount,
      dotInspectionDate: form.dotInspectionDate || undefined,
      insuranceExpirationDate: form.insuranceExpirationDate || undefined,
      iftaExpirationDate: isTruck ? (form.iftaExpirationDate || undefined) : undefined,
      irpExpirationDate: isTruck ? (form.irpExpirationDate || undefined) : undefined,
      bobtailInsuranceDate: form.bobtailInsuranceDate || undefined,
      fleetManagerAssignee: form.fleetManagerAssignee || undefined,
      notes: form.notes.trim() || undefined,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100">
          <h2 className="text-base font-semibold">{initial?.id ? 'Edit Equipment' : 'Add Equipment'}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="size-4" /></button>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-5">
          {/* Type + Unit + Nickname */}
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Type *</Label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.type} onChange={(e) => set('type', e.target.value)}>
                <option value="truck">Truck</option>
                <option value="trailer">Trailer</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Unit # *</Label>
              <Input value={form.unitNumber} onChange={(e) => set('unitNumber', e.target.value)} placeholder="e.g. 530" required className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Nickname</Label>
              <Input value={form.nickname} onChange={(e) => set('nickname', e.target.value)} placeholder="Optional" className="h-9" />
            </div>
          </div>

          {/* Make / Model / Year */}
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Make</Label>
              <Input value={form.make} onChange={(e) => set('make', e.target.value)} placeholder="Freightliner" className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Model</Label>
              <Input value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="Cascadia" className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Year</Label>
              <Input type="number" value={form.year} onChange={(e) => set('year', e.target.value)} placeholder="2022" className="h-9" />
            </div>
          </div>

          {/* Plate / VIN / Mileage */}
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Plate</Label>
              <Input value={form.plate} onChange={(e) => set('plate', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">VIN</Label>
              <Input value={form.vin} onChange={(e) => set('vin', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Mileage</Label>
              <Input type="number" value={form.mileage} onChange={(e) => set('mileage', e.target.value)} className="h-9" />
            </div>
          </div>

          {/* Ownership + Fleet Manager */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Ownership</Label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.ownership} onChange={(e) => set('ownership', e.target.value)}>
                <option value="owned">Owned</option>
                <option value="leased">Leased</option>
                <option value="rented">Rented</option>
                <option value="financed">Financed</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Fleet Manager</Label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.fleetManagerAssignee} onChange={(e) => set('fleetManagerAssignee', e.target.value)}>
                <option value="">— None —</option>
                <option value="jason">Jason</option>
                <option value="ryne">Ryne</option>
              </select>
            </div>
          </div>

          {/* Compliance dates */}
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Compliance Dates</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Last DOT Inspection</Label>
                <Input type="date" value={form.dotInspectionDate} onChange={(e) => set('dotInspectionDate', e.target.value)} className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Insurance Expiry</Label>
                <Input type="date" value={form.insuranceExpirationDate} onChange={(e) => set('insuranceExpirationDate', e.target.value)} className="h-9" />
              </div>
              {isTruck && (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">IFTA Expiration</Label>
                    <Input type="date" value={form.iftaExpirationDate} onChange={(e) => set('iftaExpirationDate', e.target.value)} className="h-9" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">IRP Expiration</Label>
                    <Input type="date" value={form.irpExpirationDate} onChange={(e) => set('irpExpirationDate', e.target.value)} className="h-9" />
                  </div>
                </>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Bobtail Insurance Expiry</Label>
                <Input type="date" value={form.bobtailInsuranceDate} onChange={(e) => set('bobtailInsuranceDate', e.target.value)} className="h-9" />
              </div>
            </div>
          </div>

          {/* Toggles */}
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            {([
              ['insured',         'Insured'],
              ['active',          'Active'],
              ['onTollwayAccount','On Tollway Account'],
            ] as [string, string][]).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={form[key as keyof typeof form] as boolean} onChange={(e) => set(key, e.target.checked)} className="rounded" />
                {label}
              </label>
            ))}
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Notes</Label>
            <textarea
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={2}
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="Optional notes"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Task Form Modal ────────────────────────────────────────────────────────────

interface TaskFormProps {
  equipmentId: string
  initial?: Partial<MaintenanceTask>
  onSave: (data: Omit<MaintenanceTask, 'id' | 'createdAt' | 'updatedAt'>) => void
  onClose: () => void
}

function TaskForm({ equipmentId, initial, onSave, onClose }: TaskFormProps) {
  const [form, setForm] = useState({
    title:    initial?.title ?? '',
    dueDate:  initial?.dueDate ?? '',
    priority: (initial?.priority ?? 'med') as TaskPriority,
    status:   (initial?.status ?? 'upcoming') as TaskStatus,
    notes:    initial?.notes ?? '',
    autoDot:  initial?.autoDot ?? false,
    assignee: initial?.assignee ?? '',
  })
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100">
          <h2 className="text-base font-semibold">{initial?.id ? 'Edit Task' : 'Add Maintenance Task'}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="size-4" /></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); onSave({ equipmentId, title: form.title.trim(), dueDate: form.dueDate || undefined, priority: form.priority, status: form.status, notes: form.notes.trim() || undefined, autoDot: form.autoDot, assignee: form.assignee || undefined }) }} className="px-6 py-5 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Task *</Label>
            <Input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Oil change" required className="h-9" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Due Date</Label>
              <Input type="date" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Priority</Label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
                <option value="high">High</option>
                <option value="med">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Status</Label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.status} onChange={(e) => set('status', e.target.value)}>
                <option value="upcoming">Upcoming</option>
                <option value="complete">Complete</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Assignee</Label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.assignee} onChange={(e) => set('assignee', e.target.value)}>
                <option value="">— None —</option>
                <option value="jason">Jason</option>
                <option value="ryne">Ryne</option>
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={form.autoDot} onChange={(e) => set('autoDot', e.target.checked)} className="rounded" />
            Auto-generate DOT inspection task
          </label>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Notes</Label>
            <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary" />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Invoice Form Modal ─────────────────────────────────────────────────────────

interface InvoiceFormProps {
  equipmentId: string
  initial?: Partial<MaintenanceInvoice>
  onSave: (data: Omit<MaintenanceInvoice, 'id' | 'createdAt' | 'updatedAt'>) => void
  onClose: () => void
}

function InvoiceForm({ equipmentId, initial, onSave, onClose }: InvoiceFormProps) {
  const [form, setForm] = useState({
    date:          initial?.date ?? today(),
    vendor:        initial?.vendor ?? '',
    description:   initial?.description ?? '',
    amount:        initial?.amount ? (initial.amount / 100).toFixed(2) : '',
    invoiceNumber: initial?.invoiceNumber ?? '',
    paymentMethod: initial?.paymentMethod ?? '',
    paymentDate:   initial?.paymentDate ?? '',
    assignee:      initial?.assignee ?? '',
  })
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100">
          <h2 className="text-base font-semibold">{initial?.id ? 'Edit Invoice' : 'Add Invoice'}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="size-4" /></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); onSave({ equipmentId, date: form.date || undefined, vendor: form.vendor.trim() || undefined, description: form.description.trim() || undefined, amount: Math.round(parseFloat(form.amount || '0') * 100), invoiceNumber: form.invoiceNumber.trim() || undefined, paymentMethod: form.paymentMethod || undefined, paymentDate: form.paymentDate || undefined, assignee: form.assignee || undefined }) }} className="px-6 py-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Date</Label>
              <Input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Amount *</Label>
              <Input type="number" step="0.01" value={form.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0.00" required className="h-9" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Vendor</Label>
            <Input value={form.vendor} onChange={(e) => set('vendor', e.target.value)} placeholder="Rush Truck Centers" className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Description</Label>
            <Input value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Oil change, brake inspection…" className="h-9" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Invoice #</Label>
              <Input value={form.invoiceNumber} onChange={(e) => set('invoiceNumber', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Payment Method</Label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.paymentMethod} onChange={(e) => set('paymentMethod', e.target.value)}>
                <option value="">— None —</option>
                <option value="check">Check</option>
                <option value="card">Card</option>
                <option value="ach">ACH</option>
                <option value="cash">Cash</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Payment Date</Label>
              <Input type="date" value={form.paymentDate} onChange={(e) => set('paymentDate', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Assignee</Label>
              <select className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm bg-white" value={form.assignee} onChange={(e) => set('assignee', e.target.value)}>
                <option value="">— None —</option>
                <option value="jason">Jason</option>
                <option value="ryne">Ryne</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Equipment Detail Panel ─────────────────────────────────────────────────────

interface DetailPanelProps {
  equip: Equipment
  tasks: MaintenanceTask[]
  invoices: MaintenanceInvoice[]
  driverName?: string
}

function DetailPanel({ equip, tasks, invoices, driverName }: DetailPanelProps) {
  const addMaintenanceTask    = useAppStore((s) => s.addMaintenanceTask)
  const updateMaintenanceTask = useAppStore((s) => s.updateMaintenanceTask)
  const deleteMaintenanceTask = useAppStore((s) => s.deleteMaintenanceTask)
  const addMaintenanceInvoice    = useAppStore((s) => s.addMaintenanceInvoice)
  const deleteMaintenanceInvoice = useAppStore((s) => s.deleteMaintenanceInvoice)

  const [taskModal, setTaskModal]       = useState<Partial<MaintenanceTask> | 'new' | null>(null)
  const [invoiceModal, setInvoiceModal] = useState<Partial<MaintenanceInvoice> | 'new' | null>(null)

  const upcoming = tasks.filter((t) => t.status === 'upcoming').sort((a, b) => (a.dueDate ?? '') < (b.dueDate ?? '') ? -1 : 1)
  const complete  = tasks.filter((t) => t.status === 'complete')

  const isTruck = equip.type === 'truck'

  return (
    <div className="bg-slate-50/60 border-t border-slate-100 px-6 py-5 space-y-5">

      {/* Compliance */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Compliance</p>
        <div className="flex flex-wrap gap-2">
          <ExpiryBadge date={equip.dotInspectionDate}       label="DOT" />
          <ExpiryBadge date={equip.insuranceExpirationDate} label="Insurance" />
          {isTruck && <ExpiryBadge date={equip.iftaExpirationDate} label="IFTA" />}
          {isTruck && <ExpiryBadge date={equip.irpExpirationDate}  label="IRP" />}
          <ExpiryBadge date={equip.bobtailInsuranceDate}    label="Bobtail" />
        </div>
        {!equip.dotInspectionDate && !equip.insuranceExpirationDate && (
          <p className="text-xs text-slate-400 mt-1">No compliance dates entered.</p>
        )}
      </div>

      {/* Info row */}
      <div className="grid grid-cols-3 gap-4 text-sm">
        {[
          ['Assigned Driver', driverName || '—'],
          ['Fleet Manager',   equip.fleetManagerAssignee ? equip.fleetManagerAssignee.charAt(0).toUpperCase() + equip.fleetManagerAssignee.slice(1) : '—'],
          ['Tollway Account', equip.onTollwayAccount ? 'Yes' : 'No'],
          ['Ownership',       equip.ownership.charAt(0).toUpperCase() + equip.ownership.slice(1)],
          ['Mileage',         equip.mileage ? equip.mileage.toLocaleString() + ' mi' : '—'],
          ['VIN',             equip.vin || '—'],
        ].map(([label, value]) => (
          <div key={label}>
            <span className="text-xs text-muted-foreground">{label}</span>
            <p className="text-sm font-medium text-foreground truncate">{value}</p>
          </div>
        ))}
      </div>

      {equip.notes && (
        <p className="text-sm text-muted-foreground bg-white/80 rounded-lg px-4 py-3 border border-slate-100">{equip.notes}</p>
      )}

      <Separator />

      {/* Maintenance Tasks */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Maintenance Tasks</p>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setTaskModal('new')}>
            <Plus className="size-3" /> Add Task
          </Button>
        </div>

        {upcoming.length === 0 && complete.length === 0 ? (
          <p className="text-xs text-slate-400">No tasks yet.</p>
        ) : (
          <div className="space-y-1.5">
            {upcoming.map((t) => (
              <div key={t.id} className="flex items-center gap-3 bg-white rounded-lg px-3 py-2 border border-slate-100">
                <button onClick={() => updateMaintenanceTask(t.id, { status: 'complete' })} className="shrink-0 text-slate-300 hover:text-emerald-500 transition-colors">
                  <CheckCircle2 className="size-4" />
                </button>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-foreground">{t.title}</span>
                  {t.dueDate && <span className="text-xs text-muted-foreground ml-2">Due {t.dueDate}</span>}
                </div>
                <span className={cn('text-xs font-semibold px-2 py-0.5 rounded-full border', priorityColor(t.priority))}>
                  {t.priority === 'high' ? 'High' : t.priority === 'med' ? 'Med' : 'Low'}
                </span>
                <button onClick={() => setTaskModal(t)} className="text-slate-400 hover:text-slate-600"><Pencil className="size-3.5" /></button>
                <button onClick={() => deleteMaintenanceTask(t.id)} className="text-slate-400 hover:text-red-500"><Trash2 className="size-3.5" /></button>
              </div>
            ))}
            {complete.length > 0 && (
              <p className="text-xs text-slate-400 pt-1">{complete.length} completed task{complete.length !== 1 ? 's' : ''}</p>
            )}
          </div>
        )}
      </div>

      <Separator />

      {/* Invoices */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Maintenance Invoices
            {invoices.length > 0 && (
              <span className="ml-2 font-normal text-foreground">
                {formatCents(invoices.reduce((s, i) => s + i.amount, 0))} total
              </span>
            )}
          </p>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setInvoiceModal('new')}>
            <Plus className="size-3" /> Add Invoice
          </Button>
        </div>

        {invoices.length === 0 ? (
          <p className="text-xs text-slate-400">No invoices yet.</p>
        ) : (
          <div className="space-y-1.5">
            {[...invoices].sort((a, b) => (b.date ?? '') < (a.date ?? '') ? -1 : 1).map((inv) => (
              <div key={inv.id} className="flex items-center gap-3 bg-white rounded-lg px-3 py-2 border border-slate-100">
                <FileText className="size-4 text-slate-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-foreground">{inv.vendor || 'Unknown vendor'}</span>
                  {inv.description && <span className="text-xs text-muted-foreground ml-2">{inv.description}</span>}
                  {inv.date && <span className="text-xs text-slate-400 ml-2">{inv.date}</span>}
                </div>
                <span className="text-sm font-semibold text-foreground">{formatCents(inv.amount)}</span>
                <button onClick={() => deleteMaintenanceInvoice(inv.id)} className="text-slate-400 hover:text-red-500"><Trash2 className="size-3.5" /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Task Modal */}
      {taskModal !== null && (
        <TaskForm
          equipmentId={equip.id}
          initial={taskModal === 'new' ? undefined : taskModal}
          onSave={(data) => {
            if (taskModal !== 'new' && taskModal?.id) {
              updateMaintenanceTask(taskModal.id, data)
            } else {
              addMaintenanceTask(data)
            }
            setTaskModal(null)
          }}
          onClose={() => setTaskModal(null)}
        />
      )}

      {/* Invoice Modal */}
      {invoiceModal !== null && (
        <InvoiceForm
          equipmentId={equip.id}
          initial={invoiceModal === 'new' ? undefined : invoiceModal}
          onSave={(data) => {
            addMaintenanceInvoice(data)
            setInvoiceModal(null)
          }}
          onClose={() => setInvoiceModal(null)}
        />
      )}
    </div>
  )
}

// ── Equipment Table Row ────────────────────────────────────────────────────────

interface EquipRowProps {
  equip: Equipment
  tasks: MaintenanceTask[]
  invoices: MaintenanceInvoice[]
  driverName?: string
  colSpan: number
  onEdit: (e: Equipment) => void
  onDelete: (id: string) => void
}

function EquipRow({ equip, tasks, invoices, driverName, colSpan, onEdit, onDelete }: EquipRowProps) {
  const [expanded, setExpanded] = useState(false)

  const upcomingTasks = tasks.filter((t) => t.status === 'upcoming')
  const highTasks     = upcomingTasks.filter((t) => t.priority === 'high')
  const repairSpend   = invoices.reduce((s, i) => s + i.amount, 0)
  const isTruck       = equip.type === 'truck'

  const hasAlert = [
    equip.dotInspectionDate, equip.insuranceExpirationDate,
    equip.iftaExpirationDate, equip.irpExpirationDate, equip.bobtailInsuranceDate,
  ].some((d) => expiryState(d) === 'overdue' || expiryState(d) === 'expiring')

  return (
    <>
      <TableRow
        className={cn('cursor-pointer hover:bg-slate-50/80 transition-colors', !equip.active && 'opacity-50', expanded && 'bg-slate-50')}
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Type */}
        <TableCell className="py-3">
          <span className={cn('inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border',
            isTruck ? 'bg-sky-50 text-sky-700 border-sky-200' : 'bg-violet-50 text-violet-700 border-violet-200'
          )}>
            {isTruck ? <Truck className="size-3" /> : <Container className="size-3" />}
            {isTruck ? 'Truck' : 'Trailer'}
          </span>
        </TableCell>

        {/* Unit # */}
        <TableCell className="py-3 font-bold text-sm text-foreground">
          #{equip.unitNumber}
          {equip.nickname && <div className="text-xs text-muted-foreground font-normal">{equip.nickname}</div>}
        </TableCell>

        {/* Year / Make / Model */}
        <TableCell className="py-3 text-sm">
          <span className="font-medium">{equip.year}</span>
          <span className="text-muted-foreground ml-1">{[equip.make, equip.model].filter(Boolean).join(' ')}</span>
        </TableCell>

        {/* Plate */}
        <TableCell className="py-3 text-xs font-mono text-foreground">
          {equip.plate || <span className="text-muted-foreground/40">—</span>}
        </TableCell>

        {/* DOT Inspection */}
        <TableCell className="py-3"><DateCell date={equip.dotInspectionDate} /></TableCell>

        {/* IFTA */}
        <TableCell className="py-3">
          {isTruck ? <DateCell date={equip.iftaExpirationDate} /> : <span className="text-muted-foreground/40 text-xs">—</span>}
        </TableCell>

        {/* IRP */}
        <TableCell className="py-3">
          {isTruck ? <DateCell date={equip.irpExpirationDate} /> : <span className="text-muted-foreground/40 text-xs">—</span>}
        </TableCell>

        {/* Insurance */}
        <TableCell className="py-3"><DateCell date={equip.insuranceExpirationDate} /></TableCell>

        {/* Bobtail */}
        <TableCell className="py-3">
          {isTruck ? <DateCell date={equip.bobtailInsuranceDate} /> : <span className="text-muted-foreground/40 text-xs">—</span>}
        </TableCell>

        {/* Driver */}
        <TableCell className="py-3 text-sm">
          {isTruck
            ? driverName
              ? <span className="text-foreground font-medium">{driverName}</span>
              : <span className="text-muted-foreground/40 text-xs">Unassigned</span>
            : <span className="text-muted-foreground/40 text-xs">—</span>}
        </TableCell>

        {/* Fleet Mgr */}
        <TableCell className="py-3 text-xs text-muted-foreground capitalize">
          {equip.fleetManagerAssignee || '—'}
        </TableCell>

        {/* Tollway */}
        <TableCell className="py-3">
          {equip.onTollwayAccount
            ? <span className="inline-flex items-center gap-1 text-xs text-emerald-700 font-medium"><Check className="size-3" />Yes</span>
            : <span className="text-xs text-muted-foreground/40">No</span>}
        </TableCell>

        {/* Tasks */}
        <TableCell className="py-3">
          {upcomingTasks.length === 0
            ? <span className="text-xs text-muted-foreground/40">None</span>
            : highTasks.length > 0
              ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-600">
                  <AlertTriangle className="size-3" />{highTasks.length} high{upcomingTasks.length > highTasks.length ? ` · ${upcomingTasks.length - highTasks.length} other` : ''}
                </span>
              : <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600">
                  <Wrench className="size-3" />{upcomingTasks.length} open
                </span>}
        </TableCell>

        {/* Repair Spend */}
        <TableCell className="py-3 text-xs font-mono font-semibold text-foreground">
          {repairSpend > 0 ? formatCents(repairSpend) : <span className="text-muted-foreground/40">—</span>}
        </TableCell>

        {/* Actions */}
        <TableCell className="py-3" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1 justify-end">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => onEdit(equip)}>
                  <Pencil className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:bg-destructive/5" onClick={() => onDelete(equip.id)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete</TooltipContent>
            </Tooltip>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground">
              {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </Button>
          </div>
        </TableCell>
      </TableRow>

      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={colSpan} className="p-0 border-b border-slate-100">
            <DetailPanel equip={equip} tasks={tasks} invoices={invoices} driverName={driverName} />
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function TrucksPage() {
  const equipment          = useAppStore((s) => s.equipment)
  const maintenanceTasks   = useAppStore((s) => s.maintenanceTasks)
  const maintenanceInvoices = useAppStore((s) => s.maintenanceInvoices)
  const drivers            = useAppStore((s) => s.drivers)
  const addEquipment       = useAppStore((s) => s.addEquipment)
  const updateEquipment    = useAppStore((s) => s.updateEquipment)
  const deleteEquipment    = useAppStore((s) => s.deleteEquipment)

  const [typeFilter, setTypeFilter] = useState<'all' | 'truck' | 'trailer'>('all')
  const [search, setSearch]         = useState('')
  const [showForm, setShowForm]     = useState<Equipment | 'new' | null>(null)

  const filtered = equipment.filter((e) => {
    if (typeFilter !== 'all' && e.type !== typeFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        e.unitNumber.toLowerCase().includes(q) ||
        e.make.toLowerCase().includes(q) ||
        e.model.toLowerCase().includes(q) ||
        (e.plate ?? '').toLowerCase().includes(q) ||
        (e.nickname ?? '').toLowerCase().includes(q)
      )
    }
    return true
  })

  const trucks   = equipment.filter((e) => e.type === 'truck')
  const trailers = equipment.filter((e) => e.type === 'trailer')
  const alertCount = equipment.filter((e) => {
    return [e.dotInspectionDate, e.insuranceExpirationDate, e.iftaExpirationDate, e.irpExpirationDate, e.bobtailInsuranceDate]
      .some((d) => expiryState(d) === 'overdue' || expiryState(d) === 'expiring')
  }).length

  function handleSave(data: Omit<Equipment, 'id' | 'createdAt' | 'updatedAt'>) {
    if (showForm && showForm !== 'new') {
      updateEquipment(showForm.id, data)
    } else {
      addEquipment(data)
    }
    setShowForm(null)
  }

  function handleDelete(id: string) {
    if (!confirm('Delete this equipment and all its tasks/invoices?')) return
    deleteEquipment(id)
  }

  return (
    <div className="h-full overflow-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-slate-200">
        <div className="flex items-center justify-between px-8 pt-5 pb-3">
          <div>
            <h1 className="text-2xl font-semibold text-foreground tracking-tight">Fleet</h1>
            <p className="text-sm text-slate-500 mt-0.5">Equipment, compliance & maintenance</p>
          </div>
          <Button className="h-9 gap-2" onClick={() => setShowForm('new')}>
            <Plus className="size-4" /> Add Equipment
          </Button>
        </div>

        {/* KPIs */}
        <div className="flex items-center gap-3 px-8 pb-4 overflow-x-auto">
          <div className="ds-kpi"><div className="ds-kpi-label">Total Units</div><div className="ds-kpi-value">{equipment.length}</div></div>
          <div className="ds-kpi"><div className="ds-kpi-label">Trucks</div><div className="ds-kpi-value">{trucks.length}</div></div>
          <div className="ds-kpi"><div className="ds-kpi-label">Trailers</div><div className="ds-kpi-value">{trailers.length}</div></div>
          <div className="ds-kpi"><div className="ds-kpi-label">Compliance Alerts</div><div className="ds-kpi-value amber">{alertCount}</div></div>
          <div className="ds-kpi"><div className="ds-kpi-label">Open Tasks</div><div className="ds-kpi-value">{maintenanceTasks.filter((t) => t.status === 'upcoming').length}</div></div>
        </div>
      </div>

      <div className="p-8 space-y-4">
        {/* Toolbar */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex rounded-lg border border-slate-200 bg-white overflow-hidden shrink-0">
            {(['all', 'truck', 'trailer'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setTypeFilter(f)}
                className={cn('px-4 py-2 text-sm font-medium transition-colors',
                  typeFilter === f ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'
                )}
              >
                {f === 'all' ? 'All' : f === 'truck' ? 'Trucks' : 'Trailers'}
              </button>
            ))}
          </div>
          <Input
            placeholder="Search equipment…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-64"
          />
        </div>

        {/* Equipment table */}
        <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm overflow-x-auto">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
              <Truck className="size-8 opacity-20" />
              <p className="text-sm">No equipment found.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent bg-slate-50/60">
                  <TableHead className="py-3 text-xs">Type</TableHead>
                  <TableHead className="py-3 text-xs">Unit #</TableHead>
                  <TableHead className="py-3 text-xs min-w-[160px]">Year / Make / Model</TableHead>
                  <TableHead className="py-3 text-xs">Plate</TableHead>
                  <TableHead className="py-3 text-xs min-w-[100px]">DOT Insp</TableHead>
                  <TableHead className="py-3 text-xs min-w-[100px]">IFTA Exp</TableHead>
                  <TableHead className="py-3 text-xs min-w-[100px]">IRP Exp</TableHead>
                  <TableHead className="py-3 text-xs min-w-[100px]">Insurance</TableHead>
                  <TableHead className="py-3 text-xs min-w-[100px]">Bobtail Ins</TableHead>
                  <TableHead className="py-3 text-xs min-w-[120px]">Driver</TableHead>
                  <TableHead className="py-3 text-xs">Fleet Mgr</TableHead>
                  <TableHead className="py-3 text-xs">Tollway</TableHead>
                  <TableHead className="py-3 text-xs min-w-[120px]">Open Tasks</TableHead>
                  <TableHead className="py-3 text-xs min-w-[100px]">Repair Spend</TableHead>
                  <TableHead className="py-3 w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((e) => {
                  const driver = drivers.find((d) => d.id === e.assignedDriverId)
                  const tasks  = maintenanceTasks.filter((t) => t.equipmentId === e.id)
                  const invs   = maintenanceInvoices.filter((inv) => inv.equipmentId === e.id)
                  return (
                    <EquipRow
                      key={e.id}
                      equip={e}
                      tasks={tasks}
                      invoices={invs}
                      driverName={driver?.name}
                      colSpan={15}
                      onEdit={setShowForm}
                      onDelete={handleDelete}
                    />
                  )
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      {showForm !== null && (
        <EquipmentForm
          initial={showForm === 'new' ? undefined : showForm}
          onSave={handleSave}
          onClose={() => setShowForm(null)}
        />
      )}
    </div>
  )
}
