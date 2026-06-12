import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShieldAlert, ChevronRight } from 'lucide-react'
import { useComplianceAlerts } from '@/hooks/useComplianceAlerts'
import { SeverityBadge, daysRemainingLabel } from '@/features/compliance/components'
import type { AlertSeverity } from '@/types'

const SEVERITY_ORDER: Record<AlertSeverity, number> = { EXPIRED: 0, CRITICAL: 1, URGENT: 2, UPCOMING: 3 }

export function ComplianceAlertsWidget() {
  const navigate = useNavigate()
  const { openAlerts, loading } = useComplianceAlerts()

  const counts = useMemo(() => ({
    EXPIRED: openAlerts.filter((a) => a.severity === 'EXPIRED').length,
    CRITICAL: openAlerts.filter((a) => a.severity === 'CRITICAL').length,
    URGENT: openAlerts.filter((a) => a.severity === 'URGENT').length,
    UPCOMING: openAlerts.filter((a) => a.severity === 'UPCOMING').length,
  }), [openAlerts])

  const top5 = useMemo(
    () => [...openAlerts]
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.expirationDate ?? '').localeCompare(b.expirationDate ?? ''))
      .slice(0, 5),
    [openAlerts],
  )

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', padding: '20px 20px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShieldAlert size={16} style={{ color: counts.EXPIRED + counts.CRITICAL > 0 ? '#dc2626' : 'var(--ds-t3)' }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Compliance Alerts</div>
        </div>
        <button onClick={() => navigate('/compliance')} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ds-blue)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
          View all <ChevronRight size={12} />
        </button>
      </div>

      {/* Counts */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {([['EXPIRED', '#dc2626'], ['CRITICAL', '#dc2626'], ['URGENT', '#f59e0b'], ['UPCOMING', '#1ea8f3']] as [AlertSeverity, string][]).map(([sev, color]) => (
          <div key={sev} style={{ textAlign: 'center', background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 8, padding: '8px 4px' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>{counts[sev]}</div>
            <div style={{ fontSize: 10, color: 'var(--ds-t3)', textTransform: 'capitalize' }}>{sev.toLowerCase()}</div>
          </div>
        ))}
      </div>

      {/* Top 5 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {loading ? (
          <div style={{ fontSize: 12.5, color: 'var(--ds-t3)', padding: '8px 0' }}>Loading…</div>
        ) : top5.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--ds-t3)', padding: '8px 0' }}>No open alerts. ✅</div>
        ) : top5.map((a) => (
          <button key={a.id} onClick={() => navigate(a.entityType === 'DRIVER' ? `/compliance/driver/${a.entityId}` : `/compliance/truck/${a.entityId}`)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--ds-border)', background: 'none', border: 'none', borderBottomStyle: 'solid', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', width: '100%' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.entityName ?? a.entityId}</div>
              <div style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>{a.documentTitle ?? a.documentType} · {daysRemainingLabel(a.expirationDate)}</div>
            </div>
            <SeverityBadge severity={a.severity} />
          </button>
        ))}
      </div>
    </div>
  )
}
