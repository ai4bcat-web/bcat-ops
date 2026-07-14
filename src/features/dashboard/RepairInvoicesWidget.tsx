import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Wrench, ChevronRight } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100)
}

function money2(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)
}

function shortDate(d?: string): string {
  if (!d) return '—'
  const dt = new Date(`${d}T12:00:00`)
  if (isNaN(dt.getTime())) return d
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Start of the current calendar month, as YYYY-MM-DD.
function monthStart(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-01`
}

/**
 * Recent repair invoices ingested from the repairs@bcatcorp.com pipeline (and any
 * added manually in Maintenance). Shows this-month spend plus the latest few.
 */
export function RepairInvoicesWidget() {
  const navigate = useNavigate()
  const invoices = useAppStore((s) => s.maintenanceInvoices)
  const equipment = useAppStore((s) => s.equipment)

  const unitOf = useMemo(() => {
    const m = new Map(equipment.map((e) => [e.id, e]))
    return (id: string) => {
      const e = m.get(id)
      return e ? `#${e.unitNumber}${e.nickname ? ` · ${e.nickname}` : ''}` : '—'
    }
  }, [equipment])

  const sorted = useMemo(
    () => [...invoices].sort((a, b) => (b.date ?? b.createdAt).localeCompare(a.date ?? a.createdAt)),
    [invoices],
  )
  const recent = sorted.slice(0, 5)

  const ms = monthStart()
  const monthSpend = useMemo(
    () => invoices.filter((i) => (i.date ?? '') >= ms).reduce((s, i) => s + i.amount, 0),
    [invoices, ms],
  )
  const monthCount = useMemo(
    () => invoices.filter((i) => (i.date ?? '') >= ms).length,
    [invoices, ms],
  )

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', padding: '20px 20px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Wrench size={16} style={{ color: 'var(--ds-t3)' }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Recent Repair Invoices</div>
        </div>
        <button onClick={() => navigate('/maintenance')} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ds-blue)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
          View all <ChevronRight size={12} />
        </button>
      </div>

      {/* This-month summary */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 8, padding: '10px 14px' }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>{money(monthSpend)}</span>
        <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>this month · {monthCount} {monthCount === 1 ? 'invoice' : 'invoices'}</span>
      </div>

      {/* Latest invoices */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {recent.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--ds-t3)', padding: '8px 0' }}>No repair invoices yet.</div>
        ) : recent.map((inv) => (
          <button
            key={inv.id}
            onClick={() => navigate('/maintenance')}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--ds-border)', background: 'none', border: 'none', borderBottomStyle: 'solid', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', width: '100%' }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {inv.vendor || 'Unknown vendor'}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {unitOf(inv.equipmentId)} · {shortDate(inv.date)}{inv.invoiceNumber ? ` · #${inv.invoiceNumber}` : ''}
              </div>
            </div>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{money2(inv.amount)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
