import { useMemo, useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ExternalLink, Mail, CheckCheck, Truck, Container, User } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody } from '@/components/ui/sheet'
import { useComplianceAlerts } from '@/hooks/useComplianceAlerts'
import { useAuth } from '@/hooks/useAuth'
import { useAppStore } from '@/store/useAppStore'
import { listEscalationEmailLogsByAlert } from '@/lib/complianceClient'
import { daysUntil } from '@/lib/complianceStatus'
import { daysRemainingLabel, Card } from './components'
import { EmailSettingsCard } from './EmailSettingsCard'
import { EscalationRulesCard } from './EscalationRulesCard'
import { BackfillOnboardingCard } from './BackfillOnboardingCard'
import type { AlertSeverity, ComplianceAlert, ComplianceEntityType, EscalationEmailLog } from '@/types'
import type { Equipment } from '@/types/equipment'
import type { Driver } from '@/types'

const SEVERITY_ORDER: Record<AlertSeverity, number> = { EXPIRED: 0, CRITICAL: 1, URGENT: 2, UPCOMING: 3 }

// KPI accents (3px left bar) — deep hues for contrast on white.
const KPI: { sev: AlertSeverity; label: string; color: string; soft: string }[] = [
  { sev: 'EXPIRED', label: 'Expired', color: '#b91c1c', soft: 'rgba(185,28,28,0.35)' },
  { sev: 'CRITICAL', label: 'Critical', color: '#b91c1c', soft: 'rgba(185,28,28,0.35)' },
  { sev: 'URGENT', label: 'Urgent', color: '#b45309', soft: 'rgba(180,83,9,0.35)' },
  { sev: 'UPCOMING', label: 'Upcoming', color: '#1ea8f3', soft: 'rgba(30,168,243,0.35)' },
]

const SEV_PILL: Record<AlertSeverity, { bg: string; fg: string; label: string; pulse: boolean }> = {
  EXPIRED: { bg: 'var(--ds-red-bg)', fg: '#b91c1c', label: 'Expired', pulse: true },
  CRITICAL: { bg: 'var(--ds-red-bg)', fg: '#b91c1c', label: 'Critical', pulse: true },
  URGENT: { bg: 'var(--ds-amber-bg)', fg: '#b45309', label: 'Urgent', pulse: false },
  UPCOMING: { bg: 'var(--ds-blue-bg)', fg: '#0369a1', label: 'Upcoming', pulse: false },
}

function SeverityPill({ severity }: { severity: AlertSeverity }) {
  const s = SEV_PILL[severity]
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 600, background: s.bg, color: s.fg, whiteSpace: 'nowrap' }}>
      <span className={s.pulse ? 'dot-pulse' : undefined} style={{ width: 7, height: 7, borderRadius: '50%', background: s.fg, flexShrink: 0 }} />
      {s.label}
    </span>
  )
}

function EntityTile({ alert, equipment, drivers }: { alert: ComplianceAlert; equipment: Equipment[]; drivers: Driver[] }) {
  let icon = <User size={15} />
  let tint = { fg: '#6d28d9', bg: 'var(--ds-violet-bg)' } // driver/trailer = violet
  let monoId = ''
  let name: string
  let sub: string

  if (alert.entityType === 'TRUCK') {
    const eq = equipment.find((e) => e.id === alert.entityId)
    const isTrailer = eq?.type === 'trailer'
    // NEVER show the raw eq-… UUID — resolve to the unit number.
    name = eq ? `#${eq.unitNumber}${eq.nickname ? ` · ${eq.nickname}` : ''}` : (alert.entityName ?? 'Unit')
    monoId = eq?.unitNumber ? `#${eq.unitNumber}` : ''
    if (isTrailer) { icon = <Container size={15} />; tint = { fg: '#6d28d9', bg: 'var(--ds-violet-bg)' }; sub = 'Trailer' }
    else { icon = <Truck size={15} />; tint = { fg: '#1ea8f3', bg: 'var(--ds-blue-bg)' }; sub = 'Truck' }
  } else {
    const d = drivers.find((x) => x.id === alert.entityId)
    name = d?.name ?? alert.entityName ?? 'Driver'
    sub = 'Driver'
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 34, height: 34, borderRadius: 9, background: tint.bg, color: tint.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{icon}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: 'var(--ds-t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
        <div style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>
          {monoId && <span style={{ fontFamily: 'var(--font-mono)' }}>{monoId} · </span>}{sub}
        </div>
      </div>
    </div>
  )
}

function ExpirationCell({ date }: { date?: string | null }) {
  const d = daysUntil(date)
  const color = d == null ? 'var(--ds-t3)' : d < 0 ? '#b91c1c' : d <= 7 ? '#b45309' : 'var(--ds-t2)'
  return (
    <div style={{ whiteSpace: 'nowrap' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color, fontWeight: d != null && d <= 7 ? 600 : 400 }}>{date ?? '—'}</div>
      <div style={{ fontSize: 11, color: 'var(--ds-t3)' }}>{daysRemainingLabel(date)}</div>
    </div>
  )
}

export function CompliancePage() {
  const navigate = useNavigate()
  const { isOwner } = useAuth()
  const { alerts, loading, acknowledge, resolve } = useComplianceAlerts()
  const equipment = useAppStore((s) => s.equipment)
  const drivers = useAppStore((s) => s.drivers)
  const [severity, setSeverity] = useState<AlertSeverity | 'ALL'>('ALL')
  const [entityType, setEntityType] = useState<ComplianceEntityType | 'ALL'>('ALL')
  const [showAcked, setShowAcked] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [historyAlert, setHistoryAlert] = useState<ComplianceAlert | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [resolving, setResolving] = useState(false)

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

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function resolveAlerts(ids: string[]) {
    if (ids.length === 0) return
    setResolving(true)
    try {
      await resolve(ids)
      setSelected(new Set())
      toast.success(`Resolved ${ids.length} alert${ids.length === 1 ? '' : 's'}`)
    } catch (e) { console.error(e); toast.error('Could not resolve alerts') }
    finally { setResolving(false) }
  }

  function goToEntity(a: ComplianceAlert) {
    navigate(a.entityType === 'DRIVER' ? `/compliance/driver/${a.entityId}` : `/compliance/truck/${a.entityId}`)
  }

  const allShownSelected = visible.length > 0 && visible.every((a) => selected.has(a.id))

  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>Compliance alerts</h1>
          <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>Expiring and expired DOT documents across drivers and trucks.</p>
        </div>

        {/* KPI cards — 3px left accent */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {KPI.map(({ sev, label, color, soft }) => {
            const active = severity === sev
            return (
              <button key={sev} onClick={() => setSeverity(active ? 'ALL' : sev)}
                style={{ textAlign: 'left', background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderLeft: `3px solid ${color}`, borderRadius: 12, padding: '14px 16px', cursor: 'pointer', boxShadow: active ? `0 0 0 2px ${soft}` : 'var(--sh-sm)' }}>
                <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ds-t3)' }}>{label}</div>
                <div style={{ fontSize: 30, fontWeight: 600, color, letterSpacing: '-0.02em', lineHeight: 1.1, marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>{counts[sev]}</div>
              </button>
            )
          })}
        </div>

        {/* Filter row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
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
          <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--ds-t3)', fontVariantNumeric: 'tabular-nums' }}>
            {loading ? 'Loading…' : `${visible.length} alert${visible.length === 1 ? '' : 's'}`}
          </span>
        </div>

        <Card
          title="Alerts"
          sub={loading ? undefined : `${visible.length} shown`}
          right={
            visible.length > 0 ? (
              <div style={{ display: 'flex', gap: 10 }}>
                <Button size="sm" style={{ paddingInline: 16 }} disabled={resolving || selected.size === 0} onClick={() => resolveAlerts([...selected])}>
                  <CheckCheck size={14} /> Resolve selected{selected.size > 0 ? ` (${selected.size})` : ''}
                </Button>
                <Button size="sm" variant="outline" style={{ paddingInline: 16 }} disabled={resolving} onClick={() => resolveAlerts(visible.map((a) => a.id))}>
                  Resolve all shown
                </Button>
              </div>
            ) : undefined
          }
          noPad
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
            <thead style={{ background: 'var(--ds-bg-2)' }}>
              <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
                <th style={{ padding: '9px 16px', width: 38 }}>
                  <input type="checkbox" aria-label="Select all shown" checked={allShownSelected}
                    onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((a) => a.id)) : new Set())} />
                </th>
                {[['Entity', 'auto'], ['Document', 'auto'], ['Severity', '130px'], ['Expiration', '150px'], ['', '190px']].map(([h, w], i) => (
                  <th key={h || i} style={{ padding: '9px 16px', width: w, textAlign: i === 4 ? 'right' : 'left', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!loading && visible.length === 0 && (
                <tr><td colSpan={6} style={{ padding: '36px 16px', textAlign: 'center', color: 'var(--ds-t3)' }}>No alerts. All clear. ✅</td></tr>
              )}
              {visible.map((a) => (
                <tr key={a.id} className="hover:bg-slate-50/60"
                  style={{ borderBottom: '1px solid var(--ds-border)', opacity: a.acknowledged ? 0.6 : 1, background: selected.has(a.id) ? 'rgba(30,168,243,0.05)' : undefined }}>
                  <td style={{ padding: '10px 16px' }}>
                    <input type="checkbox" aria-label="Select alert" checked={selected.has(a.id)} onChange={() => toggleSelect(a.id)} />
                  </td>
                  <td style={{ padding: '10px 16px' }}><EntityTile alert={a} equipment={equipment} drivers={drivers} /></td>
                  <td style={{ padding: '10px 16px', color: 'var(--ds-t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.documentTitle ?? a.documentType}</td>
                  <td style={{ padding: '10px 16px' }}><SeverityPill severity={a.severity} /></td>
                  <td style={{ padding: '10px 16px' }}><ExpirationCell date={a.expirationDate} /></td>
                  <td style={{ padding: '10px 16px' }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
                      <Button size="sm" variant="ghost" style={{ paddingInline: 12 }} onClick={() => setHistoryAlert(a)} title="Email history" aria-label="Email history"><Mail size={14} /></Button>
                      <Button size="sm" variant="outline" style={{ paddingInline: 16 }} onClick={() => goToEntity(a)}><ExternalLink size={14} /> Open</Button>
                      {!a.acknowledged && <Button size="sm" style={{ paddingInline: 16 }} disabled={busyId === a.id} onClick={() => ack(a)}><Check size={14} /> Ack</Button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {isOwner && <BackfillOnboardingCard />}

        {/* Two-up: escalation rules + email settings */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
          <EscalationRulesCard />
          <EmailSettingsCard />
        </div>
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
