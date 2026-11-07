/**
 * The Aljex cutoff: the moment the export was taken. The 24-month import window is
 * counted back from it and nothing after it is imported. Wall time is America/Chicago;
 * stored as the matching UTC instant on TmsSettings.aljexCutoffAt via `SAVE_AR_SETTINGS`.
 */
import { useEffect, useState } from 'react'
import { CalendarClock, Save } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsInput } from '@/features/tms/kit'
import { ErrorText, Loading, SettingsCard, Stack } from '@/features/settings/settingsKit'
import { getTmsSettings, saveArSettings } from '@/lib/apiClient'
import { CUTOFF_ZONE, chicagoLocalToIso, isoToChicagoLocal } from '@/lib/billingSettingsForm'

export function AljexCutoffCard() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [local, setLocal] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getTmsSettings()
      .then((s) => setLocal(isoToChicagoLocal(s?.aljexCutoffAt)))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const iso = chicagoLocalToIso(local)

  const save = async () => {
    setError(null)
    if (!iso) { setError('Enter a valid date and time'); return }
    setSaving(true)
    try {
      await saveArSettings({ aljexCutoffAt: iso })
      toast.success('Aljex cutoff saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the cutoff')
    } finally { setSaving(false) }
  }

  return (
    <SettingsCard
      icon={CalendarClock}
      title="Aljex cutoff"
      description="When the Aljex export was taken. Loads, invoices and bills older than 24 months before this moment are skipped; nothing after it is imported."
      actions={<TmsButton size="sm" onClick={save} disabled={saving || loading}><Save size={13} /> Save</TmsButton>}
    >
      {loading ? <Loading /> : (
        <Stack>
          <TmsField label={`Cutoff (${CUTOFF_ZONE} time)`} hint={iso ? `Stored as ${iso}` : undefined}>
            <TmsInput
              aria-label="Aljex cutoff"
              type="datetime-local"
              value={local}
              onChange={(e) => setLocal(e.target.value)}
            />
          </TmsField>
          {error && <ErrorText>{error}</ErrorText>}
        </Stack>
      )}
    </SettingsCard>
  )
}
