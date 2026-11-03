import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShieldAlert, ChevronRight } from 'lucide-react'
import { useComplianceAlerts } from '@/hooks/useComplianceAlerts'
import { SeverityBadge } from '@/features/compliance/components'
import { daysRemainingLabel } from '@/lib/compliance-labels'
import { useAuth } from '@/hooks/useAuth'
import type { AlertSeverity } from '@/types'

const SEVERITY_ORDER: Record<AlertSeverity, number> = { EXPIRED: 0, CRITICAL: 1, URGENT: 2, UPCOMING: 3 }

export function ComplianceAlertsWidget() {
  const navigate = useNavigate()
  const { hasPageAccess } = useAuth()
  const { openAlerts, loading } = useComplianceAlerts()
  const canFiles = hasPageAccess('files')

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
    <div className="tms-card" style={{ padding: '20px 20px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShieldAlert size={16} style={{ color: counts.EXPIRED + counts.CRITICAL > 0 ? 'var(--tms-badge-red)' : 'var(--tms-muted)' }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>Compliance Alerts</div>
        </div>
        {canFiles && (
          <button onClick={() => navigate('/compliance')} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--tms-primary)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
            View all <ChevronRight size={12} />
          </button>
        )}
      </div>

      {/* Counts */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {([['EXPIRED', 'var(--tms-badge-red)'], ['CRITICAL', 'var(--tms-badge-red)'], ['URGENT', 'var(--tms-badge-orange)'], ['UPCOMING', 'var(--tms-badge-blue)']] as [AlertSeverity, string][]).map(([sev, color]) => (
          <div key={sev} style={{ textAlign: 'center', background: 'var(--tms-bg)', border: '1px solid var(--tms-border)', borderRadius: 8, padding: '8px 4px' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>{counts[sev]}</div>
            <div style={{ fontSize: 10, color: 'var(--tms-muted)', textTransform: 'capitalize' }}>{sev.toLowerCase()}</div>
          </div>
        ))}
      </div>

      {/* Top 5 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {loading ? (
          <div style={{ fontSize: 12.5, color: 'var(--tms-muted)', padding: '8px 0' }}>Loading…</div>
        ) : top5.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--tms-muted)', padding: '8px 0' }}>No open alerts. ✅</div>
        ) : top5.map((a) => {
          const body = (
            <>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--tms-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.entityName ?? a.entityId}</div>
                <div style={{ fontSize: 11.5, color: 'var(--tms-muted)' }}>{a.documentTitle ?? a.documentType} · {daysRemainingLabel(a.expirationDate)}</div>
              </div>
              <SeverityBadge severity={a.severity} />
            </>
          )
          return canFiles ? (
            <button key={a.id} onClick={() => navigate(a.entityType === 'DRIVER' ? `/compliance/driver/${a.entityId}` : `/compliance/truck/${a.entityId}`)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--tms-border)', background: 'none', border: 'none', borderBottomStyle: 'solid', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', width: '100%' }}>
              {body}
            </button>
          ) : (
            <div key={a.id}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--tms-border)' }}>
              {body}
            </div>
          )
        })}
      </div>
    </div>
  )
}
