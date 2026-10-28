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
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { DocumentTypesField } from '@/features/documents/DocumentTypesField'
import { getTmsSettings, saveApSettings } from '@/lib/apiClient'
import { CARRIER_UPLOADABLE_TYPES } from '@/lib/shipmentDocuments'
import { DEFAULT_REMITTANCE_EMAIL_TEMPLATE, templateHasReference } from '@/lib/shipmentNotices'
import type { TmsSettings } from '@/types/tms'

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
    <div style={{ border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)', padding: 16, boxShadow: 'var(--sh-sm)', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="flex items-center gap-2.5">
        <Banknote size={16} style={{ color: 'var(--ds-t3)' }} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Carrier bills &amp; AP</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>
            Who may approve a bill, who may send money, what a bill needs on file before it is approved, and what the remittance says.
          </div>
        </div>
      </div>

      {loading ? <div className="text-sm text-muted-foreground">Loading…</div> : (
        <div className="space-y-3">
          <div className="space-y-2">
            <label className="flex items-start gap-2.5 text-sm" style={{ color: 'var(--ds-t2)' }}>
              <Checkbox
                aria-label="AP approval admin only"
                checked={approvalAdminOnly}
                onCheckedChange={(v) => setApprovalAdminOnly(v === true)}
              />
              Only an admin may approve a bill for payment
            </label>
            <label className="flex items-start gap-2.5 text-sm" style={{ color: 'var(--ds-t2)' }}>
              <Checkbox
                aria-label="AP posting admin only"
                checked={postingAdminOnly}
                onCheckedChange={(v) => setPostingAdminOnly(v === true)}
              />
              Only an admin may pay, credit, reverse or void
            </label>
            <label className="flex items-start gap-2.5 text-sm" style={{ color: 'var(--ds-t2)' }}>
              <Checkbox
                aria-label="Require signed rate confirmation"
                checked={requireSignedRateCon}
                onCheckedChange={(v) => setRequireSignedRateCon(v === true)}
              />
              A rate confirmation must be signed before the bill is approved
            </label>
            <p className="text-xs text-muted-foreground">
              An unsigned rate con blocks a rep outright; an admin may approve past it and the acknowledgement is kept on the bill.
            </p>
          </div>

          <DocumentTypesField
            label="Documents a bill needs before approval"
            value={billDocs}
            onChange={setBillDocs}
            disabled={saving}
            options={CARRIER_UPLOADABLE_TYPES}
            help="Leave every box clear to follow whatever the carrier upload link already asks for. An admin can still approve past a missing document, with a written note."
          />

          <div>
            <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Remittance e-mail</Label>
            <Textarea
              aria-label="Remittance email template"
              rows={3}
              value={remittanceTemplate}
              onChange={(e) => setRemittanceTemplate(e.target.value)}
              placeholder={DEFAULT_REMITTANCE_EMAIL_TEMPLATE}
              className="text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {'{reference}'}, {'{carrier}'}, {'{total}'}, {'{date}'} and {'{method}'} are filled in. {'{reference}'} is required.
            </p>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="button" size="sm" className="h-8 gap-1" onClick={save} disabled={saving}>
            <Save className="size-3.5" /> Save AP settings
          </Button>
        </div>
      )}
    </div>
  )
}
