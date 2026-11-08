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
import type { CSSProperties } from 'react'
import { Plus, Save, Trash2, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsIconButton, TmsInput, TmsSelect } from '@/features/tms/kit'
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
import { CheckRow, ErrorText, GroupLabel, Hint, Loading, Panel, SettingsCard, Stack } from './settingsKit'

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

const CHIP: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  border: '1px solid var(--tms-border)', borderRadius: 999, padding: '2px 8px', fontSize: 12,
}
const CHIP_ROW: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }
const END_ALIGNED: CSSProperties = { display: 'flex', alignItems: 'flex-end', paddingBottom: 6 }

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
    <SettingsCard
      icon={Wallet}
      title="Commissions"
      description="Whether commissions are computed at all, what triggers them, who is paid what, and when a period pays out."
    >
      {loading ? <Loading /> : (
        <Stack>
          <CheckRow ariaLabel="Commissions enabled" label="Compute commissions" checked={enabled} onChange={setEnabled} />
          <Hint>Nothing is computed, written or shown while this is off.</Hint>

          <div className="tms-grid tms-grid-2">
            <TmsField
              label="Earned"
              hint="Ready-to-invoice is deliberately not offered: at that rung nothing is frozen, and a commission on a number that can still change is a number that will be wrong."
            >
              <TmsSelect
                aria-label="Commission trigger"
                value={trigger}
                onChange={(e) => setTrigger(e.target.value as CommissionTrigger)}
              >
                <option value="GENERATE_INVOICE">{TRIGGER_LABELS.GENERATE_INVOICE}</option>
                <option value="INVOICE_PAID">{TRIGGER_LABELS.INVOICE_PAID}</option>
              </TmsSelect>
            </TmsField>
            <Stack gap={8}>
              <CheckRow
                ariaLabel="Commission approval admin only"
                label="Only an admin may approve a commission"
                checked={approvalAdminOnly}
                onChange={setApprovalAdminOnly}
              />
              <CheckRow
                ariaLabel="Commission pay admin only"
                label="Only an admin may submit, approve or pay a period"
                checked={payAdminOnly}
                onChange={setPayAdminOnly}
              />
            </Stack>
          </div>

          <Panel>
            <GroupLabel>Pay schedule</GroupLabel>
            <div className="tms-grid tms-grid-4">
              <TmsField label="Frequency">
                <TmsSelect
                  aria-label="Pay frequency"
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value as PayScheduleFrequency)}
                >
                  {PAY_SCHEDULE_FREQUENCIES.map((f) => <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>)}
                </TmsSelect>
              </TmsField>
              <TmsField label="Pay day">
                <TmsInput
                  aria-label="Pay day"
                  inputMode="numeric"
                  value={payDay}
                  onChange={(e) => setPayDay(e.target.value)}
                  placeholder={frequency === 'MONTHLY' ? '1–28' : '0 = Sunday'}
                />
              </TmsField>
              <TmsField label="Days until pay">
                <TmsInput
                  aria-label="Days until pay"
                  inputMode="numeric"
                  value={daysUntilPay}
                  onChange={(e) => setDaysUntilPay(e.target.value)}
                  placeholder="7"
                />
              </TmsField>
              <TmsField label="Anchor Monday">
                <TmsInput
                  aria-label="Anchor date"
                  type="date"
                  value={anchorDate}
                  onChange={(e) => setAnchorDate(e.target.value)}
                />
              </TmsField>
            </div>
            <Hint>
              This period:{' '}
              <strong data-testid="commission-period-preview">
                {period.periodStart} to {period.periodEnd}, paid {period.payDate}
              </strong>
              . The anchor only matters on a fortnightly cadence.
            </Hint>
          </Panel>

          <Stack>
            <GroupLabel>Plans</GroupLabel>
            {plans.length === 0 && <Hint>No commission plans yet.</Hint>}

            {plans.map((plan, i) => (
              <Panel key={i}>
                <div className="tms-grid" style={{ gridTemplateColumns: '8rem minmax(0, 1fr) auto auto', alignItems: 'flex-end' }}>
                  <TmsField label="Id">
                    <TmsInput
                      aria-label={`Plan ${i + 1} id`}
                      value={plan.id}
                      onChange={(e) => updatePlan(i, { id: e.target.value })}
                      placeholder="house-2026"
                    />
                  </TmsField>
                  <TmsField label="Name">
                    <TmsInput
                      aria-label={`Plan ${i + 1} name`}
                      value={plan.name}
                      onChange={(e) => updatePlan(i, { name: e.target.value })}
                      placeholder="House plan"
                    />
                  </TmsField>
                  <div style={END_ALIGNED}>
                    <CheckRow
                      ariaLabel={`Plan ${i + 1} active`}
                      label="Active"
                      checked={plan.active}
                      onChange={(v) => updatePlan(i, { active: v })}
                    />
                  </div>
                  <TmsIconButton
                    shape="plain"
                    aria-label={`Remove plan ${i + 1}`}
                    onClick={() => setPlans((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={14} />
                  </TmsIconButton>
                </div>

                <div className="tms-grid tms-grid-3">
                  <TmsField label="Effective from">
                    <TmsInput
                      aria-label={`Plan ${i + 1} effective from`}
                      type="date"
                      value={plan.effectiveFrom}
                      onChange={(e) => updatePlan(i, { effectiveFrom: e.target.value })}
                    />
                  </TmsField>
                  <TmsField label="Effective to">
                    <TmsInput
                      aria-label={`Plan ${i + 1} effective to`}
                      type="date"
                      value={plan.effectiveTo}
                      onChange={(e) => updatePlan(i, { effectiveTo: e.target.value })}
                    />
                  </TmsField>
                  <TmsField label="Dated by">
                    <TmsSelect
                      aria-label={`Plan ${i + 1} date field`}
                      value={plan.dateField}
                      onChange={(e) => updatePlan(i, { dateField: e.target.value })}
                    >
                      <option value={ANY_DATE}>— either date —</option>
                      <option value="INVOICED">Invoiced date</option>
                      <option value="DELIVERED">Delivered date</option>
                    </TmsSelect>
                  </TmsField>
                </div>

                <div className="tms-grid tms-grid-3">
                  <TmsField label="Only these people">
                    <div style={CHIP_ROW}>
                      {plan.userIds.map((id) => (
                        <span key={id} style={CHIP}>
                          {nameOf(id)}
                          <TmsIconButton
                            shape="plain"
                            aria-label={`Remove ${id} from plan ${i + 1}`}
                            onClick={() => updatePlan(i, { userIds: plan.userIds.filter((u) => u !== id) })}
                          >
                            ×
                          </TmsIconButton>
                        </span>
                      ))}
                      <TmsSelect
                        aria-label={`Add person to plan ${i + 1}`}
                        value=""
                        onChange={(e) => {
                          const id = e.target.value
                          if (id && !plan.userIds.includes(id)) updatePlan(i, { userIds: [...plan.userIds, id] })
                        }}
                        style={{ width: 'auto' }}
                      >
                        <option value="">— add —</option>
                        {staff.filter((p) => !plan.userIds.includes(p.id)).map((p) => (
                          <option key={p.id} value={p.id}>{nameOf(p.id)}</option>
                        ))}
                      </TmsSelect>
                    </div>
                  </TmsField>
                  <TmsField label="Only these customers">
                    <TmsInput
                      aria-label={`Plan ${i + 1} customer ids`}
                      value={plan.customerIds}
                      onChange={(e) => updatePlan(i, { customerIds: e.target.value })}
                      placeholder="customer ids, comma separated"
                    />
                  </TmsField>
                  <TmsField label="Only these teams">
                    <TmsInput
                      aria-label={`Plan ${i + 1} team keys`}
                      value={plan.teamKeys}
                      onChange={(e) => updatePlan(i, { teamKeys: e.target.value })}
                      placeholder="SALES, EAST"
                    />
                  </TmsField>
                </div>

                <Stack gap={8}>
                  <GroupLabel>Roles paid</GroupLabel>
                  {plan.roles.map((role, j) => (
                    <Panel key={j} style={{ gap: 8, padding: 10 }}>
                      <div className="tms-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) 6rem 6rem auto', alignItems: 'flex-end', gap: 8 }}>
                        <TmsField label="Role">
                          <TmsSelect
                            aria-label={`Plan ${i + 1} role ${j + 1} name`}
                            value={role.roleName}
                            onChange={(e) => updateRole(i, j, { roleName: e.target.value as CommissionRoleName })}
                          >
                            {COMMISSION_ROLE_NAMES.map((r) => <option key={r} value={r}>{COMMISSION_ROLE_LABELS[r]}</option>)}
                          </TmsSelect>
                        </TmsField>
                        <TmsField label="Paid on">
                          <TmsSelect
                            aria-label={`Plan ${i + 1} role ${j + 1} rate type`}
                            value={role.rateType}
                            onChange={(e) => updateRole(i, j, { rateType: e.target.value as CommissionRateType })}
                          >
                            {COMMISSION_RATE_TYPES.map((t) => <option key={t} value={t}>{RATE_TYPE_LABELS[t]}</option>)}
                          </TmsSelect>
                        </TmsField>
                        <TmsField label={role.rateType === 'FIXED' ? 'Rate $' : 'Rate %'}>
                          <TmsInput
                            aria-label={`Plan ${i + 1} role ${j + 1} rate`}
                            inputMode="decimal"
                            value={role.rate}
                            onChange={(e) => updateRole(i, j, { rate: e.target.value })}
                            placeholder={role.rateType === 'FIXED' ? '50.00' : '3.5'}
                          />
                        </TmsField>
                        <TmsField label="Split %">
                          <TmsInput
                            aria-label={`Plan ${i + 1} role ${j + 1} split`}
                            inputMode="decimal"
                            value={role.split}
                            onChange={(e) => updateRole(i, j, { split: e.target.value })}
                            placeholder="equal shares"
                          />
                        </TmsField>
                        <TmsIconButton
                          shape="plain"
                          aria-label={`Remove plan ${i + 1} role ${j + 1}`}
                          onClick={() => updatePlan(i, { roles: plan.roles.filter((_, k) => k !== j) })}
                        >
                          <Trash2 size={14} />
                        </TmsIconButton>
                      </div>

                      {role.rateType === 'FIXED' && Number.isInteger(centsFromDollars(role.rate)) && (
                        <Hint>Stored as {formatCents(centsFromDollars(role.rate) ?? 0)} per person on the role.</Hint>
                      )}

                      {role.roleName === 'SPECIFIC_USER' && (
                        <TmsField label="People">
                          <div style={CHIP_ROW}>
                            {role.userIds.map((id) => (
                              <span key={id} style={CHIP}>
                                {nameOf(id)}
                                <TmsIconButton
                                  shape="plain"
                                  aria-label={`Remove ${id} from plan ${i + 1} role ${j + 1}`}
                                  onClick={() => updateRole(i, j, { userIds: role.userIds.filter((u) => u !== id) })}
                                >
                                  ×
                                </TmsIconButton>
                              </span>
                            ))}
                            <TmsSelect
                              aria-label={`Add person to plan ${i + 1} role ${j + 1}`}
                              value=""
                              onChange={(e) => {
                                const id = e.target.value
                                if (id && !role.userIds.includes(id)) updateRole(i, j, { userIds: [...role.userIds, id] })
                              }}
                              style={{ width: 'auto' }}
                            >
                              <option value="">— add —</option>
                              {staff.filter((p) => !role.userIds.includes(p.id)).map((p) => (
                                <option key={p.id} value={p.id}>{nameOf(p.id)}</option>
                              ))}
                            </TmsSelect>
                          </div>
                        </TmsField>
                      )}

                      <div className="tms-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'flex-end', gap: 8 }}>
                        <TmsField label="Tier ladder">
                          <TmsSelect
                            aria-label={`Plan ${i + 1} role ${j + 1} tier type`}
                            value={role.tierType}
                            onChange={(e) => updateRole(i, j, { tierType: e.target.value })}
                          >
                            <option value={NO_TIERS}>— one rate, no bands —</option>
                            {COMMISSION_TIER_TYPES.map((t) => <option key={t} value={t}>{TIER_TYPE_LABELS[t]}</option>)}
                          </TmsSelect>
                        </TmsField>
                        {role.tierType !== NO_TIERS && (
                          <div style={END_ALIGNED}>
                            <CheckRow
                              ariaLabel={`Plan ${i + 1} role ${j + 1} graduated`}
                              label="Graduated"
                              checked={role.graduated}
                              onChange={(v) => updateRole(i, j, { graduated: v })}
                            />
                          </div>
                        )}
                      </div>

                      {role.tierType !== NO_TIERS && (
                        <Stack gap={6}>
                          {role.tiers.map((tier, k) => (
                            <div key={k} className="tms-grid" style={{ gridTemplateColumns: '7rem 6rem minmax(0, 1fr) auto', alignItems: 'center', gap: 8 }}>
                              <TmsInput
                                aria-label={`Plan ${i + 1} role ${j + 1} tier ${k + 1} from`}
                                inputMode="decimal"
                                value={tier.from}
                                onChange={(e) => updateTier(i, j, k, { from: e.target.value })}
                                placeholder={role.tierType === 'PER_LOAD_MARGIN_BPS' ? 'from %' : 'from $'}
                              />
                              <TmsInput
                                aria-label={`Plan ${i + 1} role ${j + 1} tier ${k + 1} rate`}
                                inputMode="decimal"
                                value={tier.rate}
                                onChange={(e) => updateTier(i, j, k, { rate: e.target.value })}
                                placeholder="rate %"
                              />
                              <TmsInput
                                aria-label={`Plan ${i + 1} role ${j + 1} tier ${k + 1} label`}
                                value={tier.label}
                                onChange={(e) => updateTier(i, j, k, { label: e.target.value })}
                                placeholder="what this band is called"
                              />
                              <TmsIconButton
                                shape="plain"
                                aria-label={`Remove plan ${i + 1} role ${j + 1} tier ${k + 1}`}
                                onClick={() => updateRole(i, j, { tiers: role.tiers.filter((_, m) => m !== k) })}
                              >
                                <Trash2 size={13} />
                              </TmsIconButton>
                            </div>
                          ))}
                          <div>
                            <TmsButton
                              size="sm"
                              onClick={() => updateRole(i, j, { tiers: [...role.tiers, { from: '', rate: '', label: '' }] })}
                            >
                              <Plus size={12} /> Add band
                            </TmsButton>
                          </div>
                          <Hint>Bands ascend and the first starts at 0, so every load lands in one. Graduated pays each band its own rate on its own slice, which only works on gross-profit bands.</Hint>
                        </Stack>
                      )}
                    </Panel>
                  ))}
                  <div>
                    <TmsButton
                      size="sm"
                      onClick={() => updatePlan(i, { roles: [...plan.roles, {
                        roleName: 'PRIMARY_ACCOUNT_OWNER', rateType: 'PERCENT_PROFIT', rate: '', split: '',
                        userIds: [], tierType: NO_TIERS, graduated: false, tiers: [],
                      }] })}
                    >
                      <Plus size={12} /> Add role
                    </TmsButton>
                  </div>
                </Stack>
              </Panel>
            ))}

            <div>
              <TmsButton
                size="sm"
                onClick={() => setPlans((prev) => [...prev, {
                  id: '', name: '', active: true, effectiveFrom: '', effectiveTo: '', dateField: ANY_DATE,
                  userIds: [], customerIds: '', teamKeys: '', roles: [],
                }])}
              >
                <Plus size={14} /> Add plan
              </TmsButton>
            </div>
          </Stack>

          {error && <ErrorText>{error}</ErrorText>}
          <div>
            <TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>
              <Save size={14} /> Save commission settings
            </TmsButton>
          </div>
        </Stack>
      )}
    </SettingsCard>
  )
}
