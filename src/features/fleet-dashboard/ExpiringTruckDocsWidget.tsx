import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { FileText, ChevronRight, CheckCircle2 } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { listAllComplianceDocuments } from '@/lib/complianceClient'
import { TRUCK_DOC_SPECS, evaluateTruckDoc } from '@/lib/truckDocs'
import type { ComplianceDocument } from '@/types'

const STATE_META: Record<'EXPIRED' | 'EXPIRING_SOON', { label: string; bg: string; fg: string; rank: number }> = {
  EXPIRED:       { label: 'Expired',       bg: '#fef2f2', fg: '#b91c1c', rank: 0 },
  EXPIRING_SOON: { label: 'Expiring soon', bg: '#fffbeb', fg: '#b45309', rank: 1 },
}

function shortDate(d?: string | null): string {
  if (!d) return '—'
  const dt = new Date(`${d}T12:00:00`)
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

interface Row {
  truckId: string
  unit: string
  docLabel: string
  state: 'EXPIRED' | 'EXPIRING_SOON'
  expiration: string | null
}

/**
 * Truck documents that are expired or expiring soon (Insurance / IFTA / IRP / DOT),
 * across active trucks. Shares the exact status logic used by the Truck Documents page
 * and the sidebar badge (evaluateTruckDoc). Replaces the general compliance-alerts
 * widget on the Fleet Manager Dashboard.
 */
export function ExpiringTruckDocsWidget() {
  const equipment = useAppStore((s) => s.equipment)
  const [docs, setDocs] = useState<ComplianceDocument[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    listAllComplianceDocuments()
      .then((all) => { if (alive) setDocs(all.filter((d) => d.entityType === 'TRUCK')) })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const rows = useMemo<Row[]>(() => {
    const latest = new Map<string, ComplianceDocument>()
    for (const d of docs) {
      const k = `${d.entityId}::${d.documentType}`
      const cur = latest.get(k)
      if (!cur || d.createdAt > cur.createdAt) latest.set(k, d)
    }
    const out: Row[] = []
    for (const t of equipment) {
      if (t.type !== 'truck' || t.active === false) continue
      for (const spec of TRUCK_DOC_SPECS) {
        const { state, expiration } = evaluateTruckDoc(t, spec, latest.get(`${t.id}::${spec.key}`))
        if (state === 'EXPIRED' || state === 'EXPIRING_SOON') {
          out.push({ truckId: t.id, unit: `#${t.unitNumber}`, docLabel: spec.label, state, expiration })
        }
      }
    }
    return out.sort((a, b) =>
      STATE_META[a.state].rank - STATE_META[b.state].rank ||
      (a.expiration ?? '').localeCompare(b.expiration ?? ''),
    )
  }, [docs, equipment])

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FileText size={16} style={{ color: 'var(--ds-t3)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Expiring Truck Documents</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 1 }}>
              {loading ? 'Loading…' : rows.length === 0 ? 'All current' : `${rows.length} need${rows.length === 1 ? 's' : ''} attention`}
            </div>
          </div>
        </div>
        <Link to="/truck-docs" style={{ fontSize: 12, color: 'var(--ds-blue)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          View all <ChevronRight size={13} />
        </Link>
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <CheckCircle2 size={22} style={{ color: '#15803d', opacity: 0.7 }} />
          {loading ? 'Loading…' : 'No truck documents expiring'}
        </div>
      ) : (
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {rows.map((r, i) => {
            const meta = STATE_META[r.state]
            return (
              <Link
                key={`${r.truckId}-${r.docLabel}-${i}`}
                to="/truck-docs"
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', borderBottom: '1px solid var(--ds-border)', textDecoration: 'none' }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ds-t1)' }}>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{r.unit}</span> · {r.docLabel}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 1 }}>
                    {r.state === 'EXPIRED' ? 'Expired' : 'Due'} {shortDate(r.expiration)}
                  </div>
                </div>
                <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 999, background: meta.bg, color: meta.fg }}>{meta.label}</span>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
