/**
 * Invoices > always-copy list: addresses copied (cc) on every manually sent invoice, in
 * addition to the customer's own copy list. Company-wide; saved through the finance
 * `SAVE_AR_SETTINGS` action (admin-only on the Lambda side).
 */
import { useEffect, useState } from 'react'
import { Copy, Save } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsTextarea } from '@/features/tms/kit'
import { getTmsSettings, saveArSettings } from '@/lib/apiClient'
import { alwaysCopyForForm, parseEmailList } from '@/lib/billingSettingsForm'
import { ErrorText, Loading, SettingsCard, Stack } from './settingsKit'

export function InvoiceCopyCard() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getTmsSettings()
      .then((s) => setText(alwaysCopyForForm(s?.invoiceAlwaysCopyEmails)))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const { emails, invalid } = parseEmailList(text)

  const save = async () => {
    setError(null)
    if (invalid.length > 0) { setError(`Not an e-mail address: ${invalid.join(', ')}`); return }
    setSaving(true)
    try {
      await saveArSettings({ invoiceAlwaysCopyEmails: emails })
      setText(emails.join('\n'))
      toast.success('Invoice copy list saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <SettingsCard
      icon={Copy}
      title="Always-copy invoice e-mails"
      description="These addresses are copied on every invoice e-mail sent from the system, on top of each customer's own copy list."
      actions={<TmsButton size="sm" onClick={save} disabled={saving || loading}><Save size={13} /> Save</TmsButton>}
    >
      {loading ? <Loading /> : (
        <Stack>
          <TmsField label="Always copy" hint="One address per line (commas also work). Duplicates are dropped; leave empty to copy nobody.">
            <TmsTextarea
              aria-label="Always-copy invoice e-mails"
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </TmsField>
          {error && <ErrorText>{error}</ErrorText>}
        </Stack>
      )}
    </SettingsCard>
  )
}
