import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsSelect } from '@/features/tms/kit'
import { ProfileRows, ProfileSection } from '../shared/ProfileSection'
import { clearWeekPayMode, explicitWeekMode, payGroupForWeek, payModeHistory, pinWeekPayMode, payModeChangeRefusal, effectivePayRate, type WeekPayMode } from '@/lib/driverPay'
import { useAuthUser } from '@/hooks/useAuth'
import { OWNER_EMAIL } from '@/lib/crm/visibility'
import { OWNER_OP_FIRST_PERIOD } from '@/lib/ownerOperatorTrips'
import { weekStartOfISO } from '@/features/driver-pay/week'
import type { DriverPaySetting } from '@/lib/apiClient'
import type { PaySettingPatch } from './useDriverPaySettings'

const MODE_LABEL: Record<WeekPayMode, string> = { OWNER_OPERATOR: 'Standard owner operator', AMAZON: 'Amazon' }

function addWeeks(weekStart: string, n: number): string {
  const d = new Date(`${weekStart}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 7 * n)
  return d.toISOString().slice(0, 10)
}
const weekLabel = (w: string) => `Week of ${new Date(`${w}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`

/**
 * An owner operator can be paid as an Amazon driver one week and as a standard owner operator the next, with a different calculation each
 * week. The mode of a week is pinned in the same rate windows the settlement pages already read (no new field), so changing one week
 * never moves another and a closed week only changes when it is picked here on purpose.
 */
export function PayModeSection({ setting, today, onSave }: {
  setting: DriverPaySetting
  today: string
  onSave: (patch: PaySettingPatch, expectedUpdatedAt: string | undefined) => Promise<unknown>
}) {
  const thisWeek = weekStartOfISO(today)
  const weeks = useMemo(() => {
    const out: string[] = []
    for (let w = addWeeks(thisWeek, 3); w >= OWNER_OP_FIRST_PERIOD && out.length < 40; w = addWeeks(w, -1)) out.push(w)
    return out
  }, [thisWeek])
  const [week, setWeek] = useState(thisWeek)
  const current = (payGroupForWeek(setting, week) === 'AMAZON' ? 'AMAZON' : 'OWNER_OPERATOR') as WeekPayMode
  const pinned = explicitWeekMode(setting, week)
  const [mode, setMode] = useState<WeekPayMode | ''>('')
  const [percent, setPercent] = useState('')
  const [afterExp, setAfterExp] = useState(false)
  const [busy, setBusy] = useState(false)
  const closed = week < thisWeek
  const history = payModeHistory(setting)
  const authUser = useAuthUser()
  const isAdmin = (authUser?.email ?? '').toLowerCase() === OWNER_EMAIL || (authUser?.groups ?? []).includes('ADMIN')
  const refusal = () => payModeChangeRefusal({ week, thisWeek, isAdmin })

  const choose = (w: string) => { setWeek(w); setMode(''); setPercent('') }
  const rate = effectivePayRate(setting, week)
  const shownPercent = percent !== '' ? percent : String(Math.round(rate.payPercent * 1000) / 10)
  const shownAfterExp = percent !== '' ? afterExp : rate.expensesBeforePercent

  const save = async () => {
    const target = mode || current
    const refused = refusal()
    if (refused) { toast.error(refused); return }
    const p = Number(shownPercent)
    if (!Number.isFinite(p) || p <= 0 || p > 100) { toast.error('Enter a pay percent between 1 and 100'); return }
    setBusy(true)
    try {
      const rateHistory = pinWeekPayMode(setting.rateHistory, week, target, { payPercent: p / 100, expensesBeforePercent: shownAfterExp })
      await onSave({ payPercent: setting.payPercent, expensesBeforePercent: setting.expensesBeforePercent, rateHistory }, setting.updatedAt)
      toast.success(`${weekLabel(week)} will settle as ${MODE_LABEL[target]}`)
      setMode(''); setPercent('')
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not save the pay mode') }
    finally { setBusy(false) }
  }
  const clear = async () => {
    const refused = refusal()
    if (refused) { toast.error(refused); return }
    setBusy(true)
    try {
      await onSave({ payPercent: setting.payPercent, expensesBeforePercent: setting.expensesBeforePercent, rateHistory: clearWeekPayMode(setting.rateHistory, week, setting) }, setting.updatedAt)
      toast.success(`${weekLabel(week)} follows the driver’s pay group again`)
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not clear the pay mode') }
    finally { setBusy(false) }
  }

  return (
    <ProfileSection title="Pay mode by week">
      <div className="pf-row-sub" style={{ marginBottom: 8 }}>
        This driver can settle a week as an Amazon driver or as a standard owner operator. Each week keeps its own calculation; changing one week never changes another.
      </div>
      <div className="pf-form-grid" data-testid="pay-mode-form">
        <TmsField label="Week">
          <TmsSelect
            value={week}
            onChange={(e) => choose(e.target.value)}
            options={weeks.map((w) => ({ value: w, label: `${weekLabel(w)}${w === thisWeek ? ' (this week)' : ''}` }))}
          />
        </TmsField>
        <TmsField label="Settles as" hint={pinned ? 'Set by hand for this week' : 'Following the driver’s pay group'}>
          <TmsSelect
            value={mode || current}
            onChange={(e) => setMode(e.target.value as WeekPayMode)}
            options={(Object.keys(MODE_LABEL) as WeekPayMode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }))}
          />
        </TmsField>
        <TmsField label="Pay percent" hint={shownAfterExp ? 'Applied after expenses' : 'Applied before expenses'}>
          <input className="tms-input" value={shownPercent} onChange={(e) => { setPercent(e.target.value); setAfterExp(shownAfterExp) }} aria-label="Pay percent for this week" />
        </TmsField>
      </div>
      {closed ? <div className="pf-row-sub" style={{ marginTop: 6 }}>This week is already closed. Saving recomputes that week’s statement.</div> : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <TmsButton size="sm" variant="primary" disabled={busy} onClick={() => void save()} data-testid="pay-mode-save">Save this week</TmsButton>
        {pinned ? <TmsButton size="sm" disabled={busy} onClick={() => void clear()} data-testid="pay-mode-clear">Follow pay group</TmsButton> : null}
      </div>
      <div style={{ marginTop: 12 }}>
        <div className="pf-row-sub" style={{ fontWeight: 700 }}>Mode history</div>
        {history.length === 0
          ? <div className="pf-empty">Every week follows the driver’s pay group.</div>
          : <ProfileRows rows={history.map((h) => ({
              label: h.until === addWeeks(h.from, 1) ? weekLabel(h.from) : `${weekLabel(h.from)} to ${weekLabel(addWeeks(h.until, -1))}`,
              value: `${MODE_LABEL[h.mode]} · ${pct(h.payPercent)}${h.expensesBeforePercent ? ' after expenses' : ''}`,
            }))} />}
      </div>
    </ProfileSection>
  )
}
