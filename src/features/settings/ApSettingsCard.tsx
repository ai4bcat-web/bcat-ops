/**
 * Carrier bills & AP: the house rules every bill is approved and paid under.
 *
 * Two of these are permissions rather than preferences. Approval is the review stage —
 * the moment somebody agrees the carrier's number is our number — and posting is money
 * leaving: payment, credit, reversal and void. Both default to owner/ADMIN, and the
 * Lambda enforces them whatever this card says; the boxes only open them up deliberately.
 *
 * The remittance body is refused here when it has no `{reference}`, through the same
 * `templateHasReference` that `SEND_REMITTANCE` falls back on — a remittance the
 * carrier's AP clerk cannot match to a deposit is not one worth sending.
 *
 * The bill-document list is what a bill needs on file before it can be approved; leaving
 * every box clear keeps it tied to whatever the carrier upload link already asks for,
 * so the two cannot drift apart.
 */
import { useEffect, useState } from 'react'
import { Banknote, Save } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsTextarea } from '@/features/tms/kit'
import { DocumentTypesField } from '@/features/documents/DocumentTypesField'
import { getTmsSettings, saveApSettings } from '@/lib/apiClient'
import { CARRIER_UPLOADABLE_TYPES } from '@/lib/shipmentDocuments'
import { DEFAULT_REMITTANCE_EMAIL_TEMPLATE, templateHasReference } from '@/lib/shipmentNotices'
import type { TmsSettings } from '@/types/tms'
import { CheckRow, ErrorText, Hint, Loading, SettingsCard, Stack } from './settingsKit'

export function ApSettingsCard() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [approvalAdminOnly, setApprovalAdminOnly] = useState(true)
  const [postingAdminOnly, setPostingAdminOnly] = useState(true)
  const [requireSignedRateCon, setRequireSignedRateCon] = useState(true)
  const [billDocs, setBillDocs] = useState<string[]>([])
  const [remittanceTemplate, setRemittanceTemplate] = useState('')
  const [error, setError] = useState<string | null>(null)

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    getTmsSettings()
      .then((s: TmsSettings | null) => {
        // Approving and posting are admin-only unless somebody opened them up.
        setApprovalAdminOnly(s?.apApprovalAdminOnly !== false)
        setPostingAdminOnly(s?.apPostingAdminOnly !== false)
        setRequireSignedRateCon(s?.apRequireSignedRateCon !== false)
        setBillDocs(s?.apBillDocsRequired ?? [])
        setRemittanceTemplate(s?.remittanceEmailTemplate ?? '')
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const save = async () => {
    setError(null)
    const body = remittanceTemplate.trim()
    if (body && !templateHasReference(body)) {
      setError('The remittance e-mail must contain {reference} — without it the carrier cannot match the deposit')
      return
    }

    setSaving(true)
    try {
      await saveApSettings({
        apApprovalAdminOnly: approvalAdminOnly,
        apPostingAdminOnly: postingAdminOnly,
        apRequireSignedRateCon: requireSignedRateCon,
        // Nothing ticked means "whatever the carrier upload link asks for", not "nothing".
        apBillDocsRequired: billDocs.length > 0 ? billDocs : null,
        remittanceEmailTemplate: body || null,
      })
      toast.success('AP settings saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <SettingsCard
      icon={Banknote}
      title="Carrier bills & AP"
      description="Who may approve a bill, who may send money, what a bill needs on file before it is approved, and what the remittance says."
    >
      {loading ? <Loading /> : (
        <Stack>
          <Stack gap={8}>
            <CheckRow
              ariaLabel="AP approval admin only"
              align="start"
              label="Only an admin may approve a bill for payment"
              checked={approvalAdminOnly}
              onChange={setApprovalAdminOnly}
            />
            <CheckRow
              ariaLabel="AP posting admin only"
              align="start"
              label="Only an admin may pay, credit, reverse or void"
              checked={postingAdminOnly}
              onChange={setPostingAdminOnly}
            />
            <CheckRow
              ariaLabel="Require signed rate confirmation"
              align="start"
              label="A rate confirmation must be signed before the bill is approved"
              checked={requireSignedRateCon}
              onChange={setRequireSignedRateCon}
            />
            <Hint>An unsigned rate con blocks a rep outright; an admin may approve past it and the acknowledgement is kept on the bill.</Hint>
          </Stack>

          <DocumentTypesField
            label="Documents a bill needs before approval"
            value={billDocs}
            onChange={setBillDocs}
            disabled={saving}
            options={CARRIER_UPLOADABLE_TYPES}
            help="Leave every box clear to follow whatever the carrier upload link already asks for. An admin can still approve past a missing document, with a written note."
          />

          <TmsField
            label="Remittance e-mail"
            hint={<>{'{reference}'}, {'{carrier}'}, {'{total}'}, {'{date}'} and {'{method}'} are filled in. {'{reference}'} is required.</>}
          >
            <TmsTextarea
              aria-label="Remittance email template"
              rows={3}
              value={remittanceTemplate}
              onChange={(e) => setRemittanceTemplate(e.target.value)}
              placeholder={DEFAULT_REMITTANCE_EMAIL_TEMPLATE}
            />
          </TmsField>

          {error && <ErrorText>{error}</ErrorText>}
          <div>
            <TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>
              <Save size={14} /> Save AP settings
            </TmsButton>
          </div>
        </Stack>
      )}
    </SettingsCard>
  )
}
