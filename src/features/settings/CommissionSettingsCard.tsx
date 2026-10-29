/**
 * Commissions: whether they are computed at all, what triggers them, who gets paid
 * what under which plan, and when a period is paid out.
 *
 * Everything load-bearing here is checked by the same two functions the Lambda
 * refuses with — `validateCommissionPlans` and `validatePaySchedule` — run against
 * the rows as they stand, so a ladder that cannot pay ("a margin ladder has no
 * slice to pay a rate on") is refused against the plan on screen instead of after a
 * round trip. The card never re-words those refusals: what it shows is what the
 * server would have said.
 *
 * Rates are typed the way a person says them — a percentage as a percentage, a
 * fixed amount in dollars — and stored the way the engine needs them: basis points
 * and integer cents. Nothing here multiplies money by a float.
 */
import { useEffect, useState } from 'react'
import { Plus, Save, Trash2, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useStaff } from '@/hooks/useStaff'
import { getTmsSettings, saveCommissionSettings } from '@/lib/apiClient'
import {
  COMMISSION_RATE_TYPES, COMMISSION_ROLE_LABELS, COMMISSION_ROLE_NAMES, COMMISSION_TIER_TYPES,
  PAY_SCHEDULE_FREQUENCIES, periodWindow, validateCommissionPlans, validatePaySchedule,
} from '@/lib/commission'
import { formatCents } from '@/lib/invoiceBuild'
import { formatCents as dollarsOf, parseCents } from '@/lib/tmsDirectory'
import type {
  CommissionPaySchedule, CommissionPlan, CommissionRateType, CommissionRoleName, CommissionTierType,
  CommissionTrigger, PayScheduleFrequency, TmsSettings,
} from '@/types/tms'

const TRIGGER_LABELS: Record<CommissionTrigger, string> = {
  GENERATE_INVOICE: 'When the invoice is generated',
  INVOICE_PAID: 'When the customer pays',
}

const RATE_TYPE_LABELS: Record<CommissionRateType, string> = {
  FIXED: 'Fixed amount',
  PERCENT_PROFIT: 'Percent of gross profit',
  PERCENT_REVENUE: 'Percent of revenue',
}

const TIER_TYPE_LABELS: Record<CommissionTierType, string> = {
  PER_LOAD_MARGIN_BPS: 'Bands by load margin %',
  PER_LOAD_PROFIT_CENTS: 'Bands by load gross profit $',
}

const FREQUENCY_LABELS: Record<PayScheduleFrequency, string> = {
  WEEKLY: 'Weekly',
  BIWEEKLY: 'Every two weeks',
  SEMI_MONTHLY: 'Twice a month (1st–15th, 16th–end)',
  MONTHLY: 'Monthly',
}

const NO_TIERS = '__NONE__'
const ANY_DATE = '__ANY__'

/** "3.5" → 350 basis points. Decimal text only; junk yields NaN, which the validator names. */
function bpsFromPercent(text: string): number | null {
  const value = text.trim()
  if (!value) return null
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return Number.NaN
  const [whole, fraction = ''] = value.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

/** 350 → "3.5", for the box the percentage was typed in. */
function percentFromBps(bps: number | null | undefined): string {
  return bps == null ? '' : String(bps / 100)
}

/** Dollars, or NaN when the box holds something that is not an amount. */
function centsFromDollars(text: string): number | null {
  try {
    return parseCents(text)
  } catch {
    return Number.NaN
  }
}

interface TierDraft { from: string; rate: string; label: string }

interface RoleDraft {
  roleName: CommissionRoleName
  rateType: CommissionRateType
  /** A percentage for the two PERCENT types, dollars for FIXED. */
  rate: string
  split: string
  userIds: string[]
  tierType: string
  graduated: boolean
  tiers: TierDraft[]
}

interface PlanDraft {
  id: string
  name: string
  active: boolean
  effectiveFrom: string
  effectiveTo: string
  dateField: string
  userIds: string[]
  customerIds: string
  teamKeys: string
  roles: RoleDraft[]
}

function planDrafts(plans: CommissionPlan[] | null | undefined): PlanDraft[] {
  return (plans ?? []).map((plan) => ({
    id: plan.id,
    name: plan.name,
    active: plan.active !== false,
    effectiveFrom: plan.effectiveFrom ?? '',
    effectiveTo: plan.effectiveTo ?? '',
    dateField: plan.dateField ?? ANY_DATE,
    userIds: plan.scope?.userIds ?? [],
    customerIds: (plan.scope?.customerIds ?? []).join(', '),
    teamKeys: (plan.scope?.teamKeys ?? []).join(', '),
    roles: plan.roles.map((role) => ({
      roleName: role.roleName,
      rateType: role.rateType,
      rate: role.rateType === 'FIXED'
        ? (role.rateCents != null ? dollarsOf(role.rateCents) : '')
        : percentFromBps(role.rateBps),
      split: percentFromBps(role.splitBps),
      userIds: role.userIds ?? [],
      tierType: role.tierType ?? NO_TIERS,
      graduated: role.graduated === true,
      tiers: (role.tiers ?? []).map((tier) => ({
        from: role.tierType === 'PER_LOAD_MARGIN_BPS'
          ? percentFromBps(tier.fromBps)
          : (tier.fromCents != null ? dollarsOf(tier.fromCents) : ''),
        rate: percentFromBps(tier.rateBps),
        label: tier.label ?? '',
      })),
    })),
  }))
}

/** The drafts as the validator wants to read them: percentages as bps, dollars as cents. */
function plansForSave(drafts: PlanDraft[]): unknown[] {
  return drafts.map((plan) => {
    const customerIds = plan.customerIds.split(',').map((s) => s.trim()).filter(Boolean)
    const teamKeys = plan.teamKeys.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    // All three empty is "the house plan": `resolvePlan` picks the one plan with no scope at all.
    const scoped = plan.userIds.length > 0 || customerIds.length > 0 || teamKeys.length > 0
    return {
      id: plan.id.trim(),
      name: plan.name.trim(),
      active: plan.active,
      effectiveFrom: plan.effectiveFrom.trim() || null,
      effectiveTo: plan.effectiveTo.trim() || null,
      dateField: plan.dateField === ANY_DATE ? null : plan.dateField,
      scope: scoped ? { userIds: plan.userIds, customerIds, teamKeys } : null,
      roles: plan.roles.map((role) => ({
        roleName: role.roleName,
        rateType: role.rateType,
        rateBps: role.rateType === 'FIXED' ? null : bpsFromPercent(role.rate),
        rateCents: role.rateType === 'FIXED' ? centsFromDollars(role.rate) : null,
        splitBps: role.split.trim() ? bpsFromPercent(role.split) : null,
        userIds: role.userIds,
        tierType: role.tierType === NO_TIERS ? null : role.tierType,
        // No ladder is not a graduated ladder, whatever the hidden switch still says.
        graduated: role.tierType === NO_TIERS ? false : role.graduated,
        tiers: role.tierType === NO_TIERS ? null : role.tiers.map((tier) => (
          role.tierType === 'PER_LOAD_MARGIN_BPS'
            ? { fromBps: bpsFromPercent(tier.from), rateBps: bpsFromPercent(tier.rate), label: tier.label.trim() || null }
            : { fromCents: centsFromDollars(tier.from), rateBps: bpsFromPercent(tier.rate), label: tier.label.trim() || null }
        )),
      })),
    }
  })
}

export function CommissionSettingsCard() {
  const { staff, nameOf } = useStaff()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [enabled, setEnabled] = useState(false)
  const [trigger, setTrigger] = useState<CommissionTrigger>('GENERATE_INVOICE')
  const [frequency, setFrequency] = useState<PayScheduleFrequency>('SEMI_MONTHLY')
  const [payDay, setPayDay] = useState('')
  const [daysUntilPay, setDaysUntilPay] = useState('')
  const [anchorDate, setAnchorDate] = useState('')
  const [approvalAdminOnly, setApprovalAdminOnly] = useState(false)
  const [payAdminOnly, setPayAdminOnly] = useState(false)
  const [plans, setPlans] = useState<PlanDraft[]>([])

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    getTmsSettings()
      .then((s: TmsSettings | null) => {
        setEnabled(s?.commissionsEnabled === true)
        setTrigger(s?.commissionTrigger ?? 'GENERATE_INVOICE')
        setFrequency(s?.commissionPaySchedule?.frequency ?? 'SEMI_MONTHLY')
        setPayDay(s?.commissionPaySchedule?.payDay != null ? String(s.commissionPaySchedule.payDay) : '')
        setDaysUntilPay(s?.commissionPaySchedule?.daysUntilPay != null ? String(s.commissionPaySchedule.daysUntilPay) : '')
        setAnchorDate(s?.commissionPaySchedule?.anchorDate ?? '')
        setApprovalAdminOnly(s?.commissionApprovalAdminOnly === true)
        setPayAdminOnly(s?.commissionPayAdminOnly === true)
        setPlans(planDrafts(s?.commissionPlans))
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const schedule: CommissionPaySchedule = {
    frequency,
    payDay: payDay.trim() ? Number(payDay.trim()) : null,
    daysUntilPay: daysUntilPay.trim() ? Number(daysUntilPay.trim()) : null,
    anchorDate: anchorDate.trim() || null,
  }
  const period = periodWindow(schedule, new Date().toISOString())

  const updatePlan = (index: number, patch: Partial<PlanDraft>) => {
    setPlans((prev) => prev.map((plan, i) => (i === index ? { ...plan, ...patch } : plan)))
  }
  const updateRole = (planIndex: number, roleIndex: number, patch: Partial<RoleDraft>) => {
    setPlans((prev) => prev.map((plan, i) => (i !== planIndex ? plan : {
      ...plan,
      roles: plan.roles.map((role, j) => (j === roleIndex ? { ...role, ...patch } : role)),
    })))
  }
  const updateTier = (planIndex: number, roleIndex: number, tierIndex: number, patch: Partial<TierDraft>) => {
    setPlans((prev) => prev.map((plan, i) => (i !== planIndex ? plan : {
      ...plan,
      roles: plan.roles.map((role, j) => (j !== roleIndex ? role : {
        ...role,
        tiers: role.tiers.map((tier, k) => (k === tierIndex ? { ...tier, ...patch } : tier)),
      })),
    })))
  }

  const save = async () => {
    setError(null)
    let checkedPlans: CommissionPlan[] | null
    let checkedSchedule: CommissionPaySchedule | null
    try {
      // The Lambda's own gates, run here so the refusal names the plan on screen.
      checkedPlans = validateCommissionPlans(plansForSave(plans))
      checkedSchedule = validatePaySchedule(schedule)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Those commission settings cannot be saved')
      return
    }

    setSaving(true)
    try {
      await saveCommissionSettings({
        commissionsEnabled: enabled,
        commissionTrigger: trigger,
        commissionPlans: checkedPlans,
        commissionPaySchedule: checkedSchedule,
        commissionApprovalAdminOnly: approvalAdminOnly,
        commissionPayAdminOnly: payAdminOnly,
      })
      toast.success('Commission settings saved')
    } catch (e) {
      // The Lambda's own sentence, verbatim — it refuses for reasons this card cannot see.
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <div style={{ border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)', padding: 16, boxShadow: 'var(--sh-sm)', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="flex items-center gap-2.5">
        <Wallet size={16} style={{ color: 'var(--ds-t3)' }} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Commissions</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>
            Whether commissions are computed at all, what triggers them, who is paid what, and when a period pays out.
          </div>
        </div>
      </div>

      {loading ? <div className="text-sm text-muted-foreground">Loading…</div> : (
        <div className="space-y-3">
          <label className="flex items-center gap-2.5 text-sm" style={{ color: 'var(--ds-t2)' }}>
            <Switch aria-label="Commissions enabled" checked={enabled} onCheckedChange={setEnabled} />
            Compute commissions
          </label>
          <p className="text-xs text-muted-foreground">
            Nothing is computed, written or shown while this is off.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Earned</Label>
              <Select value={trigger} onValueChange={(v) => setTrigger(v as CommissionTrigger)}>
                <SelectTrigger className="h-9 text-sm" aria-label="Commission trigger"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="GENERATE_INVOICE">{TRIGGER_LABELS.GENERATE_INVOICE}</SelectItem>
                  <SelectItem value="INVOICE_PAID">{TRIGGER_LABELS.INVOICE_PAID}</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                Ready-to-invoice is deliberately not offered: at that rung nothing is frozen, and a commission on a number that can still change is a number that will be wrong.
              </p>
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-2.5 text-sm" style={{ color: 'var(--ds-t2)' }}>
                <Switch aria-label="Commission approval admin only" checked={approvalAdminOnly} onCheckedChange={setApprovalAdminOnly} />
                Only an admin may approve a commission
              </label>
              <label className="flex items-center gap-2.5 text-sm" style={{ color: 'var(--ds-t2)' }}>
                <Switch aria-label="Commission pay admin only" checked={payAdminOnly} onCheckedChange={setPayAdminOnly} />
                Only an admin may submit, approve or pay a period
              </label>
            </div>
          </div>

          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pay schedule</p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div>
                <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Frequency</Label>
                <Select value={frequency} onValueChange={(v) => setFrequency(v as PayScheduleFrequency)}>
                  <SelectTrigger className="h-9 text-sm" aria-label="Pay frequency"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PAY_SCHEDULE_FREQUENCIES.map((f) => <SelectItem key={f} value={f}>{FREQUENCY_LABELS[f]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Pay day</Label>
                <Input
                  aria-label="Pay day"
                  inputMode="numeric"
                  value={payDay}
                  onChange={(e) => setPayDay(e.target.value)}
                  placeholder={frequency === 'MONTHLY' ? '1–28' : '0 = Sunday'}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Days until pay</Label>
                <Input
                  aria-label="Days until pay"
                  inputMode="numeric"
                  value={daysUntilPay}
                  onChange={(e) => setDaysUntilPay(e.target.value)}
                  placeholder="7"
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Anchor Monday</Label>
                <Input
                  aria-label="Anchor date"
                  type="date"
                  value={anchorDate}
                  onChange={(e) => setAnchorDate(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              This period:{' '}
              <span className="font-medium text-foreground" data-testid="commission-period-preview">
                {period.periodStart} to {period.periodEnd}, paid {period.payDate}
              </span>
              . The anchor only matters on a fortnightly cadence.
            </p>
          </div>

          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Plans</p>
            {plans.length === 0 && <p className="text-xs text-muted-foreground">No commission plans yet.</p>}

            {plans.map((plan, i) => (
              <div key={i} className="space-y-3 rounded-lg border border-border p-3">
                <div className="grid grid-cols-[8rem_1fr_auto_auto] items-end gap-3">
                  <div>
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Id</Label>
                    <Input
                      aria-label={`Plan ${i + 1} id`}
                      value={plan.id}
                      onChange={(e) => updatePlan(i, { id: e.target.value })}
                      placeholder="house-2026"
                      className="h-9 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Name</Label>
                    <Input
                      aria-label={`Plan ${i + 1} name`}
                      value={plan.name}
                      onChange={(e) => updatePlan(i, { name: e.target.value })}
                      placeholder="House plan"
                      className="h-9 text-sm"
                    />
                  </div>
                  <label className="flex items-center gap-2 pb-2 text-sm" style={{ color: 'var(--ds-t2)' }}>
                    <Switch
                      aria-label={`Plan ${i + 1} active`}
                      checked={plan.active}
                      onCheckedChange={(v) => updatePlan(i, { active: v })}
                    />
                    Active
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="mb-1 h-8 w-8"
                    aria-label={`Remove plan ${i + 1}`}
                    onClick={() => setPlans((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Effective from</Label>
                    <Input
                      aria-label={`Plan ${i + 1} effective from`}
                      type="date"
                      value={plan.effectiveFrom}
                      onChange={(e) => updatePlan(i, { effectiveFrom: e.target.value })}
                      className="h-9 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Effective to</Label>
                    <Input
                      aria-label={`Plan ${i + 1} effective to`}
                      type="date"
                      value={plan.effectiveTo}
                      onChange={(e) => updatePlan(i, { effectiveTo: e.target.value })}
                      className="h-9 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Dated by</Label>
                    <select
                      aria-label={`Plan ${i + 1} date field`}
                      value={plan.dateField}
                      onChange={(e) => updatePlan(i, { dateField: e.target.value })}
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value={ANY_DATE}>— either date —</option>
                      <option value="INVOICED">Invoiced date</option>
                      <option value="DELIVERED">Delivered date</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Only these people</Label>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {plan.userIds.map((id) => (
                        <span key={id} className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs">
                          {nameOf(id)}
                          <button
                            type="button"
                            aria-label={`Remove ${id} from plan ${i + 1}`}
                            onClick={() => updatePlan(i, { userIds: plan.userIds.filter((u) => u !== id) })}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      <select
                        aria-label={`Add person to plan ${i + 1}`}
                        value=""
                        onChange={(e) => {
                          const id = e.target.value
                          if (id && !plan.userIds.includes(id)) updatePlan(i, { userIds: [...plan.userIds, id] })
                        }}
                        className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                      >
                        <option value="">— add —</option>
                        {staff.filter((p) => !plan.userIds.includes(p.id)).map((p) => (
                          <option key={p.id} value={p.id}>{nameOf(p.id)}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Only these customers</Label>
                    <Input
                      aria-label={`Plan ${i + 1} customer ids`}
                      value={plan.customerIds}
                      onChange={(e) => updatePlan(i, { customerIds: e.target.value })}
                      placeholder="customer ids, comma separated"
                      className="h-9 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Only these teams</Label>
                    <Input
                      aria-label={`Plan ${i + 1} team keys`}
                      value={plan.teamKeys}
                      onChange={(e) => updatePlan(i, { teamKeys: e.target.value })}
                      placeholder="SALES, EAST"
                      className="h-9 text-sm"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Roles paid</p>
                  {plan.roles.map((role, j) => (
                    <div key={j} className="space-y-2 rounded-md border border-border bg-background p-2.5">
                      <div className="grid grid-cols-[1fr_1fr_6rem_6rem_auto] items-end gap-2">
                        <div>
                          <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Role</Label>
                          <select
                            aria-label={`Plan ${i + 1} role ${j + 1} name`}
                            value={role.roleName}
                            onChange={(e) => updateRole(i, j, { roleName: e.target.value as CommissionRoleName })}
                            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                          >
                            {COMMISSION_ROLE_NAMES.map((r) => <option key={r} value={r}>{COMMISSION_ROLE_LABELS[r]}</option>)}
                          </select>
                        </div>
                        <div>
                          <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Paid on</Label>
                          <select
                            aria-label={`Plan ${i + 1} role ${j + 1} rate type`}
                            value={role.rateType}
                            onChange={(e) => updateRole(i, j, { rateType: e.target.value as CommissionRateType })}
                            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                          >
                            {COMMISSION_RATE_TYPES.map((t) => <option key={t} value={t}>{RATE_TYPE_LABELS[t]}</option>)}
                          </select>
                        </div>
                        <div>
                          <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                            {role.rateType === 'FIXED' ? 'Rate $' : 'Rate %'}
                          </Label>
                          <Input
                            aria-label={`Plan ${i + 1} role ${j + 1} rate`}
                            inputMode="decimal"
                            value={role.rate}
                            onChange={(e) => updateRole(i, j, { rate: e.target.value })}
                            placeholder={role.rateType === 'FIXED' ? '50.00' : '3.5'}
                            className="h-9 text-sm"
                          />
                        </div>
                        <div>
                          <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Split %</Label>
                          <Input
                            aria-label={`Plan ${i + 1} role ${j + 1} split`}
                            inputMode="decimal"
                            value={role.split}
                            onChange={(e) => updateRole(i, j, { split: e.target.value })}
                            placeholder="equal shares"
                            className="h-9 text-sm"
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="mb-1 h-8 w-8"
                          aria-label={`Remove plan ${i + 1} role ${j + 1}`}
                          onClick={() => updatePlan(i, { roles: plan.roles.filter((_, k) => k !== j) })}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>

                      {role.rateType === 'FIXED' && Number.isInteger(centsFromDollars(role.rate)) && (
                        <p className="text-xs text-muted-foreground">
                          Stored as {formatCents(centsFromDollars(role.rate) ?? 0)} per person on the role.
                        </p>
                      )}

                      {role.roleName === 'SPECIFIC_USER' && (
                        <div>
                          <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">People</Label>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            {role.userIds.map((id) => (
                              <span key={id} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs">
                                {nameOf(id)}
                                <button
                                  type="button"
                                  aria-label={`Remove ${id} from plan ${i + 1} role ${j + 1}`}
                                  onClick={() => updateRole(i, j, { userIds: role.userIds.filter((u) => u !== id) })}
                                  className="text-muted-foreground hover:text-foreground"
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                            <select
                              aria-label={`Add person to plan ${i + 1} role ${j + 1}`}
                              value=""
                              onChange={(e) => {
                                const id = e.target.value
                                if (id && !role.userIds.includes(id)) updateRole(i, j, { userIds: [...role.userIds, id] })
                              }}
                              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                            >
                              <option value="">— add —</option>
                              {staff.filter((p) => !role.userIds.includes(p.id)).map((p) => (
                                <option key={p.id} value={p.id}>{nameOf(p.id)}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                        <div>
                          <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Tier ladder</Label>
                          <select
                            aria-label={`Plan ${i + 1} role ${j + 1} tier type`}
                            value={role.tierType}
                            onChange={(e) => updateRole(i, j, { tierType: e.target.value })}
                            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                          >
                            <option value={NO_TIERS}>— one rate, no bands —</option>
                            {COMMISSION_TIER_TYPES.map((t) => <option key={t} value={t}>{TIER_TYPE_LABELS[t]}</option>)}
                          </select>
                        </div>
                        {role.tierType !== NO_TIERS && (
                          <label className="flex items-center gap-2 pb-2 text-sm" style={{ color: 'var(--ds-t2)' }}>
                            <Switch
                              aria-label={`Plan ${i + 1} role ${j + 1} graduated`}
                              checked={role.graduated}
                              onCheckedChange={(v) => updateRole(i, j, { graduated: v })}
                            />
                            Graduated
                          </label>
                        )}
                      </div>

                      {role.tierType !== NO_TIERS && (
                        <div className="space-y-1.5">
                          {role.tiers.map((tier, k) => (
                            <div key={k} className="grid grid-cols-[7rem_6rem_1fr_auto] items-center gap-2">
                              <Input
                                aria-label={`Plan ${i + 1} role ${j + 1} tier ${k + 1} from`}
                                inputMode="decimal"
                                value={tier.from}
                                onChange={(e) => updateTier(i, j, k, { from: e.target.value })}
                                placeholder={role.tierType === 'PER_LOAD_MARGIN_BPS' ? 'from %' : 'from $'}
                                className="h-9 text-sm"
                              />
                              <Input
                                aria-label={`Plan ${i + 1} role ${j + 1} tier ${k + 1} rate`}
                                inputMode="decimal"
                                value={tier.rate}
                                onChange={(e) => updateTier(i, j, k, { rate: e.target.value })}
                                placeholder="rate %"
                                className="h-9 text-sm"
                              />
                              <Input
                                aria-label={`Plan ${i + 1} role ${j + 1} tier ${k + 1} label`}
                                value={tier.label}
                                onChange={(e) => updateTier(i, j, k, { label: e.target.value })}
                                placeholder="what this band is called"
                                className="h-9 text-sm"
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                aria-label={`Remove plan ${i + 1} role ${j + 1} tier ${k + 1}`}
                                onClick={() => updateRole(i, j, { tiers: role.tiers.filter((_, m) => m !== k) })}
                              >
                                <Trash2 size={13} />
                              </Button>
                            </div>
                          ))}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            onClick={() => updateRole(i, j, { tiers: [...role.tiers, { from: '', rate: '', label: '' }] })}
                          >
                            <Plus size={12} /> Add band
                          </Button>
                          <p className="text-xs text-muted-foreground">
                            Bands ascend and the first starts at 0, so every load lands in one. Graduated pays each band its own rate on its own slice, which only works on gross-profit bands.
                          </p>
                        </div>
                      )}
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    onClick={() => updatePlan(i, { roles: [...plan.roles, {
                      roleName: 'PRIMARY_ACCOUNT_OWNER', rateType: 'PERCENT_PROFIT', rate: '', split: '',
                      userIds: [], tierType: NO_TIERS, graduated: false, tiers: [],
                    }] })}
                  >
                    <Plus size={12} /> Add role
                  </Button>
                </div>
              </div>
            ))}

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1"
              onClick={() => setPlans((prev) => [...prev, {
                id: '', name: '', active: true, effectiveFrom: '', effectiveTo: '', dateField: ANY_DATE,
                userIds: [], customerIds: '', teamKeys: '', roles: [],
              }])}
            >
              <Plus size={14} /> Add plan
            </Button>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="button" size="sm" className="h-8 gap-1" onClick={save} disabled={saving}>
            <Save className="size-3.5" /> Save commission settings
          </Button>
        </div>
      )}
    </div>
  )
}
