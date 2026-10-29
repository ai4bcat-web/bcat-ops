import { useMemo } from 'react'
import { TmsCard, TmsField, TmsInput } from '@/features/tms/kit'
import { MoneyField } from './MoneyField'
import type { CreditPolicy, CreditSummary, CreditBucket } from '@/lib/customerCredit'

const BUCKET_ORDER: CreditBucket[] = ['OPEN', 'ACTIVE', 'DELIVERED', 'INVOICED']

const bucketLabels: Record<CreditBucket, string> = {
  OPEN: 'Open',
  ACTIVE: 'Active',
  DELIVERED: 'Delivered',
  INVOICED: 'Invoiced',
}

const bucketColors: Record<CreditBucket, string> = {
  OPEN: 'var(--tms-badge-blue)',
  ACTIVE: 'var(--tms-badge-orange)',
  DELIVERED: 'var(--tms-badge-green)',
  INVOICED: 'var(--tms-badge-purple)',
}

function formatCents(cents: number | null): string {
  if (cents == null) return '—'
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatBps(bps: number | null): string {
  if (bps == null) return '—'
  return `${(bps / 100).toFixed(2)}%`
}

interface CreditLimitCardProps {
  policy: CreditPolicy
  summary: CreditSummary
  editable: boolean
  onChange: (patch: Partial<{ creditLimitCents: number | null; freeCreditRequired: boolean; creditUsageWarningBps: number | null; maxDaysLate: number | null }>) => void
}

export function CreditLimitCard({ policy, summary, editable, onChange }: CreditLimitCardProps) {
  const totalExposure = summary.usedCents
  const maxBar = useMemo(() => {
    const limit = policy.creditLimitCents ?? 0
    return Math.max(limit, totalExposure, 1)
  }, [policy.creditLimitCents, totalExposure])

  return (
    <TmsCard
      title="Credit"
      actions={summary.warning ? <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--tms-badge-orange)' }}>Warning</span> : null}
    >
      <div style={{ display: 'grid', gap: 16 }}>
        <div className="tms-grid tms-grid-4">
          <div>
            <p className="tms-field-label">Limit</p>
            <p style={{ fontWeight: 600, color: policy.source.creditLimitCents === 'org' ? 'var(--tms-muted)' : undefined }}>
              {formatCents(policy.creditLimitCents)}
              {policy.source.creditLimitCents === 'org' && <span style={{ marginLeft: 4, fontSize: 10 }}>(org default)</span>}
            </p>
          </div>
          <div>
            <p className="tms-field-label">Used</p>
            <p style={{ fontWeight: 600 }}>{formatCents(summary.usedCents)}</p>
          </div>
          <div>
            <p className="tms-field-label">Available</p>
            <p style={{ fontWeight: 600, color: summary.availableCents != null && summary.availableCents < 0 ? 'var(--tms-badge-red)' : undefined }}>
              {formatCents(summary.availableCents)}
            </p>
          </div>
          <div>
            <p className="tms-field-label">Usage</p>
            <p style={{ fontWeight: 600 }}>{formatBps(summary.usageBps)}</p>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 6 }}>
          {BUCKET_ORDER.map((bucket) => {
            const amount = summary.byBucket[bucket]
            const pct = maxBar > 0 ? Math.round((amount / maxBar) * 100) : 0
            return (
              <div key={bucket} style={{ display: 'grid', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
                  <span className="tms-muted">{bucketLabels[bucket]}</span>
                  <span style={{ fontWeight: 600 }}>{formatCents(amount)}</span>
                </div>
                <div style={{ height: 8, width: '100%', borderRadius: 999, background: 'var(--tms-input)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 999, width: `${pct}%`, background: bucketColors[bucket] }} />
                </div>
              </div>
            )
          })}
        </div>

        {summary.blockReasons.length > 0 && (
          <div style={{ borderRadius: 'var(--tms-radius)', background: 'rgba(237,90,118,0.14)', padding: 8, fontSize: 12, color: 'var(--tms-badge-red)' }}>
            {summary.blockReasons.map((reason) => (
              <p key={reason}>{reason.replace(/_/g, ' ')}</p>
            ))}
          </div>
        )}

        <div className="tms-grid tms-grid-2" style={{ borderTop: '1px solid var(--tms-border)', paddingTop: 12 }}>
          <MoneyField
            label="Credit limit ($)"
            value={policy.creditLimitCents}
            onChange={(cents) => onChange({ creditLimitCents: cents })}
            disabled={!editable}
          />
          <TmsField
            label="Usage warning (bps)"
            hint={policy.source.creditUsageWarningBps === 'org' ? 'Org default' : undefined}
          >
            <TmsInput
              type="number"
              min={0}
              max={10000}
              value={policy.creditUsageWarningBps ?? ''}
              onChange={(e) => onChange({ creditUsageWarningBps: e.target.value ? Number(e.target.value) : null })}
              disabled={!editable}
            />
          </TmsField>
          <TmsField label="Max days late" hint={policy.source.maxDaysLate === 'org' ? 'Org default' : undefined}>
            <TmsInput
              type="number"
              min={0}
              value={policy.maxDaysLate ?? ''}
              onChange={(e) => onChange({ maxDaysLate: e.target.value ? Number(e.target.value) : null })}
              disabled={!editable}
            />
          </TmsField>
          <label className="tms-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={policy.freeCreditRequired}
              onChange={(e) => onChange({ freeCreditRequired: e.target.checked })}
              disabled={!editable}
            />
            Free credit required
            {policy.source.freeCreditRequired === 'org' && <span style={{ fontSize: 10 }}>(org default)</span>}
          </label>
        </div>
      </div>
    </TmsCard>
  )
}
