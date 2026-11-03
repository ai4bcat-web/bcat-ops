import { TmsAlert, TmsBadge, TmsCard, TmsField, TmsInput, TmsSegmentedBar, TmsStatRow } from '@/features/tms/kit'
import { MoneyField } from './MoneyField'
import type { CreditPolicy, CreditSummary, CreditBucket } from '@/lib/customerCredit'

const BUCKET_ORDER: CreditBucket[] = ['OPEN', 'ACTIVE', 'DELIVERED', 'INVOICED']

const bucketLabels: Record<CreditBucket, string> = {
  OPEN: 'Open',
  ACTIVE: 'Active',
  DELIVERED: 'Delivered',
  INVOICED: 'Invoiced',
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
  return (
    <TmsCard
      title="Credit"
      actions={summary.warning ? <TmsBadge tone="orange">Warning</TmsBadge> : null}
    >
      <div style={{ display: 'grid', gap: 16 }}>
        <TmsStatRow
          compact
          columns={4}
          aria-label="Credit usage"
          items={[
            { key: 'limit', label: 'Limit', value: formatCents(policy.creditLimitCents), sub: policy.source.creditLimitCents === 'org' ? '(org default)' : null },
            { key: 'used', label: 'Used', value: formatCents(summary.usedCents) },
            { key: 'available', label: 'Available', value: formatCents(summary.availableCents), tone: summary.availableCents != null && summary.availableCents < 0 ? 'bad' : 'default' },
            { key: 'usage', label: 'Usage', value: formatBps(summary.usageBps) },
          ]}
        />

        <TmsSegmentedBar
          ariaLabel="Credit exposure by stage"
          segments={BUCKET_ORDER.map((bucket) => ({ key: bucket, label: `${bucketLabels[bucket]} ${formatCents(summary.byBucket[bucket])}`, value: summary.byBucket[bucket] }))}
        />

        {summary.blockReasons.length > 0 && (
          <TmsAlert tone="red">
            {summary.blockReasons.map((reason) => (
              <p key={reason}>{reason.replace(/_/g, ' ')}</p>
            ))}
          </TmsAlert>
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
