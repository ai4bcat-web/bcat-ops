/**
 * Carrier-document templates: the rate confirmation that goes out for signature,
 * and the carrier agreement that lives on the carrier record.
 *
 * This card owns `rateConTemplate` and `carrierAgreementTemplate` on `TmsSettings`
 * and sends both on every save.
 */
import { useEffect, useState } from 'react'
import { FileText, Plus, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsIconButton, TmsInput, TmsTextarea } from '@/features/tms/kit'
import { getTmsSettings, saveTmsSettings } from '@/lib/apiClient'
import type { CarrierAgreementTemplate, RateConTemplate, TmsSettings } from '@/types/tms'
import { CheckRow, ErrorText, GroupLabel, Hint, Loading, Panel, SettingsCard, Stack } from './settingsKit'
import { CheckGroup } from './checkGroupUtils'
import { pick, toggle } from './settingsUtils'
import { CARRIER_DOC_TYPES, CARRIER_DOC_LABELS, RATE_CON_FIELDS, RATE_CON_FIELD_LABELS } from './carrierSettingsConstants'

export function CarrierDocumentsCard() {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [rateCon, setRateCon] = useState<RateConTemplate>({})
  const [agreement, setAgreement] = useState<CarrierAgreementTemplate>({})

  useEffect(() => {
    getTmsSettings()
      .then((s) => {
        setSettings(s)
        setRateCon(s?.rateConTemplate ?? {})
        setAgreement(s?.carrierAgreementTemplate ?? {})
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const updateRateCon = (patch: Partial<RateConTemplate>) => {
    setRateCon((prev) => ({ ...prev, ...patch }))
  }

  const updateAgreement = (patch: Partial<CarrierAgreementTemplate>) => {
    setAgreement((prev) => ({ ...prev, ...patch }))
  }

  const updateTerm = (index: number, patch: Partial<{ title: string; text: string }>) => {
    setRateCon((prev) => ({
      ...prev,
      extraTerms: (prev.extraTerms ?? []).map((term, i) => (i === index ? { ...term, ...patch } : term)),
    }))
  }

  const addTerm = () => {
    setRateCon((prev) => ({ ...prev, extraTerms: [...(prev.extraTerms ?? []), { title: '', text: '' }] }))
  }

  const removeTerm = (index: number) => {
    setRateCon((prev) => ({ ...prev, extraTerms: (prev.extraTerms ?? []).filter((_, i) => i !== index) }))
  }

  const save = async () => {
    setError(null)

    const rateConOut: RateConTemplate | null = {
      overrideDefaultTerms: rateCon.overrideDefaultTerms ?? null,
      extraTerms: rateCon.extraTerms?.length ? rateCon.extraTerms : null,
      termsHtml: rateCon.termsHtml?.trim() || null,
      hideRep: rateCon.hideRep ?? null,
      legalPageBreak: rateCon.legalPageBreak ?? null,
      requiredDocs: rateCon.requiredDocs?.length ? rateCon.requiredDocs : null,
      requiredFields: rateCon.requiredFields?.length ? rateCon.requiredFields : null,
    }
    const hasRateCon = Object.values(rateConOut).some((v) => v !== null && !(Array.isArray(v) && v.length === 0))

    const agreementOut: CarrierAgreementTemplate | null = {
      bodyMarkdown: agreement.bodyMarkdown?.trim() || null,
      requiredDocs: agreement.requiredDocs?.length ? agreement.requiredDocs : null,
      signatureBlock: agreement.signatureBlock?.trim() || null,
      version: agreement.version ?? null,
      updatedAt: agreement.updatedAt ?? null,
      updatedBy: agreement.updatedBy ?? null,
    }
    const hasAgreement = Object.values(agreementOut).some((v) => v !== null && !(Array.isArray(v) && v.length === 0))

    setSaving(true)
    try {
      const updated = await saveTmsSettings({
        rateConTemplate: hasRateCon ? rateConOut : null,
        carrierAgreementTemplate: hasAgreement ? agreementOut : null,
      }, settings?.updatedAt ?? undefined)
      setSettings(updated)
      toast.success('Carrier document templates saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <SettingsCard
      icon={FileText}
      title="Carrier documents"
      description="Terms, required paperwork and signature blocks for rate confirmations and carrier agreements."
    >
      {loading ? <Loading /> : (
        <Stack>
          <Panel>
            <GroupLabel>Rate confirmation template</GroupLabel>
            <Stack gap={6}>
              <CheckRow
                label="Override the default terms with the HTML and extra terms below"
                checked={rateCon.overrideDefaultTerms === true}
                onChange={(checked) => updateRateCon({ overrideDefaultTerms: checked })}
              />
              <CheckRow
                label="Hide the broker rep on the rate con"
                checked={rateCon.hideRep === true}
                onChange={(checked) => updateRateCon({ hideRep: checked })}
              />
              <CheckRow
                label="Force a legal page break before the signature block"
                checked={rateCon.legalPageBreak === true}
                onChange={(checked) => updateRateCon({ legalPageBreak: checked })}
              />
            </Stack>

            <Stack gap={6}>
              <GroupLabel>Extra terms</GroupLabel>
              {rateCon.extraTerms?.length === 0 && <Hint>No extra terms yet.</Hint>}
              {(rateCon.extraTerms ?? []).map((term, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2rem', gap: 8, alignItems: 'center' }}>
                  <TmsInput
                    aria-label={`Extra term ${i + 1} title`}
                    value={term.title}
                    onChange={(e) => updateTerm(i, { title: e.target.value })}
                    placeholder="Term title"
                  />
                  <TmsInput
                    aria-label={`Extra term ${i + 1} text`}
                    value={term.text}
                    onChange={(e) => updateTerm(i, { text: e.target.value })}
                    placeholder="Term text"
                  />
                  <TmsIconButton shape="plain" aria-label={`Remove extra term ${i + 1}`} onClick={() => removeTerm(i)}>
                    <Trash2 size={14} />
                  </TmsIconButton>
                </div>
              ))}
              <div>
                <TmsButton size="sm" onClick={addTerm}>
                  <Plus size={14} /> Add term
                </TmsButton>
              </div>
            </Stack>

            <TmsField label="Terms HTML" hint="Sanitised server-side to a small tag whitelist.">
              <TmsTextarea value={rateCon.termsHtml ?? ''} onChange={(e) => updateRateCon({ termsHtml: e.target.value })} rows={6} />
            </TmsField>

            <Stack gap={6}>
              <GroupLabel>Required documents</GroupLabel>
              <CheckGroup
                name="rate-con-doc"
                options={CARRIER_DOC_TYPES}
                label={(d) => CARRIER_DOC_LABELS[d]}
                selected={pick(rateCon.requiredDocs, CARRIER_DOC_TYPES)}
                onToggle={(d) => updateRateCon({ requiredDocs: toggle(pick(rateCon.requiredDocs, CARRIER_DOC_TYPES), d) })}
              />
            </Stack>

            <Stack gap={6}>
              <GroupLabel>Required signing fields</GroupLabel>
              <CheckGroup
                name="rate-con-field"
                options={RATE_CON_FIELDS}
                label={(f) => RATE_CON_FIELD_LABELS[f]}
                selected={pick(rateCon.requiredFields, RATE_CON_FIELDS)}
                onToggle={(f) => updateRateCon({ requiredFields: toggle(pick(rateCon.requiredFields, RATE_CON_FIELDS), f) })}
              />
            </Stack>
          </Panel>

          <Panel>
            <GroupLabel>Carrier agreement template</GroupLabel>
            <TmsField label="Agreement body (Markdown)">
              <TmsTextarea value={agreement.bodyMarkdown ?? ''} onChange={(e) => updateAgreement({ bodyMarkdown: e.target.value })} rows={10} />
            </TmsField>

            <Stack gap={6}>
              <GroupLabel>Required documents</GroupLabel>
              <CheckGroup
                name="agreement-doc"
                options={CARRIER_DOC_TYPES}
                label={(d) => CARRIER_DOC_LABELS[d]}
                selected={pick(agreement.requiredDocs, CARRIER_DOC_TYPES)}
                onToggle={(d) => updateAgreement({ requiredDocs: toggle(pick(agreement.requiredDocs, CARRIER_DOC_TYPES), d) })}
              />
            </Stack>

            <TmsField label="Signature block" hint="Rendered below the agreement body.">
              <TmsTextarea value={agreement.signatureBlock ?? ''} onChange={(e) => updateAgreement({ signatureBlock: e.target.value })} rows={4} />
            </TmsField>

            <div className="tms-field-hint">
              Version {agreement.version ?? '—'} {agreement.updatedAt ? `· updated ${new Date(agreement.updatedAt).toLocaleString()}` : ''}
            </div>
          </Panel>

          {error && <ErrorText>{error}</ErrorText>}
          <div>
            <TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>
              <Save size={14} /> Save carrier documents
            </TmsButton>
          </div>
        </Stack>
      )}
    </SettingsCard>
  )
}
