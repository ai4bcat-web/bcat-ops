/**
 * Documents & delivery: the house rules for the paperwork side of a shipment.
 *
 * Two of these are switches that decide whether e-mail leaves the building at all —
 * milestone notices and the automatic POD request — and they are off until somebody
 * turns them on, because a customer who has never been told we e-mail them should not
 * start receiving mail because a feature shipped. Both templates have to carry `{url}`
 * or the recipient gets a message telling them to upload with nothing to upload to, so
 * that is checked here rather than discovered by a carrier at a dock.
 *
 * Blank boxes mean "use the house default" throughout, the same as the tracking card.
 */
import { useEffect, useState } from 'react'
import { FileCheck2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsInput, TmsTextarea } from '@/features/tms/kit'
import { getTmsSettings, saveDocumentSettings } from '@/lib/apiClient'
import { DocumentTypesField } from '@/features/documents/DocumentTypesField'
import {
  CARRIER_UPLOADABLE_TYPES, DEFAULT_UPLOAD_LINK_EXPIRY_DAYS,
  MAX_UPLOAD_LINK_EXPIRY_DAYS, MIN_UPLOAD_LINK_EXPIRY_DAYS,
} from '@/lib/shipmentDocuments'
import { DEFAULT_MILESTONE_TEMPLATE, DEFAULT_POD_REQUEST_TEMPLATE, templateHasUrl } from '@/lib/shipmentNotices'
import type { TmsSettings } from '@/types/tms'
import { CheckRow, ErrorText, Hint, Loading, SettingsCard, Stack } from './settingsKit'

/** Blank means "use the house default", so an empty box is not an error. */
function parseWhole(text: string, label: string, min: number, max: number): number | null {
  const raw = text.trim()
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number between ${min} and ${max}`)
  return n
}

export function DocumentSettingsCard() {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [milestoneNotices, setMilestoneNotices] = useState(false)
  const [podRequest, setPodRequest] = useState(false)
  const [uploadTypes, setUploadTypes] = useState<string[]>([])
  const [expiryDays, setExpiryDays] = useState('')
  const [milestoneTemplate, setMilestoneTemplate] = useState('')
  const [podTemplate, setPodTemplate] = useState('')
  const [bolTerms, setBolTerms] = useState('')
  const [deleteAdminOnly, setDeleteAdminOnly] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    getTmsSettings()
      .then((s) => {
        setSettings(s)
        setMilestoneNotices(s?.milestoneNoticesEnabled === true)
        setPodRequest(s?.podRequestEnabled === true)
        setUploadTypes(s?.requiredCarrierUploadTypes ?? [])
        setExpiryDays(s?.uploadLinkExpiryDays != null ? String(s.uploadLinkExpiryDays) : '')
        setMilestoneTemplate(s?.milestoneEmailTemplate ?? '')
        setPodTemplate(s?.podRequestEmailTemplate ?? '')
        setBolTerms(s?.bolTerms ?? '')
        // Voiding is admin-only unless somebody deliberately opened it up.
        setDeleteAdminOnly(s?.documentDeleteAdminOnly !== false)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const save = async () => {
    setError(null)

    let patch: Parameters<typeof saveDocumentSettings>[0]
    try {
      const milestone = milestoneTemplate.trim()
      if (milestone && !templateHasUrl(milestone)) {
        throw new Error('The milestone e-mail must contain {url} — without it the customer gets no tracking link')
      }
      const pod = podTemplate.trim()
      if (pod && !templateHasUrl(pod)) {
        throw new Error('The POD request must contain {url} — without it the carrier has nowhere to upload')
      }
      patch = {
        milestoneNoticesEnabled: milestoneNotices,
        podRequestEnabled: podRequest,
        // Nothing ticked means the house list, not "ask the carrier for nothing".
        requiredCarrierUploadTypes: uploadTypes.length > 0 ? uploadTypes : null,
        uploadLinkExpiryDays: parseWhole(
          expiryDays, 'Upload link expiry', MIN_UPLOAD_LINK_EXPIRY_DAYS, MAX_UPLOAD_LINK_EXPIRY_DAYS,
        ),
        milestoneEmailTemplate: milestone || null,
        podRequestEmailTemplate: pod || null,
        bolTerms: bolTerms.trim() || null,
        documentDeleteAdminOnly: deleteAdminOnly,
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Those settings are not valid')
      return
    }

    setSaving(true)
    try {
      const updated = await saveDocumentSettings(patch, settings?.updatedAt ?? undefined)
      setSettings(updated)
      toast.success('Document settings saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <SettingsCard
      icon={FileCheck2}
      title="Documents & delivery"
      description="What a carrier is asked to upload, how long their link lives, what the two automatic e-mails say, and who may void a document. Leave a box blank to use the house default."
    >
      {loading ? <Loading /> : (
        <Stack>
          <Stack gap={8}>
            <CheckRow
              ariaLabel="Milestone notices enabled"
              label="Send milestone e-mails to customers"
              checked={milestoneNotices}
              onChange={setMilestoneNotices}
            />
            <Hint>A customer still has to be subscribed on their own record; this switch only decides whether any of it goes out.</Hint>
            <CheckRow
              ariaLabel="POD request enabled"
              label="Ask the carrier for paperwork when their load delivers"
              checked={podRequest}
              onChange={setPodRequest}
            />
            <CheckRow
              ariaLabel="Document delete admin only"
              label="Only an admin may void a document"
              checked={deleteAdminOnly}
              onChange={setDeleteAdminOnly}
            />
          </Stack>

          <DocumentTypesField
            label="What a carrier upload link asks for"
            value={uploadTypes}
            onChange={setUploadTypes}
            disabled={saving}
            options={CARRIER_UPLOADABLE_TYPES}
            help="Leave every box clear for the house default: proof of delivery and the carrier's invoice."
          />

          <div className="tms-grid tms-grid-4">
            <TmsField label="Upload link expiry (days)">
              <TmsInput
                aria-label="Upload link expiry days"
                value={expiryDays}
                onChange={(e) => setExpiryDays(e.target.value)}
                placeholder={String(DEFAULT_UPLOAD_LINK_EXPIRY_DAYS)}
              />
            </TmsField>
          </div>

          <TmsField
            label="Milestone e-mail"
            hint={<>{'{number}'}, {'{milestone}'} and {'{url}'} are filled in. {'{url}'} is required.</>}
          >
            <TmsTextarea
              aria-label="Milestone email template"
              rows={3}
              value={milestoneTemplate}
              onChange={(e) => setMilestoneTemplate(e.target.value)}
              placeholder={DEFAULT_MILESTONE_TEMPLATE}
            />
          </TmsField>

          <TmsField
            label="Paperwork request to the carrier"
            hint={<>{'{loadNumber}'} and {'{url}'} are filled in. {'{url}'} is required.</>}
          >
            <TmsTextarea
              aria-label="POD request email template"
              rows={3}
              value={podTemplate}
              onChange={(e) => setPodTemplate(e.target.value)}
              placeholder={DEFAULT_POD_REQUEST_TEMPLATE}
            />
          </TmsField>

          <TmsField label="Bill of lading terms">
            <TmsTextarea
              aria-label="Bill of lading terms"
              rows={3}
              value={bolTerms}
              onChange={(e) => setBolTerms(e.target.value)}
              placeholder="Printed at the foot of every bill of lading this system generates."
            />
          </TmsField>

          {error && <ErrorText>{error}</ErrorText>}
          <div>
            <TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>
              <Save size={14} /> Save document settings
            </TmsButton>
          </div>
        </Stack>
      )}
    </SettingsCard>
  )
}
