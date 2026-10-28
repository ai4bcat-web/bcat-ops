import { useMemo } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { MoneyField } from './MoneyField'
import { cn } from '@/lib/utils'
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
  const totalExposure = summary.usedCents
  const maxBar = useMemo(() => {
    const limit = policy.creditLimitCents ?? 0
    return Math.max(limit, totalExposure, 1)
  }, [policy.creditLimitCents, totalExposure])

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Credit</h3>
        {summary.warning && <span className="text-xs font-medium text-amber-600">Warning</span>}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Limit</p>
          <p className={cn('font-medium', policy.source.creditLimitCents === 'org' && 'text-muted-foreground')}>
            {formatCents(policy.creditLimitCents)}
            {policy.source.creditLimitCents === 'org' && <span className="ml-1 text-[10px]">(org default)</span>}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Used</p>
          <p className="font-medium">{formatCents(summary.usedCents)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Available</p>
          <p className={cn('font-medium', summary.availableCents != null && summary.availableCents < 0 && 'text-destructive')}>
            {formatCents(summary.availableCents)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Usage</p>
          <p className="font-medium">{formatBps(summary.usageBps)}</p>
        </div>
      </div>

      <div className="space-y-1">
        {BUCKET_ORDER.map((bucket) => {
          const amount = summary.byBucket[bucket]
          const pct = maxBar > 0 ? Math.round((amount / maxBar) * 100) : 0
          return (
            <div key={bucket} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{bucketLabels[bucket]}</span>
                <span className="font-medium">{formatCents(amount)}</span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full',
                    bucket === 'OPEN' && 'bg-blue-500',
                    bucket === 'ACTIVE' && 'bg-amber-500',
                    bucket === 'DELIVERED' && 'bg-emerald-500',
                    bucket === 'INVOICED' && 'bg-purple-500'
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>

      {summary.blockReasons.length > 0 && (
        <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive space-y-1">
          {summary.blockReasons.map((reason) => (
            <p key={reason}>{reason.replace(/_/g, ' ')}</p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 border-t pt-3">
        <MoneyField
          label="Credit limit ($)"
          value={policy.creditLimitCents}
          onChange={(cents) => onChange({ creditLimitCents: cents })}
          disabled={!editable}
        />
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Usage warning (bps)</Label>
          <Input
            type="number"
            min={0}
            max={10000}
            value={policy.creditUsageWarningBps ?? ''}
            onChange={(e) => onChange({ creditUsageWarningBps: e.target.value ? Number(e.target.value) : null })}
            disabled={!editable}
            className="h-9 text-sm"
          />
          {policy.source.creditUsageWarningBps === 'org' && <p className="text-[10px] text-muted-foreground">Org default</p>}
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Max days late</Label>
          <Input
            type="number"
            min={0}
            value={policy.maxDaysLate ?? ''}
            onChange={(e) => onChange({ maxDaysLate: e.target.value ? Number(e.target.value) : null })}
            disabled={!editable}
            className="h-9 text-sm"
          />
          {policy.source.maxDaysLate === 'org' && <p className="text-[10px] text-muted-foreground">Org default</p>}
        </div>
        <Label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={policy.freeCreditRequired} onCheckedChange={(checked) => onChange({ freeCreditRequired: checked })} disabled={!editable} />
          Free credit required
          {policy.source.freeCreditRequired === 'org' && <span className="text-[10px]">(org default)</span>}
        </Label>
      </div>
    </div>
  )
}
