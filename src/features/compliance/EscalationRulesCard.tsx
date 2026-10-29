/**
 * When renewal mail goes out about an expiring driver document.
 *
 * Only My Brokerage → Settings renders this, so it wears the MVMNT kit rather than the
 * compliance pages' own `Card` chrome; the compliance pages themselves are untouched.
 */
import { useEffect, useState } from 'react'
import { Plus, BellRing } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsCard } from '@/features/tms/kit'
import {
  listEscalationRules, seedDefaultEscalationRules, updateEscalationRule,
} from '@/lib/complianceClient'
import type { EscalationRule } from '@/types'

const RECIPIENT_LABEL: Record<string, string> = { DRIVER: 'Driver', MANAGER: 'Manager', BOTH: 'Driver + Manager' }

export function EscalationRulesCard() {
  const [rules, setRules] = useState<EscalationRule[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    listEscalationRules()
      .then((data) => setRules(data.sort((a, b) => b.daysBeforeExpiration - a.daysBeforeExpiration)))
      .catch((e) => console.error(e))
      .finally(() => setLoading(false))
  }, [])

  async function load() {
    try { setRules((await listEscalationRules()).sort((a, b) => b.daysBeforeExpiration - a.daysBeforeExpiration)) }
    catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  async function seed() {
    setBusy(true)
    try { await seedDefaultEscalationRules(); await load(); toast.success('Default escalation rules ready') }
    catch (e) { console.error(e); toast.error('Could not seed rules') }
    finally { setBusy(false) }
  }

  async function toggle(rule: EscalationRule, active: boolean) {
    const updated = await updateEscalationRule(rule.id, { active })
    setRules((prev) => prev.map((r) => (r.id === rule.id ? updated : r)))
  }

  return (
    <TmsCard
      title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><BellRing size={14} aria-hidden="true" />Escalation rules</span>}
      actions={rules.length === 0
        ? <TmsButton size="sm" disabled={busy} onClick={seed}><Plus size={14} /> Seed defaults</TmsButton>
        : undefined}
    >
      <p className="tms-field-hint" style={{ margin: '0 0 12px' }}>When to email about expiring documents</p>
      {loading ? (
        <p className="tms-muted" style={{ margin: 0, fontSize: 14 }}>Loading…</p>
      ) : rules.length === 0 ? (
        <p className="tms-muted" style={{ margin: 0, fontSize: 14 }}>
          No rules yet. Seed the defaults (30-day notice, 7-day final warning, day-0 out-of-service).
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rules.map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  {r.daysBeforeExpiration === 0 ? 'On/after expiration' : `${r.daysBeforeExpiration} days before`}
                  {r.documentType !== 'ALL' && <span style={{ marginLeft: 8 }}><TmsBadge tone="gray">{r.documentType}</TmsBadge></span>}
                </div>
                <div className="tms-muted" style={{ fontSize: 12 }}>{RECIPIENT_LABEL[r.recipients] ?? r.recipients} · {r.templateKey}</div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                <span className={r.active ? undefined : 'tms-muted'}>{r.active ? 'Active' : 'Off'}</span>
                <input
                  type="checkbox"
                  aria-label={`Escalation rule ${r.daysBeforeExpiration} days active`}
                  checked={r.active}
                  onChange={(e) => toggle(r, e.target.checked)}
                  style={{ accentColor: 'var(--tms-primary)', width: 15, height: 15 }}
                />
              </label>
            </div>
          ))}
        </div>
      )}
    </TmsCard>
  )
}
