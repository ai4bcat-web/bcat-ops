import { useEffect, useState } from 'react'
import { Printer } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getApplicationByDriver } from '@/lib/complianceClient'
import { Card } from './components'
import type {
  DriverApplicationRecord,
} from '@/types'
import type { AddressEntry, EmploymentEntry } from '@/lib/schemas'

function Field({ label, value }: { label: string; value?: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 13.5, color: 'var(--ds-t1)', marginTop: 2 }}>{value ?? '—'}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ds-t2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid var(--ds-border)' }}>
        {title}
      </div>
      {children}
    </div>
  )
}

const STATUS_BADGE = {
  DRAFT: { variant: 'secondary' as const, label: 'Draft' },
  SUBMITTED: { variant: 'default' as const, label: 'Submitted' },
  APPROVED: { variant: 'green' as const, label: 'Approved' },
  REJECTED: { variant: 'destructive' as const, label: 'Rejected' },
}

export function DriverApplicationView({ driverId }: { driverId: string }) {
  const [app, setApp] = useState<DriverApplicationRecord | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    getApplicationByDriver(driverId)
      .then((a) => { if (active) setApp(a) })
      .catch((e) => console.error('[application] load', e))
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [driverId])

  if (loading) return <Card title="Employment application"><div style={{ fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div></Card>
  if (!app) return <Card title="Employment application"><div style={{ fontSize: 13, color: 'var(--ds-t3)' }}>No application submitted yet.</div></Card>

  const addresses = (Array.isArray(app.addressHistory) ? app.addressHistory : []) as AddressEntry[]
  const employment = (Array.isArray(app.employmentHistory) ? app.employmentHistory : []) as EmploymentEntry[]
  const badge = STATUS_BADGE[app.status]

  return (
    <Card
      title="Employment application"
      sub="49 CFR 391.21 — DQ-file artifact"
      right={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Badge variant={badge.variant}>{badge.label}</Badge>
          <Button size="sm" variant="outline" onClick={() => window.print()}><Printer size={14} /> Print / PDF</Button>
        </div>
      }
    >
      <div className="application-print">
        <Section title="Personal">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            <Field label="Legal name" value={app.legalName} />
            <Field label="Date of birth" value={app.dob} />
            <Field label="SSN (last 4)" value={app.ssnLast4 ? `•••-••-${app.ssnLast4}` : undefined} />
            <Field label="Phone" value={app.phone} />
            <Field label="Current address" value={app.currentAddress} />
          </div>
        </Section>

        <Section title="Address history (3 yrs)">
          {addresses.length === 0 ? <div style={{ fontSize: 13, color: 'var(--ds-t3)' }}>None provided.</div> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {addresses.map((a, i) => (
                <div key={i} style={{ fontSize: 13, color: 'var(--ds-t2)' }}>
                  {a.street}, {a.city}, {a.state} {a.zip}
                  <span style={{ color: 'var(--ds-t3)', marginLeft: 8 }}>({a.fromDate} – {a.toDate ?? 'present'})</span>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="License">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            <Field label="CDL number" value={app.cdlNumber} />
            <Field label="State" value={app.cdlState} />
            <Field label="Class" value={app.cdlClass} />
            <Field label="Expiration" value={app.cdlExpiration} />
            <Field label="Endorsements" value={(app.endorsements ?? []).join(', ') || '—'} />
            <Field label="CDL issued after Feb 7 2022" value={app.cdlIssuedAfterFeb2022 ? `Yes — ELDT: ${app.eldtProviderName ?? '—'}` : 'No'} />
          </div>
        </Section>

        <Section title="Employment history">
          {employment.length === 0 ? <div style={{ fontSize: 13, color: 'var(--ds-t3)' }}>None provided.</div> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {employment.map((e, i) => (
                <div key={i} style={{ fontSize: 13, color: 'var(--ds-t2)', paddingBottom: 8, borderBottom: i < employment.length - 1 ? '1px dashed var(--ds-border)' : 'none' }}>
                  <div style={{ fontWeight: 600, color: 'var(--ds-t1)' }}>{e.employerName} — {e.position}</div>
                  <div>{e.address} · {e.phone}</div>
                  <div style={{ color: 'var(--ds-t3)' }}>
                    {e.fromDate} – {e.toDate ?? 'present'} · FMCSR: {e.subjectToFMCSR ? 'Yes' : 'No'} · Safety-sensitive: {e.safetySensitive ? 'Yes' : 'No'}
                  </div>
                  {e.reasonForLeaving && <div>Reason left: {e.reasonForLeaving}</div>}
                  {e.gapExplanation && <div style={{ color: '#b45309' }}>Gap: {e.gapExplanation}</div>}
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Certification">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            <Field label="Signed by" value={app.signatureName} />
            <Field label="Signed at" value={app.signedAt ? new Date(app.signedAt).toLocaleString() : undefined} />
            <Field label="IP address" value={app.ipAddress} />
          </div>
          {app.rejectionReason && <div style={{ marginTop: 10, fontSize: 13, color: '#b91c1c' }}>Rejection reason: {app.rejectionReason}</div>}
        </Section>
      </div>
    </Card>
  )
}
