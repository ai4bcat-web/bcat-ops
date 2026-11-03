import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { FileText, ChevronRight } from 'lucide-react'
import { TmsBadge } from '@/features/tms/kit/TmsBadge'
import type { TmsTone } from '@/features/tms/kit/TmsBadge'
import { TmsEmptyState } from '@/features/tms/kit/TmsEmptyState'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { useAllComplianceDocuments } from '@/hooks/useAllComplianceDocuments'
import { TRUCK_DOC_SPECS, evaluateTruckDoc } from '@/lib/truckDocs'

const STATE_META: Record<'EXPIRED' | 'EXPIRING_SOON', { label: string; tone: TmsTone; rank: number }> = {
  EXPIRED:       { label: 'Expired',       tone: 'red', rank: 0 },
  EXPIRING_SOON: { label: 'Expiring soon', tone: 'orange', rank: 1 },
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
  const { hasPageAccess } = useAuth()
  const canTruckDocs = hasPageAccess('truckDocs')
  const equipment = useAppStore((s) => s.equipment)
  // Shared dataset + shared "current document" rule (was its own scan and its own index).
  const { docFor, loading } = useAllComplianceDocuments()

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const t of equipment) {
      if (t.type !== 'truck' || t.active === false) continue
      for (const spec of TRUCK_DOC_SPECS) {
        if (spec.photo) continue   // photos have no expiration to report
        const { state, expiration } = evaluateTruckDoc(t, spec, docFor('TRUCK', t.id, spec.key))
        if (state === 'EXPIRED' || state === 'EXPIRING_SOON') {
          out.push({ truckId: t.id, unit: `#${t.unitNumber}`, docLabel: spec.label, state, expiration })
        }
      }
    }
    return out.sort((a, b) =>
      STATE_META[a.state].rank - STATE_META[b.state].rank ||
      (a.expiration ?? '').localeCompare(b.expiration ?? ''),
    )
  }, [docFor, equipment])

  return (
    <div style={{ background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 12, boxShadow: 'var(--tms-shadow)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--tms-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FileText size={16} style={{ color: 'var(--tms-muted)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>Expiring Truck Documents</div>
            <div style={{ fontSize: 12, color: 'var(--tms-muted)', marginTop: 1 }}>
              {loading ? 'Loading…' : rows.length === 0 ? 'All current' : `${rows.length} need${rows.length === 1 ? 's' : ''} attention`}
            </div>
          </div>
        </div>
        {canTruckDocs && (
          <Link to="/truck-docs" style={{ fontSize: 12, color: 'var(--tms-primary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
            View all <ChevronRight size={13} />
          </Link>
        )}
      </div>

      {rows.length === 0 ? (
        <TmsEmptyState compact title={loading ? 'Loading…' : 'No truck documents expiring'} message={null} />
      ) : (
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {rows.map((r, i) => {
            const meta = STATE_META[r.state]
            const body = (
              <>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--tms-text)' }}>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{r.unit}</span> · {r.docLabel}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--tms-muted)', marginTop: 1 }}>
                    {r.state === 'EXPIRED' ? 'Expired' : 'Due'} {shortDate(r.expiration)}
                  </div>
                </div>
                <TmsBadge tone={meta.tone} style={{ flexShrink: 0 }}>{meta.label}</TmsBadge>
              </>
            )
            return canTruckDocs ? (
              <Link
                key={`${r.truckId}-${r.docLabel}-${i}`}
                to="/truck-docs"
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', borderBottom: '1px solid var(--tms-border)', textDecoration: 'none' }}
              >
                {body}
              </Link>
            ) : (
              <div
                key={`${r.truckId}-${r.docLabel}-${i}`}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', borderBottom: '1px solid var(--tms-border)' }}
              >
                {body}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
