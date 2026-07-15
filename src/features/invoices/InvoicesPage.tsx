import { useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useIsMobile } from '@/hooks/useIsMobile'
import { Receipt, History, FileText, Trash2, Pencil, Plus, Search, ChevronDown, ArrowUp, ArrowDown } from 'lucide-react'
import { toast } from 'sonner'
import type { Equipment, MaintenanceInvoice } from '@/types/equipment'
import {
  formatCents, thBase, tdBase, equipChipStyle, iconBtnStyle,
  Pill, inputStyle, btnGhost, btnPrimary, btnDanger, Field, FormSection, Modal,
} from '@/features/maintenance/maintenanceUi'

// ── Invoice Modal (create + edit) ────────────────────────────────────────────────

type InvoiceData = Omit<MaintenanceInvoice, 'id' | 'createdAt' | 'updatedAt'>

function InvoiceModal({ invoice, equipment, onSave, onDelete, onClose }: {
  invoice: MaintenanceInvoice | null
  equipment: Equipment[]
  onSave: (data: InvoiceData) => void
  onDelete?: () => void
  onClose: () => void
}) {
  const isEdit = invoice !== null
  const [form, setForm] = useState({
    equipmentId: invoice?.equipmentId ?? (equipment[0]?.id ?? ''),
    date: invoice?.date ?? '',
    vendor: invoice?.vendor ?? '',
    description: invoice?.description ?? '',
    amount: invoice != null ? (invoice.amount / 100).toString() : '',
    invoiceNumber: invoice?.invoiceNumber ?? '',
    paymentMethod: invoice?.paymentMethod ?? '',
    paymentDate: invoice?.paymentDate ?? '',
    assignee: invoice?.assignee ?? '',
  })
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.equipmentId) return
    onSave({
      equipmentId: form.equipmentId,
      date: form.date || undefined,
      vendor: form.vendor.trim() || undefined,
      description: form.description.trim() || undefined,
      amount: Math.round(parseFloat(form.amount || '0') * 100),
      invoiceNumber: form.invoiceNumber.trim() || undefined,
      paymentMethod: form.paymentMethod || undefined,
      paymentDate: form.paymentDate || undefined,
      assignee: form.assignee || undefined,
    })
    onClose()
  }

  return (
    <Modal
      title={isEdit ? 'Edit Invoice' : 'New Invoice'}
      onClose={onClose}
      footer={
        <>
          {isEdit && onDelete ? (
            <button type="button" onClick={() => { onDelete(); onClose() }} style={btnDanger}><Trash2 size={14} /> Delete</button>
          ) : <span />}
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" onClick={onClose} style={btnGhost}>Cancel</button>
            <button type="submit" form="invoice-form" style={btnPrimary}>{isEdit ? 'Save Changes' : <><Plus size={14} /> Create Invoice</>}</button>
          </div>
        </>
      }
    >
      <form id="invoice-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <FormSection title="Invoice Details">
          <Field label="Equipment" required>
            <select style={{ ...inputStyle, opacity: isEdit ? 0.6 : 1 }} value={form.equipmentId} onChange={(e) => set('equipmentId', e.target.value)} disabled={isEdit} required>
              <option value="" disabled>Select equipment…</option>
              {equipment.map((eq) => (
                <option key={eq.id} value={eq.id}>#{eq.unitNumber}{eq.nickname ? ` · ${eq.nickname}` : ''}</option>
              ))}
            </select>
          </Field>
          <Field label="Vendor">
            <input style={inputStyle} value={form.vendor} onChange={(e) => set('vendor', e.target.value)} placeholder="Shop / vendor name" />
          </Field>
          <Field label="Description">
            <textarea rows={2} style={{ ...inputStyle, resize: 'vertical', minHeight: 60, lineHeight: 1.5 }} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="What was done" />
          </Field>
        </FormSection>

        <FormSection title="Payment">
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
            <Field label="Date">
              <input type="date" style={inputStyle} value={form.date} onChange={(e) => set('date', e.target.value)} />
            </Field>
            <Field label="Amount ($)" required>
              <input type="number" step="0.01" min="0" style={inputStyle} value={form.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0.00" required />
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
            <Field label="Invoice #">
              <input style={inputStyle} value={form.invoiceNumber} onChange={(e) => set('invoiceNumber', e.target.value)} />
            </Field>
            <Field label="Payment Method">
              <input style={inputStyle} value={form.paymentMethod} onChange={(e) => set('paymentMethod', e.target.value)} placeholder="Card / check / cash" />
            </Field>
          </div>
          <Field label="Payment Date">
            <input type="date" style={inputStyle} value={form.paymentDate} onChange={(e) => set('paymentDate', e.target.value)} />
          </Field>
        </FormSection>
      </form>
    </Modal>
  )
}

// ── Multi-select equipment scope (all / some / exclude) ─────────────────────────

const linkBtnStyle: React.CSSProperties = { background: 'none', border: 'none', padding: 0, color: 'var(--ds-blue)', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }

function EquipMultiSelect({ equipment, included, onChange }: {
  equipment: Equipment[]
  included: Set<string> | null
  onChange: (v: Set<string> | null) => void
}) {
  const [open, setOpen] = useState(false)
  const allIds = equipment.map((e) => e.id)
  const total = allIds.length
  const isChecked = (id: string) => included === null || included.has(id)
  const selectedCount = included === null ? total : included.size

  const toggle = (id: string) => {
    const base = included === null ? new Set(allIds) : new Set(included)
    if (base.has(id)) base.delete(id)
    else base.add(id)
    onChange(base.size === total ? null : base)
  }

  const excludedCount = total - selectedCount
  const label =
    included === null ? 'All Equipment'
      : selectedCount === 0 ? 'None selected'
        : excludedCount > 0 && excludedCount <= 2 ? `All except ${excludedCount}`
          : `${selectedCount} of ${total}`

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 34, padding: '0 12px', background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 7, fontSize: 12.5, color: 'var(--ds-t1)', fontFamily: 'inherit', cursor: 'pointer', minWidth: 168, justifyContent: 'space-between' }}
      >
        <span>{label}</span>
        <ChevronDown size={14} style={{ color: 'var(--ds-t3)' }} />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 41, width: 264, maxHeight: 340, background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 10, boxShadow: 'var(--sh-lg)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--ds-border)' }}>
              <button type="button" onClick={() => onChange(null)} style={linkBtnStyle}>Select all</button>
              <button type="button" onClick={() => onChange(new Set())} style={{ ...linkBtnStyle, color: 'var(--ds-t3)' }}>Clear</button>
              <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--ds-t3)' }}>{selectedCount}/{total}</span>
            </div>
            <div style={{ overflowY: 'auto', padding: '4px 0' }}>
              {equipment.length === 0 ? (
                <div style={{ padding: '12px 14px', fontSize: 12.5, color: 'var(--ds-t3)' }}>No equipment.</div>
              ) : equipment.map((e) => (
                <label key={e.id} className="maint-row" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 14px', cursor: 'pointer', fontSize: 13 }}>
                  <input type="checkbox" checked={isChecked(e.id)} onChange={() => toggle(e.id)} style={{ width: 15, height: 15, accentColor: 'var(--ds-blue)', cursor: 'pointer', flexShrink: 0 }} />
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--ds-t1)' }}>#{e.unitNumber}</span>
                  {e.nickname && <span style={{ color: 'var(--ds-t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.nickname}</span>}
                </label>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────────

type Tab = 'invoices' | 'history'
type InvSortKey = 'date' | 'equipment' | 'source' | 'vendor' | 'invoiceNumber' | 'amount'

export function InvoicesPage() {
  const isMobile = useIsMobile()
  const padX = isMobile ? 14 : 32
  const equipment                = useAppStore((s) => s.equipment)
  const maintenanceInvoices      = useAppStore((s) => s.maintenanceInvoices)
  const maintenanceTasks         = useAppStore((s) => s.maintenanceTasks)
  const addMaintenanceInvoice    = useAppStore((s) => s.addMaintenanceInvoice)
  const updateMaintenanceInvoice = useAppStore((s) => s.updateMaintenanceInvoice)
  const deleteMaintenanceInvoice = useAppStore((s) => s.deleteMaintenanceInvoice)

  const [tab, setTab]                 = useState<Tab>('invoices')
  // Multi-select equipment scope: null = all; otherwise the set of INCLUDED equipment ids.
  const [includedEquip, setIncludedEquip] = useState<Set<string> | null>(null)
  const matchesEquip = (id: string) => includedEquip === null || includedEquip.has(id)
  const [search, setSearch]           = useState('')
  const [newOpen, setNewOpen]         = useState(false)
  const [editInvoice, setEditInvoice] = useState<MaintenanceInvoice | null>(null)
  const [sortKey, setSortKey]         = useState<InvSortKey>('date')
  const [sortDir, setSortDir]         = useState<'asc' | 'desc'>('desc')

  function toggleSort(k: InvSortKey) {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(k === 'amount' || k === 'date' ? 'desc' : 'asc') }
  }
  // Sortable header cell (plain render fn so it doesn't remount).
  const invTh = (label: string, k: InvSortKey, align?: 'right') => {
    const active = sortKey === k
    return (
      <th key={k} style={{ ...thBase, textAlign: align ?? 'left', cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort(k)}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: active ? 'var(--ds-t1)' : undefined }}>
          {label}
          {active && (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
        </span>
      </th>
    )
  }

  function equipName(id: string) {
    const e = equipment.find((eq) => eq.id === id)
    return e ? `#${e.unitNumber}${e.nickname ? ` · ${e.nickname}` : ''}` : id
  }
  function equipUnit(id: string) {
    const e = equipment.find((eq) => eq.id === id)
    return e ? `#${e.unitNumber}` : id
  }

  const filtered = maintenanceInvoices.filter((inv) => {
    if (!matchesEquip(inv.equipmentId)) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        (inv.vendor ?? '').toLowerCase().includes(q) ||
        (inv.description ?? '').toLowerCase().includes(q) ||
        (inv.invoiceNumber ?? '').toLowerCase().includes(q) ||
        equipName(inv.equipmentId).toLowerCase().includes(q)
      )
    }
    return true
  }).sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1
    let cmp = 0
    switch (sortKey) {
      case 'date':          cmp = (a.date ?? '').localeCompare(b.date ?? ''); break
      case 'equipment':     cmp = equipUnit(a.equipmentId).localeCompare(equipUnit(b.equipmentId), undefined, { numeric: true }); break
      case 'source':        cmp = (a.source ?? '').localeCompare(b.source ?? ''); break
      case 'vendor':        cmp = (a.vendor ?? '').localeCompare(b.vendor ?? ''); break
      case 'invoiceNumber': cmp = (a.invoiceNumber ?? '').localeCompare(b.invoiceNumber ?? '', undefined, { numeric: true }); break
      case 'amount':        cmp = a.amount - b.amount; break
    }
    return cmp * dir
  })

  // Maintenance history — completed tasks + repair invoices, newest first.
  const history = useMemo(() => {
    type Row = { id: string; date: string; equipmentId: string; kind: 'task' | 'invoice'; title: string; detail?: string; amount?: number }
    const rows: Row[] = []
    for (const t of maintenanceTasks) {
      if (t.status !== 'complete') continue
      rows.push({ id: `t-${t.id}`, date: t.dueDate || t.updatedAt.slice(0, 10), equipmentId: t.equipmentId, kind: 'task', title: t.title, detail: t.notes })
    }
    for (const inv of maintenanceInvoices) {
      rows.push({ id: `i-${inv.id}`, date: inv.date || inv.createdAt.slice(0, 10), equipmentId: inv.equipmentId, kind: 'invoice', title: inv.vendor || 'Repair', detail: inv.description, amount: inv.amount })
    }
    return rows
      .filter((r) => {
        if (!matchesEquip(r.equipmentId)) return false
        if (search) {
          const q = search.toLowerCase()
          return r.title.toLowerCase().includes(q) || (r.detail ?? '').toLowerCase().includes(q) || equipName(r.equipmentId).toLowerCase().includes(q)
        }
        return true
      })
      .sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maintenanceTasks, maintenanceInvoices, includedEquip, search, equipment])

  const monthStart = useMemo(() => {
    const n = new Date()
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-01`
  }, [])

  // KPIs are scoped to the equipment picked in the top toggle ("All Equipment" = everything).
  const kpiInvoices  = includedEquip === null ? maintenanceInvoices : maintenanceInvoices.filter((i) => matchesEquip(i.equipmentId))
  const totalSpend   = kpiInvoices.reduce((s, i) => s + i.amount, 0)
  const monthSpend   = kpiInvoices.filter((i) => (i.date ?? '') >= monthStart).reduce((s, i) => s + i.amount, 0)
  const invoiceCount = kpiInvoices.length
  const avgInvoice   = invoiceCount > 0 ? Math.round(totalSpend / invoiceCount) : 0

  const KPIS = [
    { label: 'Total Spend',  value: formatCents(totalSpend), color: '#a78bfa' },
    { label: 'This Month',   value: formatCents(monthSpend), color: '#1ea8f3' },
    { label: 'Invoices',     value: String(invoiceCount),    color: '#22c55e' },
    { label: 'Avg / Invoice', value: formatCents(avgInvoice), color: '#f59e0b' },
  ]


  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>

      {/* Page header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', padding: `${isMobile ? 16 : 20}px ${padX}px 12px` }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>Invoices</h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>Repair invoices &amp; service history · from repairs@bcatcorp.com</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 8, fontSize: 13, fontWeight: 500, color: 'var(--ds-t2)', cursor: 'pointer', fontFamily: 'inherit' }}>
              Export
            </button>
            {tab === 'invoices' && (
              <button
                onClick={() => setNewOpen(true)}
                disabled={equipment.length === 0}
                title={equipment.length === 0 ? 'Add equipment in Fleet first' : undefined}
                style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', background: 'var(--ds-blue)', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, color: '#fff', cursor: equipment.length === 0 ? 'not-allowed' : 'pointer', opacity: equipment.length === 0 ? 0.5 : 1, fontFamily: 'inherit' }}
              >
                <Plus size={14} /> New Invoice
              </button>
            )}
          </div>
        </div>

        {/* Equipment scope for the totals below — multi-select (all / some / exclude) */}
        <div style={{ padding: `0 ${padX}px 10px`, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Totals for</span>
          <EquipMultiSelect equipment={equipment} included={includedEquip} onChange={setIncludedEquip} />
        </div>

        {/* KPI strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: isMobile ? 10 : 12, padding: `0 ${padX}px 12px` }}>
          {KPIS.map((k) => (
            <div key={k.label} style={{ position: 'relative', overflow: 'hidden', background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 10, padding: '12px 16px' }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: k.color }} />
              <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--ds-t3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginLeft: 4 }}>{k.label}</div>
              <div style={{ fontSize: 28, fontWeight: 600, color: k.color, letterSpacing: '-0.02em', marginTop: 4, marginLeft: 4, fontVariantNumeric: 'tabular-nums' }}>{k.value}</div>
            </div>
          ))}
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', padding: `0 ${padX}px`, gap: 0, overflowX: 'auto' }}>
          {[{ key: 'invoices' as const, label: 'Invoices', Icon: Receipt }, { key: 'history' as const, label: 'Maintenance History', Icon: History }].map(({ key, label, Icon }) => {
            const active = tab === key
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '10px 16px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                  background: 'none', border: 'none', fontFamily: 'inherit',
                  borderBottom: `2px solid ${active ? 'var(--ds-blue)' : 'transparent'}`,
                  color: active ? 'var(--ds-blue)' : 'var(--ds-t3)',
                  marginBottom: -1,
                }}
              >
                <Icon size={13} />{label}
              </button>
            )
          })}
        </div>
      </div>

      <div style={{ padding: isMobile ? '16px 12px' : '24px 32px', maxWidth: 1200 }}>
        {/* Filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)', pointerEvents: 'none' }} />
            <input
              type="text"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                width: 220, height: 34, paddingLeft: 30, paddingRight: 10, boxSizing: 'border-box',
                background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 7,
                fontSize: 12.5, color: 'var(--ds-t1)', fontFamily: 'inherit', outline: 'none',
              }}
            />
          </div>
        </div>

        {tab === 'invoices' && (
        <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
              <FileText className="size-8 opacity-20" />
              <p className="text-sm">No invoices found.</p>
              <p className="text-xs text-slate-400">Invoices arrive automatically from repairs@bcatcorp.com, or add one manually.</p>
            </div>
          ) : (
            <div style={{ maxHeight: 'calc(100vh - 340px)', overflowY: 'auto', overflowX: 'auto' }}>
              <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', minWidth: 1000 }}>
                <colgroup>
                  <col style={{ width: 100 }} />
                  <col style={{ width: 108 }} />
                  <col style={{ width: 92 }} />
                  <col style={{ width: 150 }} />
                  <col />
                  <col style={{ width: 104 }} />
                  <col style={{ width: 128 }} />
                  <col style={{ width: 112 }} />
                  <col style={{ width: 70 }} />
                </colgroup>
                <thead>
                  <tr>
                    {invTh('Date', 'date')}
                    {invTh('Equipment', 'equipment')}
                    {invTh('Source', 'source')}
                    {invTh('Vendor', 'vendor')}
                    <th style={{ ...thBase }}>Description</th>
                    {invTh('Invoice #', 'invoiceNumber')}
                    <th style={{ ...thBase }}>Payment</th>
                    {invTh('Amount', 'amount', 'right')}
                    <th style={{ ...thBase, textAlign: 'right' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((inv) => (
                    <tr key={inv.id} className="maint-row">
                      <td style={{ ...tdBase, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--ds-t2)', whiteSpace: 'nowrap' }}>{inv.date || '—'}</td>
                      <td style={tdBase}><span style={equipChipStyle}>{equipUnit(inv.equipmentId)}</span></td>
                      <td style={tdBase}>
                        {inv.source === 'MANUAL'
                          ? <Pill tone="neutral">Manual</Pill>
                          : inv.source === 'EMAIL'
                            ? <Pill tone="blue">Email</Pill>
                            : <span style={{ color: 'var(--ds-muted-soft)', fontSize: 12.5 }}>—</span>}
                      </td>
                      <td style={tdBase}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inv.vendor || 'Unknown vendor'}</div>
                      </td>
                      <td style={{ ...tdBase, fontSize: 12.5, color: 'var(--ds-t3)', lineHeight: 1.45 }}>
                        {inv.description ? inv.description : <span style={{ color: 'var(--ds-muted-soft)' }}>—</span>}
                      </td>
                      <td style={{ ...tdBase, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ds-t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inv.invoiceNumber || '—'}</td>
                      <td style={{ ...tdBase, fontSize: 12.5, color: 'var(--ds-t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {inv.paymentMethod ? <span style={{ textTransform: 'capitalize' }}>{inv.paymentMethod}</span> : '—'}
                        {inv.paymentDate && <span style={{ color: 'var(--ds-muted-soft)', marginLeft: 5, fontSize: 11 }}>{inv.paymentDate}</span>}
                      </td>
                      <td style={{ ...tdBase, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600, whiteSpace: 'nowrap' }}>{formatCents(inv.amount)}</td>
                      <td style={{ ...tdBase, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button aria-label="Edit invoice" onClick={() => setEditInvoice(inv)} style={{ ...iconBtnStyle, color: 'var(--ds-t3)' }}><Pencil size={13} /></button>
                        <button aria-label="Delete invoice" onClick={() => { deleteMaintenanceInvoice(inv.id); toast.success('Invoice deleted') }} style={{ ...iconBtnStyle, color: 'var(--ds-red)' }}><Trash2 size={13} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={7} style={{ padding: '13px 14px', background: 'var(--ds-bg-2)', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.08em', borderTop: '1px solid var(--ds-border)' }}>Total</td>
                    <td style={{ padding: '13px 14px', background: 'var(--ds-bg-2)', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--ds-t1)', borderTop: '1px solid var(--ds-border)', whiteSpace: 'nowrap' }}>
                      {formatCents(filtered.reduce((s, i) => s + i.amount, 0))}
                    </td>
                    <td style={{ background: 'var(--ds-bg-2)', borderTop: '1px solid var(--ds-border)' }} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
        )}

        {tab === 'history' && (
        <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
          {history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
              <History className="size-8 opacity-20" />
              <p className="text-sm">No service history yet.</p>
              <p className="text-xs text-slate-400">Completed tasks and repair invoices appear here per truck.</p>
            </div>
          ) : (
            <div style={{ maxHeight: 'calc(100vh - 340px)', overflowY: 'auto', overflowX: 'auto' }}>
              <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', minWidth: 640 }}>
                <colgroup>
                  <col style={{ width: 116 }} />
                  <col style={{ width: 116 }} />
                  <col style={{ width: 104 }} />
                  <col />
                  <col style={{ width: 120 }} />
                </colgroup>
                <thead>
                  <tr>
                    {['Date', 'Equipment', 'Type', 'What was done', 'Cost'].map((h, i) => (
                      <th key={i} style={{ ...thBase, textAlign: i === 4 ? 'right' : 'left' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {history.map((r) => (
                    <tr key={r.id} className="maint-row">
                      <td style={{ ...tdBase, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--ds-t2)', whiteSpace: 'nowrap' }}>{r.date || '—'}</td>
                      <td style={tdBase}><span style={equipChipStyle}>{equipUnit(r.equipmentId)}</span></td>
                      <td style={tdBase}>{r.kind === 'invoice' ? <Pill tone="violet">Repair</Pill> : <Pill tone="blue">Task</Pill>}</td>
                      <td style={tdBase}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
                        {r.detail && <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.detail}</div>}
                      </td>
                      <td style={{ ...tdBase, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600, color: r.amount != null ? 'var(--ds-t1)' : 'var(--ds-muted-soft)', whiteSpace: 'nowrap' }}>
                        {r.amount != null ? formatCents(r.amount) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        )}
      </div>

      {newOpen && (
        <InvoiceModal
          invoice={null}
          equipment={equipment}
          onSave={(data) => { addMaintenanceInvoice({ ...data, source: 'MANUAL' }); toast.success('Invoice created') }}
          onClose={() => setNewOpen(false)}
        />
      )}
      {editInvoice && (
        <InvoiceModal
          invoice={editInvoice}
          equipment={equipment}
          onSave={(data) => { updateMaintenanceInvoice(editInvoice.id, data); toast.success('Invoice updated') }}
          onDelete={() => { deleteMaintenanceInvoice(editInvoice.id); toast.success('Invoice deleted') }}
          onClose={() => setEditInvoice(null)}
        />
      )}
    </div>
  )
}
