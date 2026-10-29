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
import type { CSSProperties } from 'react'
import { Plus, Save, Trash2, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsIconButton, TmsInput, TmsSelect } from '@/features/tms/kit'
import { useStaff } from '@/hooks/useStaff'
import { getTmsSettings, saveTmsSettings } from '@/lib/apiClient'
import { TEAM_SENDER_LABELS, TEAM_SENDER_SLOTS, validateTeams, type TeamSenderSlot } from '@/lib/teams'
import type { Team, TmsSettings } from '@/types/tms'
import { CheckRow, ErrorText, Hint, Loading, Panel, SettingsCard, Stack } from './settingsKit'

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

/** A member chip: the person, and the cross that takes them off the desk. */
const CHIP: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  border: '1px solid var(--tms-border)', borderRadius: 999, padding: '2px 8px', fontSize: 12,
}

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
    <SettingsCard
      icon={Users}
      title="Teams"
      description="Who sits with whom, which addresses the desk sends from, and whose number the public tracking page prints."
    >
      {loading ? <Loading /> : (
        <Stack>
          {teams.length === 0 && <Hint>No teams yet.</Hint>}

          {teams.map((team, i) => (
            <Panel key={i}>
              <div className="tms-grid" style={{ gridTemplateColumns: '8rem minmax(0, 1fr) auto', alignItems: 'flex-end' }}>
                <TmsField label="Key">
                  <TmsInput
                    aria-label={`Team ${i + 1} key`}
                    value={team.key}
                    onChange={(e) => update(i, { key: e.target.value.toUpperCase() })}
                    placeholder="SALES"
                  />
                </TmsField>
                <TmsField label="Name">
                  <TmsInput
                    aria-label={`Team ${i + 1} name`}
                    value={team.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                    placeholder="Sales desk"
                  />
                </TmsField>
                <TmsIconButton
                  shape="plain"
                  aria-label={`Remove team ${i + 1}`}
                  onClick={() => setTeams((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Trash2 size={14} />
                </TmsIconButton>
              </div>

              <TmsField label="Members">
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                  {team.memberIds.map((id) => (
                    <span key={id} style={CHIP}>
                      {nameOf(id)}
                      <TmsIconButton
                        shape="plain"
                        aria-label={`Remove ${id} from team ${i + 1}`}
                        onClick={() => update(i, { memberIds: team.memberIds.filter((m) => m !== id) })}
                      >
                        <X size={11} />
                      </TmsIconButton>
                    </span>
                  ))}
                  <TmsSelect
                    aria-label={`Add member to team ${i + 1}`}
                    value=""
                    onChange={(e) => {
                      const id = e.target.value
                      if (id && !team.memberIds.includes(id)) update(i, { memberIds: [...team.memberIds, id] })
                    }}
                    style={{ width: 'auto' }}
                  >
                    <option value="">— add member —</option>
                    {staff.filter((p) => !team.memberIds.includes(p.id)).map((p) => (
                      <option key={p.id} value={p.id}>{nameOf(p.id)}</option>
                    ))}
                  </TmsSelect>
                </div>
              </TmsField>

              <div className="tms-grid tms-grid-3">
                {TEAM_SENDER_SLOTS.map((slot) => (
                  <TmsField key={slot} label={TEAM_SENDER_LABELS[slot]}>
                    <TmsInput
                      aria-label={`Team ${i + 1} ${TEAM_SENDER_LABELS[slot]}`}
                      value={team.senders[slot]}
                      onChange={(e) => update(i, { senders: { ...team.senders, [slot]: e.target.value } })}
                      placeholder="desk@bcatcorp.com"
                    />
                  </TmsField>
                ))}
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 20 }}>
                <CheckRow
                  ariaLabel={`Team ${i + 1} shows contact on tracking`}
                  label={<>Print this desk&rsquo;s contact on the tracking page</>}
                  checked={team.showContactOnTracking}
                  onChange={(v) => update(i, { showContactOnTracking: v })}
                />
                <CheckRow
                  ariaLabel={`Team ${i + 1} active`}
                  label="Active"
                  checked={team.active}
                  onChange={(v) => update(i, { active: v })}
                />
              </div>
            </Panel>
          ))}

          <div>
            <TmsButton
              size="sm"
              onClick={() => setTeams((prev) => [...prev, {
                key: '', name: '', memberIds: [], senders: { ...BLANK_SENDERS }, showContactOnTracking: false, active: true,
              }])}
            >
              <Plus size={14} /> Add team
            </TmsButton>
          </div>

          <Hint>Sender addresses are stored now and used once e-mail sending is wired — the dev account&rsquo;s SES denies sending.</Hint>

          {error && <ErrorText>{error}</ErrorText>}
          <div>
            <TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>
              <Save size={14} /> Save teams
            </TmsButton>
          </div>
        </Stack>
      )}
    </SettingsCard>
  )
}
