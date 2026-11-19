/**
 * Where the Chase ACH file comes from: company name, the 10-digit company ID, a Chase routing number and the entry
 * class. None of it is a bank secret, but it decides whose name a payment shows under, so only the owner and
 * ADMINs may save it (the Lambda enforces that whatever this card shows).
 */
import { useEffect, useState } from 'react'
import { Landmark, Save } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { getTmsSettings, saveChaseAchSettings } from '@/lib/apiClient'
import { useAuth } from '@/hooks/useAuth'
import { isValidRoutingNumber } from '@/lib/abaRouting'
import { ErrorText, Hint, Loading, SettingsCard, Stack } from './settingsKit'

/** Chase's own routing numbers from the ACH upload specification (any one works). */
const CHASE_ROUTING = [
  '021000021', '044000037', '072000326', '083000137', '074000010', '072412927', '071000013', '075000019',
  '111000614', '102001017', '065400137', '122100024', '124001545', '103000648', '325070760', '322271627',
]

export function ChaseAchSettingsCard() {
  const { isAdmin } = useAuth()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [companyName, setCompanyName] = useState('')
  const [companyId, setCompanyId] = useState('')
  const [odfiRouting, setOdfiRouting] = useState('021000021')
  const [secCode, setSecCode] = useState<'CCD' | 'PPD'>('CCD')
  const [entryDescription, setEntryDescription] = useState('CARRIERPAY')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getTmsSettings()
      .then((s) => {
        const c = s?.chaseAch
        if (!c) return
        setCompanyName(c.companyName ?? '')
        setCompanyId(c.companyId ?? '')
        setOdfiRouting(c.odfiRouting ?? '021000021')
        setSecCode(c.secCode === 'PPD' ? 'PPD' : 'CCD')
        setEntryDescription(c.entryDescription ?? 'CARRIERPAY')
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  if (!isAdmin) return null

  const save = async () => {
    setError(null)
    if (!companyName.trim()) { setError('Enter the company name as it should appear on the file.'); return }
    if (!/^\d{10}$/.test(companyId.trim())) { setError('The company ID must be exactly 10 digits.'); return }
    if (!CHASE_ROUTING.includes(odfiRouting) || !isValidRoutingNumber(odfiRouting)) { setError('Choose one of the Chase routing numbers in the list.'); return }
    setSaving(true)
    try {
      await saveChaseAchSettings({ companyName: companyName.trim(), companyId: companyId.trim(), odfiRouting, secCode, entryDescription: entryDescription.trim() || 'CARRIERPAY' })
      toast.success('Chase file settings saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <SettingsCard
      icon={Landmark}
      title="Chase ACH file"
      description="The company details Chase needs at the top of the ACH file the Selected tab exports for carriers paid by ACH. You upload the file at chase.com yourself."
    >
      {loading ? <Loading /> : (
        <Stack>
          <TmsField label="Company name" hint="Shown to the carrier's bank. Up to 16 characters appear in the batch header.">
            <TmsInput aria-label="Chase company name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} maxLength={23} />
          </TmsField>
          <TmsField label="Company ID (10 digits)" hint="Any 10-digit number that identifies BCAT on the file. Chase's setup screen shows the one on your ACH agreement.">
            <TmsInput aria-label="Chase company ID" value={companyId} onChange={(e) => setCompanyId(e.target.value.replace(/\D/g, ''))} maxLength={10} inputMode="numeric" />
          </TmsField>
          <TmsField label="Chase routing number" hint="Any one of Chase's routing numbers works for the file header.">
            <TmsSelect aria-label="Chase routing number" value={odfiRouting} onChange={(e) => setOdfiRouting(e.target.value)}>
              {CHASE_ROUTING.map((r) => <option key={r} value={r}>{r}</option>)}
            </TmsSelect>
          </TmsField>
          <TmsField label="Entry class">
            <TmsSelect aria-label="Entry class" value={secCode} onChange={(e) => setSecCode(e.target.value as 'CCD' | 'PPD')}>
              <option value="CCD">CCD (business payees)</option>
              <option value="PPD">PPD</option>
            </TmsSelect>
          </TmsField>
          <TmsField label="Entry description" hint="Up to 10 characters, shown on the carrier's statement. Not PAYROLL.">
            <TmsInput aria-label="Entry description" value={entryDescription} onChange={(e) => setEntryDescription(e.target.value.toUpperCase())} maxLength={10} />
          </TmsField>
          <Hint>Your Chase funding account is chosen at upload; it is not stored here.</Hint>
          {error && <ErrorText>{error}</ErrorText>}
          <div>
            <TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>
              <Save size={14} /> Save Chase file settings
            </TmsButton>
          </div>
        </Stack>
      )}
    </SettingsCard>
  )
}
