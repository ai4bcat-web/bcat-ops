/**
 * Postal-code aliases: the ZIPs whose city and state the house writes one way, whoever
 * typed them. A lane is keyed on city/state, so two spellings of the same place read as
 * two lanes; an alias row folds them back into one.
 *
 * Two writers pass them to `laneKeyFor`: the quote save and the carrier offer row. A
 * lane key written from now on folds the aliased ZIP in; lane history already stored
 * keeps the city it was written with, and nothing sweeps it. `laneKey3` is ZIP-3 based
 * and is unaffected either way. The card says exactly that, and claims nothing else.
 */
import { useEffect, useState } from 'react'
import { MapPin, Plus, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsIconButton, TmsInput } from '@/features/tms/kit'
import { getTmsSettings, saveTmsSettings } from '@/lib/apiClient'
import type { PostalAlias } from '@/lib/integrations/postalAliases'
import type { TmsSettings } from '@/types/tms'
import { ErrorText, Hint, Loading, SettingsCard, Stack } from './settingsKit'

/** The three columns of an alias row, header and body alike. */
const ROW_COLUMNS = { gridTemplateColumns: '7rem minmax(0, 1fr) 5rem 2rem', alignItems: 'center' } as const

const ZIP = /^\d{5}$/
const STATE = /^[A-Z]{2}$/

/** A row as it is edited; nothing is normalised until the save. */
interface AliasRow {
  zip: string
  city: string
  state: string
}

export function PostalCodeAliasesCard() {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [rows, setRows] = useState<AliasRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    getTmsSettings()
      .then((s: TmsSettings | null) => {
        setSettings(s)
        setRows((s?.postalCodeAliases ?? []).map((a) => ({ zip: a.zip, city: a.city, state: a.state })))
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const update = (index: number, patch: Partial<AliasRow>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const save = async () => {
    setError(null)
    const postalCodeAliases: PostalAlias[] = []
    const seen = new Set<string>()
    for (const [i, row] of rows.entries()) {
      const zip = row.zip.trim()
      const city = row.city.trim()
      const state = row.state.trim().toUpperCase()
      if (!ZIP.test(zip)) { setError(`Alias ${i + 1} needs a five-digit ZIP`); return }
      if (!city) { setError(`Alias ${zip} needs a city`); return }
      if (!STATE.test(state)) { setError(`Alias ${zip} needs a two-letter state`); return }
      if (seen.has(zip)) { setError(`ZIP ${zip} is aliased twice`); return }
      seen.add(zip)
      postalCodeAliases.push({ zip, city, state })
    }

    setSaving(true)
    try {
      const updated = await saveTmsSettings({ postalCodeAliases }, settings?.updatedAt ?? undefined)
      setSettings(updated)
      toast.success('Postal code aliases saved')
    } catch (e) {
      // The Lambda's own sentence, verbatim — it refuses for reasons this card cannot see.
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <SettingsCard
      icon={MapPin}
      title="Postal code aliases"
      description="The city and state this brokerage calls a ZIP, whatever a rate con spells it. One row per ZIP."
    >
      {loading ? <Loading /> : (
        <Stack>
          {rows.length === 0 && <Hint>No aliases yet.</Hint>}

          {rows.length > 0 && (
            <div className="tms-grid tms-field-label" style={{ ...ROW_COLUMNS, gap: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              <div>ZIP</div>
              <div>City</div>
              <div>State</div>
              <div />
            </div>
          )}

          {rows.map((row, i) => (
            <div key={i} className="tms-grid" style={{ ...ROW_COLUMNS, gap: 8 }}>
              <TmsInput
                aria-label={`Alias ${i + 1} ZIP`}
                inputMode="numeric"
                value={row.zip}
                onChange={(e) => update(i, { zip: e.target.value })}
                placeholder="60601"
              />
              <TmsInput
                aria-label={`Alias ${i + 1} city`}
                value={row.city}
                onChange={(e) => update(i, { city: e.target.value })}
                placeholder="Chicago"
              />
              <TmsInput
                aria-label={`Alias ${i + 1} state`}
                value={row.state}
                onChange={(e) => update(i, { state: e.target.value.toUpperCase() })}
                placeholder="IL"
              />
              <TmsIconButton
                shape="plain"
                aria-label={`Remove alias ${i + 1}`}
                onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
              >
                <Trash2 size={14} />
              </TmsIconButton>
            </div>
          ))}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <TmsButton size="sm" onClick={() => setRows((prev) => [...prev, { zip: '', city: '', state: '' }])}>
              <Plus size={14} /> Add alias
            </TmsButton>
            <Hint>From now on a new quote or carrier offer keys its lane through these aliases. Lane history already stored is not rewritten.</Hint>
          </div>

          {error && <ErrorText>{error}</ErrorText>}
          <div>
            <TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>
              <Save size={14} /> Save postal code aliases
            </TmsButton>
          </div>
        </Stack>
      )}
    </SettingsCard>
  )
}
