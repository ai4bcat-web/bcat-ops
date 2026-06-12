import { useMemo, useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ExternalLink, Mail } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody } from '@/components/ui/sheet'
import { useComplianceAlerts } from '@/hooks/useComplianceAlerts'
import { listEscalationEmailLogsByAlert } from '@/lib/complianceClient'
import { SeverityBadge, daysRemainingLabel, Card } from './components'
import { EmailSettingsCard } from './EmailSettingsCard'
import { EscalationRulesCard } from './EscalationRulesCard'
import type { AlertSeverity, ComplianceAlert, ComplianceEntityType, EscalationEmailLog } from '@/types'

const SEVERITY_ORDER: Record<AlertSeverity, number> = { EXPIRED: 0, CRITICAL: 1, URGENT: 2, UPCOMING: 3 }

export function CompliancePage() {
  const navigate = useNavigate()
  const { alerts, loading, acknowledge } = useComplianceAlerts()
  const [severity, setSeverity] = useState<AlertSeverity | 'ALL'>('ALL')
  const [entityType, setEntityType] = useState<ComplianceEntityType | 'ALL'>('ALL')
  const [showAcked, setShowAcked] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [historyAlert, setHistoryAlert] = useState<ComplianceAlert | null>(null)

  const visible = useMemo(() => {
    return alerts
      .filter((a) => !a.resolvedAt)
      .filter((a) => (showAcked ? true : !a.acknowledged))
      .filter((a) => (severity === 'ALL' ? true : a.severity === severity))
      .filter((a) => (entityType === 'ALL' ? true : a.entityType === entityType))
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.expirationDate ?? '').localeCompare(b.expirationDate ?? ''))
  }, [alerts, severity, entityType, showAcked])

  const counts = useMemo(() => {
    const open = alerts.filter((a) => !a.acknowledged && !a.resolvedAt)
    return {
      EXPIRED: open.filter((a) => a.severity === 'EXPIRED').length,
      CRITICAL: open.filter((a) => a.severity === 'CRITICAL').length,
      URGENT: open.filter((a) => a.severity === 'URGENT').length,
      UPCOMING: open.filter((a) => a.severity === 'UPCOMING').length,
    }
  }, [alerts])

  async function ack(a: ComplianceAlert) {
    setBusyId(a.id)
    try { await acknowledge(a.id); toast.success('Acknowledged') }
    catch (e) { console.error(e); toast.error('Failed') }
    finally { setBusyId(null) }
  }

  function goToEntity(a: ComplianceAlert) {
    navigate(a.entityType === 'DRIVER' ? `/compliance/driver/${a.entityId}` : `/compliance/truck/${a.entityId}`)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--ds-t1)', margin: 0 }}>Compliance alerts</h1>
          <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>Expiring and expired DOT documents across drivers and trucks.</p>
        </div>

        {/* Counts */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {([['EXPIRED', '#dc2626'], ['CRITICAL', '#dc2626'], ['URGENT', '#f59e0b'], ['UPCOMING', '#1ea8f3']] as [AlertSeverity, string][]).map(([sev, color]) => (
            <button key={sev} onClick={() => setSeverity(severity === sev ? 'ALL' : sev)}
              style={{ textAlign: 'left', background: 'var(--ds-surface)', border: `1px solid ${severity === sev ? color : 'var(--ds-border)'}`, borderRadius: 12, padding: '14px 16px', cursor: 'pointer' }}>
              <div style={{ fontSize: 26, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>{counts[sev]}</div>
              <div style={{ fontSize: 12, color: 'var(--ds-t3)', textTransform: 'capitalize' }}>{sev.toLowerCase()}</div>
            </button>
          ))}
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <select value={entityType} onChange={(e) => setEntityType(e.target.value as ComplianceEntityType | 'ALL')}
            className="h-9 rounded-md border border-input bg-white px-3 text-sm">
            <option value="ALL">All entities</option>
            <option value="DRIVER">Drivers</option>
            <option value="TRUCK">Trucks</option>
          </select>
          <select value={severity} onChange={(e) => setSeverity(e.target.value as AlertSeverity | 'ALL')}
            className="h-9 rounded-md border border-input bg-white px-3 text-sm">
            <option value="ALL">All severities</option>
            <option value="EXPIRED">Expired</option>
            <option value="CRITICAL">Critical</option>
            <option value="URGENT">Urgent</option>
            <option value="UPCOMING">Upcoming</option>
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--ds-t2)' }}>
            <input type="checkbox" checked={showAcked} onChange={(e) => setShowAcked(e.target.checked)} />
            Show acknowledged
          </label>
        </div>

        <Card title="Alerts" sub={loading ? 'Loading…' : `${visible.length} shown`} noPad>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
                  {['Entity', 'Document', 'Severity', 'Expiration', ''].map((h, i) => (
                    <th key={h} style={{ padding: '8px 16px', textAlign: i === 4 ? 'right' : 'left', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!loading && visible.length === 0 && (
                  <tr><td colSpan={5} style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--ds-t3)' }}>No alerts. All clear. ✅</td></tr>
                )}
                {visible.map((a) => (
                  <tr key={a.id} style={{ borderBottom: '1px solid var(--ds-border)', opacity: a.acknowledged ? 0.6 : 1 }}>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{ fontWeight: 500, color: 'var(--ds-t1)' }}>{a.entityName ?? a.entityId}</span>
                      <Badge variant="secondary" className="ml-2">{a.entityType === 'DRIVER' ? 'Driver' : 'Truck'}</Badge>
                    </td>
                    <td style={{ padding: '10px 16px', color: 'var(--ds-t2)' }}>{a.documentTitle ?? a.documentType}</td>
                    <td style={{ padding: '10px 16px' }}><SeverityBadge severity={a.severity} /></td>
                    <td style={{ padding: '10px 16px', color: 'var(--ds-t2)' }}>
                      {a.expirationDate ?? '—'}<span style={{ marginLeft: 6, fontSize: 11.5, color: 'var(--ds-t3)' }}>({daysRemainingLabel(a.expirationDate)})</span>
                    </td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <Button size="sm" variant="ghost" onClick={() => setHistoryAlert(a)} title="Email history"><Mail size={14} /></Button>
                      <Button size="sm" variant="ghost" onClick={() => goToEntity(a)}><ExternalLink size={14} /> Open</Button>
                      {!a.acknowledged && <Button size="sm" variant="outline" disabled={busyId === a.id} onClick={() => ack(a)}><Check size={14} /> Acknowledge</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <EscalationRulesCard />
        <EmailSettingsCard />
      </div>

      <AlertEmailHistorySheet alert={historyAlert} onClose={() => setHistoryAlert(null)} />
    </div>
  )
}

function AlertEmailHistorySheet({ alert, onClose }: { alert: ComplianceAlert | null; onClose: () => void }) {
  const [logs, setLogs] = useState<EscalationEmailLog[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!alert) return
    setLoading(true)
    listEscalationEmailLogsByAlert(alert.id)
      .then(setLogs)
      .catch((e) => console.error('[email history]', e))
      .finally(() => setLoading(false))
  }, [alert])

  return (
    <Sheet open={!!alert} onOpenChange={(o) => !o && onClose()}>
      <SheetContent style={{ width: 'min(520px, 92vw)' }}>
        <SheetHeader>
          <SheetTitle>Email history — {alert?.documentTitle ?? alert?.documentType}</SheetTitle>
        </SheetHeader>
        <SheetBody>
          {loading ? (
            <div style={{ color: 'var(--ds-t3)', fontSize: 13 }}>Loading…</div>
          ) : logs.length === 0 ? (
            <div style={{ color: 'var(--ds-t3)', fontSize: 13 }}>No escalation emails sent for this alert yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {logs.map((l) => (
                <div key={l.id} style={{ border: '1px solid var(--ds-border)', borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ds-t1)' }}>
                      {l.daysBeforeExpiration === 0 ? 'Out-of-service notice' : `${l.daysBeforeExpiration}-day notice`}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>{new Date(l.sentAt).toLocaleString()}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--ds-t2)', marginTop: 2 }}>To: {(l.recipients ?? []).join(', ') || '—'}</div>
                  {l.templateKey && <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 2 }}>Template: {l.templateKey}</div>}
                </div>
              ))}
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
