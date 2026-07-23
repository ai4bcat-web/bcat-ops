import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  listEscalationRules, seedDefaultEscalationRules, updateEscalationRule,
} from '@/lib/complianceClient'
import { Card } from './components'
import type { EscalationRule } from '@/types'

const RECIPIENT_LABEL: Record<string, string> = { DRIVER: 'Driver', MANAGER: 'Manager', BOTH: 'Driver + Manager' }

export function EscalationRulesCard() {
  const [rules, setRules] = useState<EscalationRule[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  async function load() {
    try { setRules((await listEscalationRules()).sort((a, b) => b.daysBeforeExpiration - a.daysBeforeExpiration)) }
    catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

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
    <Card
      title="Escalation rules"
      sub="When to email about expiring documents"
      right={rules.length === 0 ? <Button size="sm" variant="outline" style={{ paddingInline: 16 }} disabled={busy} onClick={seed}><Plus size={14} /> Seed defaults</Button> : undefined}
    >
      {loading ? (
        <div style={{ fontSize: 13, color: 'var(--ds-t3)' }}>Loading…</div>
      ) : rules.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--ds-t3)' }}>
          No rules yet. Seed the defaults (30-day notice, 7-day final warning, day-0 out-of-service).
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rules.map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ds-t1)' }}>
                  {r.daysBeforeExpiration === 0 ? 'On/after expiration' : `${r.daysBeforeExpiration} days before`}
                  {r.documentType !== 'ALL' && <Badge variant="secondary" className="ml-2">{r.documentType}</Badge>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>{RECIPIENT_LABEL[r.recipients] ?? r.recipients} · {r.templateKey}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: r.active ? '#16a34a' : 'var(--ds-t3)' }}>{r.active ? 'Active' : 'Off'}</span>
                <Switch checked={r.active} onCheckedChange={(v) => toggle(r, v)} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
