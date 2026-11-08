/**
 * Customer-facing defaults: how the customer portal quotes LTL, what statuses it
 * shows, which LTL carriers are hidden, the default quote notes, and the tag
 * vocabulary used to label customers.
 *
 * The card owns `customerPortalDefaults` and `customerTags` on `TmsSettings` and
 * sends both on every save, so edits here never erase fields in other cards.
 */
import { useEffect, useMemo, useState } from 'react'
import { Plus, Save, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsIconButton, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { getTmsSettings, saveTmsSettings } from '@/lib/apiClient'
import { SHIPMENT_STATUSES, SHIPMENT_STATUS_LABELS } from '@/lib/shipmentStatus'
import type { CustomerPortalDefaults, CustomerTag, TmsSettings } from '@/types/tms'
import { ErrorText, GroupLabel, Hint, Loading, Panel, SettingsCard, Stack } from './settingsKit'
import { CheckGroup } from './checkGroupUtils'
import { pick, toggle } from './settingsUtils'

const LTL_QUOTING_OPTIONS: { value: NonNullable<CustomerPortalDefaults['ltlQuoting']>; label: string }[] = [
  { value: 'OFF', label: 'Off' },
  { value: 'RATE_CARD', label: 'Rate card' },
  { value: 'SMC3', label: 'SMC3' },
]

const PORTAL_DISPATCH_OPTIONS: { value: NonNullable<CustomerPortalDefaults['portalDispatchMode']>; label: string }[] = [
  { value: 'OFF', label: 'Off' },
  { value: 'QUOTE_ONLY', label: 'Quote only' },
  { value: 'FULL', label: 'Full' },
]

const TAG_COLORS: { value: string; label: string; cssVar: string }[] = [
  { value: 'blue', label: 'Blue', cssVar: 'var(--tms-badge-blue)' },
  { value: 'green', label: 'Green', cssVar: 'var(--tms-badge-green)' },
  { value: 'orange', label: 'Orange', cssVar: 'var(--tms-badge-orange)' },
  { value: 'pink', label: 'Pink', cssVar: 'var(--tms-badge-pink)' },
  { value: 'purple', label: 'Purple', cssVar: 'var(--tms-badge-purple)' },
  { value: 'red', label: 'Red', cssVar: 'var(--tms-badge-red)' },
  { value: 'turquoise', label: 'Turquoise', cssVar: 'var(--tms-badge-turquoise)' },
  { value: 'gray', label: 'Gray', cssVar: 'var(--tms-badge-gray)' },
]

const TAG_KEY_RE = /^[A-Z0-9_-]{1,24}$/i

export function CustomerSettingsCard() {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [defaults, setDefaults] = useState<CustomerPortalDefaults>({})
  const [blockedCarriersText, setBlockedCarriersText] = useState('')
  const [tags, setTags] = useState<CustomerTag[]>([])

  useEffect(() => {
    getTmsSettings()
      .then((s) => {
        setSettings(s)
        const d = s?.customerPortalDefaults ?? {}
        setDefaults(d)
        setBlockedCarriersText((d.blockedLtlCarrierIds ?? []).join('\n'))
        setTags(s?.customerTags ?? [])
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const blockedCarrierIds = useMemo(
    () => blockedCarriersText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    [blockedCarriersText],
  )

  const updateDefault = (patch: Partial<CustomerPortalDefaults>) => {
    setDefaults((prev) => ({ ...prev, ...patch }))
  }

  const updateTag = (index: number, patch: Partial<CustomerTag>) => {
    setTags((prev) => prev.map((tag, i) => (i === index ? { ...tag, ...patch } : tag)))
  }

  const save = async () => {
    setError(null)

    const seen = new Set<string>()
    for (const [i, tag] of tags.entries()) {
      const key = tag.key.trim()
      if (!key) { setError(`Tag ${i + 1} needs a key`); return }
      if (!TAG_KEY_RE.test(key)) { setError(`Tag key "${key}" may only use letters, numbers, underscores and dashes (1–24 characters)`); return }
      if (seen.has(key.toLowerCase())) { setError(`Tag key "${key}" is used more than once`); return }
      seen.add(key.toLowerCase())
      if (!tag.label.trim()) { setError(`Tag "${key}" needs a label`); return }
      if (!tag.color) { setError(`Tag "${key}" needs a color`); return }
    }

    const portalDefaults: CustomerPortalDefaults | null = {
      ltlQuoting: defaults.ltlQuoting ?? null,
      portalDispatchMode: defaults.portalDispatchMode ?? null,
      portalStatusMask: defaults.portalStatusMask?.length ? defaults.portalStatusMask : null,
      blockedLtlCarrierIds: blockedCarrierIds.length ? blockedCarrierIds : null,
      defaultQuoteNotes: defaults.defaultQuoteNotes?.trim() || null,
    }
    const hasAnyDefault = Object.values(portalDefaults).some((v) => v !== null && !(Array.isArray(v) && v.length === 0))

    setSaving(true)
    try {
      const updated = await saveTmsSettings({
        customerPortalDefaults: hasAnyDefault ? portalDefaults : null,
        customerTags: tags.length ? tags.map((t) => ({ key: t.key.trim(), label: t.label.trim(), color: t.color })) : null,
      }, settings?.updatedAt ?? undefined)
      setSettings(updated)
      toast.success('Customer settings saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <SettingsCard
      icon={Users}
      title="Customer settings"
      description="Portal quoting, dispatch, status mask, blocked LTL carriers, default quote notes and the customer tag vocabulary."
    >
      {loading ? <Loading /> : (
        <Stack>
          <Panel>
            <GroupLabel>Portal defaults</GroupLabel>
            <div className="tms-grid tms-grid-2">
              <TmsField label="LTL quoting mode">
                <TmsSelect
                  value={defaults.ltlQuoting ?? ''}
                  onChange={(e) => updateDefault({ ltlQuoting: e.target.value as CustomerPortalDefaults['ltlQuoting'] })}
                  placeholder="— unset —"
                  options={LTL_QUOTING_OPTIONS}
                />
              </TmsField>
              <TmsField label="Portal dispatch mode">
                <TmsSelect
                  value={defaults.portalDispatchMode ?? ''}
                  onChange={(e) => updateDefault({ portalDispatchMode: e.target.value as CustomerPortalDefaults['portalDispatchMode'] })}
                  placeholder="— unset —"
                  options={PORTAL_DISPATCH_OPTIONS}
                />
              </TmsField>
            </div>
            <Stack gap={6}>
              <GroupLabel>Portal status mask</GroupLabel>
              <CheckGroup
                name="portal-status"
                options={SHIPMENT_STATUSES}
                label={(s) => SHIPMENT_STATUS_LABELS[s]}
                selected={pick(defaults.portalStatusMask, SHIPMENT_STATUSES)}
                onToggle={(s) => updateDefault({ portalStatusMask: toggle(pick(defaults.portalStatusMask, SHIPMENT_STATUSES), s) })}
              />
            </Stack>
            <TmsField label="Blocked LTL carriers" hint="One SCAC or carrier id per line.">
              <TmsTextarea value={blockedCarriersText} onChange={(e) => setBlockedCarriersText(e.target.value)} rows={3} />
            </TmsField>
            <TmsField label="Default quote notes">
              <TmsTextarea
                value={defaults.defaultQuoteNotes ?? ''}
                onChange={(e) => updateDefault({ defaultQuoteNotes: e.target.value })}
                rows={3}
              />
            </TmsField>
          </Panel>

          <Panel>
            <GroupLabel>Customer tags</GroupLabel>
            {tags.length === 0 && <Hint>No tags yet.</Hint>}
            {tags.length > 0 && (
              <div
                className="tms-field-label"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '9rem 1fr 7rem 2rem',
                  gap: 8,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '.04em',
                }}
              >
                <div>Key</div>
                <div>Label</div>
                <div>Color</div>
                <div />
              </div>
            )}
            {tags.map((tag, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '9rem 1fr 7rem 2rem', gap: 8, alignItems: 'center' }}>
                <TmsInput
                  aria-label={`Tag ${i + 1} key`}
                  value={tag.key}
                  onChange={(e) => updateTag(i, { key: e.target.value.toUpperCase() })}
                  placeholder="e.g. VIP"
                />
                <TmsInput
                  aria-label={`Tag ${i + 1} label`}
                  value={tag.label}
                  onChange={(e) => updateTag(i, { label: e.target.value })}
                  placeholder="e.g. VIP customer"
                />
                <TmsSelect
                  aria-label={`Tag ${i + 1} color`}
                  value={tag.color}
                  onChange={(e) => updateTag(i, { color: e.target.value })}
                  options={TAG_COLORS.map((c) => ({ value: c.value as string, label: c.label }))}
                />
                <TmsIconButton
                  shape="plain"
                  aria-label={`Remove tag ${i + 1}`}
                  onClick={() => setTags((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Trash2 size={14} />
                </TmsIconButton>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <TmsButton size="sm" onClick={() => setTags((prev) => [...prev, { key: '', label: '', color: TAG_COLORS[0].value as string }])}>
                <Plus size={14} /> Add tag
              </TmsButton>
              <Hint>Keys may use letters, numbers, underscores and dashes.</Hint>
            </div>
          </Panel>

          {error && <ErrorText>{error}</ErrorText>}
          <div>
            <TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>
              <Save size={14} /> Save customer settings
            </TmsButton>
          </div>
        </Stack>
      )}
    </SettingsCard>
  )
}
