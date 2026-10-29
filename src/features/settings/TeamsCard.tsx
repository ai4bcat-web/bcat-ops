/**
 * Teams: who sits with whom, and which addresses that desk sends from.
 *
 * A team is configuration — a handful of rows — so it is stored as JSON on the
 * settings row and checked by `validateTeams` before it is written. The same
 * function runs here, on the rows as they stand, so an admin reads the refusal
 * ("Team SALES needs at least one member") against the team they are editing
 * instead of after a round trip.
 *
 * Membership is by Cognito username, which is the person's e-mail: the picker
 * offers the staff profiles, and the saved list is what the Lambda mirrors onto
 * every `UserProfile.teamKeys`.
 */
import { useEffect, useState } from 'react'
import { Plus, Save, Trash2, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useStaff } from '@/hooks/useStaff'
import { getTmsSettings, saveTmsSettings } from '@/lib/apiClient'
import { TEAM_SENDER_LABELS, TEAM_SENDER_SLOTS, validateTeams, type TeamSenderSlot } from '@/lib/teams'
import type { Team, TmsSettings } from '@/types/tms'

/** A team as it is edited: every sender slot present, blank for "not set". */
interface TeamRow {
  key: string
  name: string
  memberIds: string[]
  senders: Record<TeamSenderSlot, string>
  showContactOnTracking: boolean
  active: boolean
}

const BLANK_SENDERS = Object.fromEntries(TEAM_SENDER_SLOTS.map((slot) => [slot, ''])) as Record<TeamSenderSlot, string>

export function TeamsCard() {
  const { staff, nameOf } = useStaff()
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [teams, setTeams] = useState<TeamRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    getTmsSettings()
      .then((s: TmsSettings | null) => {
        setSettings(s)
        setTeams((s?.teams ?? []).map((t) => ({
          key: t.key,
          name: t.name,
          memberIds: [...t.memberIds],
          senders: Object.fromEntries(
            TEAM_SENDER_SLOTS.map((slot) => [slot, t.senderAddresses?.[slot] ?? '']),
          ) as Record<TeamSenderSlot, string>,
          showContactOnTracking: t.showContactOnTracking === true,
          active: t.active !== false,
        })))
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const update = (index: number, patch: Partial<TeamRow>) => {
    setTeams((prev) => prev.map((team, i) => (i === index ? { ...team, ...patch } : team)))
  }

  const save = async () => {
    setError(null)
    const raw = teams.map((t) => ({
      key: t.key,
      name: t.name,
      memberIds: t.memberIds,
      senderAddresses: Object.fromEntries(
        TEAM_SENDER_SLOTS.filter((slot) => t.senders[slot].trim()).map((slot) => [slot, t.senders[slot].trim()]),
      ),
      showContactOnTracking: t.showContactOnTracking,
      active: t.active,
    }))

    let checked: Team[]
    try {
      // The Lambda's own gate, run here so the refusal names the team on screen.
      checked = validateTeams(raw)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Those teams cannot be saved')
      return
    }

    setSaving(true)
    try {
      const updated = await saveTmsSettings({ teams: checked }, settings?.updatedAt ?? undefined)
      setSettings(updated)
      toast.success('Teams saved')
    } catch (e) {
      // The Lambda's own sentence, verbatim — it refuses for reasons this card cannot see.
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <div style={{ border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)', padding: 16, boxShadow: 'var(--sh-sm)', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="flex items-center gap-2.5">
        <Users size={16} style={{ color: 'var(--ds-t3)' }} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Teams</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>
            Who sits with whom, which addresses the desk sends from, and whose number the public tracking page prints.
          </div>
        </div>
      </div>

      {loading ? <div className="text-sm text-muted-foreground">Loading…</div> : (
        <div className="space-y-3">
          {teams.length === 0 && <p className="text-xs text-muted-foreground">No teams yet.</p>}

          {teams.map((team, i) => (
            <div key={i} className="space-y-3 rounded-lg border border-border p-3">
              <div className="grid grid-cols-[8rem_1fr_auto] items-end gap-3">
                <div>
                  <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Key</Label>
                  <Input
                    aria-label={`Team ${i + 1} key`}
                    value={team.key}
                    onChange={(e) => update(i, { key: e.target.value.toUpperCase() })}
                    placeholder="SALES"
                    className="h-9 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Name</Label>
                  <Input
                    aria-label={`Team ${i + 1} name`}
                    value={team.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                    placeholder="Sales desk"
                    className="h-9 text-sm"
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={`Remove team ${i + 1}`}
                  onClick={() => setTeams((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Trash2 size={14} />
                </Button>
              </div>

              <div>
                <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Members</Label>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {team.memberIds.map((id) => (
                    <span key={id} className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs">
                      {nameOf(id)}
                      <button
                        type="button"
                        aria-label={`Remove ${id} from team ${i + 1}`}
                        onClick={() => update(i, { memberIds: team.memberIds.filter((m) => m !== id) })}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                  <select
                    aria-label={`Add member to team ${i + 1}`}
                    value=""
                    onChange={(e) => {
                      const id = e.target.value
                      if (id && !team.memberIds.includes(id)) update(i, { memberIds: [...team.memberIds, id] })
                    }}
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                  >
                    <option value="">— add member —</option>
                    {staff.filter((p) => !team.memberIds.includes(p.id)).map((p) => (
                      <option key={p.id} value={p.id}>{nameOf(p.id)}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                {TEAM_SENDER_SLOTS.map((slot) => (
                  <div key={slot}>
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{TEAM_SENDER_LABELS[slot]}</Label>
                    <Input
                      aria-label={`Team ${i + 1} ${TEAM_SENDER_LABELS[slot]}`}
                      value={team.senders[slot]}
                      onChange={(e) => update(i, { senders: { ...team.senders, [slot]: e.target.value } })}
                      placeholder="desk@bcatcorp.com"
                      className="h-9 text-sm"
                    />
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-5">
                <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--ds-t2)' }}>
                  <Switch
                    aria-label={`Team ${i + 1} shows contact on tracking`}
                    checked={team.showContactOnTracking}
                    onCheckedChange={(v) => update(i, { showContactOnTracking: v })}
                  />
                  Print this desk&rsquo;s contact on the tracking page
                </label>
                <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--ds-t2)' }}>
                  <Switch
                    aria-label={`Team ${i + 1} active`}
                    checked={team.active}
                    onCheckedChange={(v) => update(i, { active: v })}
                  />
                  Active
                </label>
              </div>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1"
            onClick={() => setTeams((prev) => [...prev, {
              key: '', name: '', memberIds: [], senders: { ...BLANK_SENDERS }, showContactOnTracking: false, active: true,
            }])}
          >
            <Plus size={14} /> Add team
          </Button>

          <p className="text-xs text-muted-foreground">
            Sender addresses are stored now and used once e-mail sending is wired — the dev account&rsquo;s SES denies sending.
          </p>

          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="button" size="sm" className="h-8 gap-1" onClick={save} disabled={saving}>
            <Save className="size-3.5" /> Save teams
          </Button>
        </div>
      )}
    </div>
  )
}
