/**
 * Generate a bill of lading, look at it, keep it on the shipment, download it and
 * e-mail it.
 *
 * The PDF is built in the browser from the saved bundle (the rate confirmation's
 * approach: jsPDF → base64 → `SAVE_GENERATED_DOCUMENT`), so the preview is
 * byte-for-byte the file that gets stored. Every option that changes the page (scope,
 * rates, language) rebuilds the preview, and Download / E-mail only act on a stored row
 * that was generated with the options now on screen — change an option and they switch
 * off until the next Generate. Regenerating the same slot is v2 and leaves v1
 * SUPERSEDED, because a dock may already hold v1.
 *
 * "Include rates: Yes" is the only path that puts money on a BOL; that copy is stored
 * for the customer only, so this dialog never offers to e-mail it.
 */
import { useEffect, useMemo, useState } from 'react'
import { Download, FileText, Mail, Save, Send } from 'lucide-react'
import { toast } from 'sonner'
import { RecipientPicker } from '@/features/carriers/components/RecipientPicker'
import { commitAddress } from '@/features/carriers/components/rateConRecipients'
import {
  TmsAlert, TmsBadge, TmsButton, TmsDialog, TmsField, TmsSelect, TmsTextarea,
} from '@/features/tms/kit'
import { emailBol, getShipmentDocumentUrl, listDivisions, saveGeneratedDocument } from '@/lib/apiClient'
import {
  bolFilename, bolReferenceSuffix, bolScopeOptions, bolSlot, buildBolModel, type BolScope,
} from '@/lib/bolModel'
import { buildBolPdf } from '@/lib/bolPdf'
import { downloadPodAsPdf } from '@/lib/podDownload'
import { dedupeEmails } from '@/lib/emailAddress'
import { nextVersion } from '@/lib/shipmentDocuments'
import { bolParty, bolRecipientOptions } from './bolRecipients'
import type {
  CustomerRecord, Division, LocationRecord, ShipmentBundle, ShipmentDocumentRecord, TmsSettings,
} from '@/types/tms'

export interface BolDialogProps {
  bundle: ShipmentBundle
  customer: CustomerRecord | null
  locations: LocationRecord[]
  settings: TmsSettings | null
  onClose: () => void
  /** The row landed (or the e-mail went): the caller re-reads its documents. */
  onSaved: () => void
}

type Language = 'EN' | 'EN_ES'

/** A stored BOL older than the shipment's last edit by more than this reads as out of date. */
const STALE_SLACK_MS = 5000

const scopeKey = (s: BolScope): string =>
  s.kind === 'MASTER' ? 'MASTER' : s.kind === 'STOP' ? `STOP:${s.stopId}` : `CARRIER:${s.loadCarrierId}`

export function BolDialog({ bundle, customer, locations, settings, onClose, onSaved }: BolDialogProps) {
  const [divisions, setDivisions] = useState<Division[]>([])
  const [scopeId, setScopeId] = useState('MASTER')
  const [includeRates, setIncludeRates] = useState(false)
  const [language, setLanguage] = useState<Language>('EN')
  const [built, setBuilt] = useState<{ key: string; url: string; base64: string } | null>(null)
  const [buildError, setBuildError] = useState<{ key: string; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ doc: ShipmentDocumentRecord; key: string } | null>(null)

  const [emailOpen, setEmailOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [extras, setExtras] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)

  const load = bundle.loads[0] ?? null
  const scopeOptions = useMemo(() => bolScopeOptions(bundle), [bundle])
  const scope = scopeOptions.find((o) => scopeKey(o.scope) === scopeId)?.scope ?? { kind: 'MASTER' as const }
  const slot = bolSlot(scope, includeRates)
  const optionsKey = `${scopeKey(scope)}|${includeRates ? 'rated' : 'plain'}|${language}`

  const division = divisions.find((d) => d.key === load?.divisionKey) ?? divisions[0] ?? null
  const buildKey = `${optionsKey}|${division?.key ?? '-'}`

  const version = nextVersion(bundle.documents, 'BOL', null, slot)
  const filename = bolFilename(bundle.shipment.number, version, scope, includeRates)
  const referenceSuffix = bolReferenceSuffix(scope, includeRates) || null

  useEffect(() => {
    let live = true
    listDivisions().catch(() => [] as Division[]).then((d) => { if (live) setDivisions(d) })
    return () => { live = false }
  }, [])

  // Rebuilt whenever what it is built from changes; the old object URL is released on the
  // way out (an iframe holding a revoked URL is a blank page).
  useEffect(() => {
    let live = true
    let url: string | null = null
    const key = buildKey
    ;(async () => {
      const model = buildBolModel(bundle, customer, division, locations, {
        scope,
        includeRates,
        language,
        brokerPhone: settings?.trackingContact?.phone ?? null,
        terms: settings?.bolTerms ?? null,
      })
      const doc = await buildBolPdf(model)
      if (!live) return
      url = URL.createObjectURL(doc.output('blob'))
      // Base64 with no data-URI prefix — what SAVE_GENERATED_DOCUMENT expects.
      setBuilt({ key, url, base64: doc.output('datauristring').split('base64,')[1] ?? '' })
      setBuildError(null)
    })().catch((err: unknown) => {
      if (!live) return
      setBuildError({ key, message: err instanceof Error ? err.message : 'The document could not be built' })
    })
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
    // The builder reads the whole bundle; the inputs that actually change the page are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildKey, bundle.documents, bundle.shipment.updatedAt, settings, customer, locations])

  const ready = built !== null && built.key === buildKey ? built : null
  const failure = buildError !== null && buildError.key === buildKey ? buildError.message : null
  const building = ready === null && failure === null

  // Stored with the options on screen: only then do Download and E-mail mean this page.
  const shareable = saved !== null && saved.key === optionsKey ? saved.doc : null

  // The ACTIVE row of this slot, and whether the shipment was edited after it was made.
  const current = useMemo(() => {
    const rows = bundle.documents.filter((d) => d.type === 'BOL' && d.status === 'ACTIVE'
      && (d.stopId ?? null) === (slot.stopId ?? null)
      && (d.loadCarrierId ?? null) === (slot.loadCarrierId ?? null)
      && (d.audience === 'CUSTOMER') === slot.rated)
    return rows.reduce<ShipmentDocumentRecord | null>(
      (best, d) => (!best || (d.version ?? 0) > (best.version ?? 0) ? d : best), null)
  }, [bundle.documents, slot.stopId, slot.loadCarrierId, slot.rated])
  const stale = current !== null
    && Date.parse(bundle.shipment.updatedAt) - Date.parse(current.uploadedAt) > STALE_SLACK_MS

  const recipientOptions = useMemo(() => bolRecipientOptions(bundle, locations), [bundle, locations])

  const generate = async () => {
    if (!ready) { setSaveError('There is nothing built to save yet.'); return }
    setSaving(true)
    setSaveError(null)
    try {
      const answer = await saveGeneratedDocument({
        shipmentId: bundle.shipment.id,
        type: 'BOL',
        loadId: null,
        loadCarrierId: slot.loadCarrierId,
        stopId: slot.stopId,
        rated: slot.rated,
        referenceSuffix,
        pdfBase64: ready.base64,
        filename,
      })
      setSaved({ doc: answer.document, key: optionsKey })
      toast.success(`Bill of lading saved as v${version}`)
      onSaved()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'The document could not be saved')
    } finally {
      setSaving(false)
    }
  }

  const download = async () => {
    if (!shareable) return
    setDownloading(true)
    try {
      await downloadPodAsPdf(await getShipmentDocumentUrl(shareable.s3Key), shareable.name)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not download that document')
    } finally {
      setDownloading(false)
    }
  }

  const send = async () => {
    if (!shareable) return
    setEmailError(null)
    let picked = selected
    let typed = extras
    if (draft.trim()) {
      const result = commitAddress({ text: draft, options: recipientOptions, selected, extras })
      if (!result.ok) { setEmailError(result.error); return }
      picked = result.selected
      typed = result.extras
      setSelected(picked)
      setExtras(typed)
      setDraft('')
    }
    // Typed addresses are always sent to; ticked options only when still ticked.
    const to = dedupeEmails([...picked, ...typed])
    if (to.length === 0) { setEmailError('Pick or add at least one address.'); return }
    setSending(true)
    try {
      const answer = await emailBol({
        shipmentId: bundle.shipment.id,
        documentId: shareable.id,
        to,
        message: message.trim() || null,
        party: bolParty(to, recipientOptions),
      })
      if (answer.emailStatus === 'SENT') {
        toast.success(`Bill of lading e-mailed to ${to.join(', ')}`)
        onSaved()
      } else {
        const why = answer.emailError ?? 'The e-mail was not sent'
        setEmailError(why)
        toast.error(`Bill of lading not sent: ${why}`)
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : 'The e-mail could not be sent'
      setEmailError(why)
      toast.error(`Bill of lading not sent: ${why}`)
    } finally {
      setSending(false)
    }
  }

  const busy = saving || sending
  const statusLabel = bundle.shipment.status
  const showScope = scopeOptions.length >= 2

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open && !busy) onClose() }}
      title="Bill of lading"
      className="tms-dialog-xl"
      footer={
        <>
          <p className="mr-auto text-xs tms-muted" data-testid="bol-version-note">
            {version > 1
              ? `Generate as v${version} — v${version - 1} becomes superseded`
              : 'Generate as v1 — the first version of this document'}
          </p>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy} data-testid="bol-close">Close</TmsButton>
          <TmsButton
            onClick={() => { void download() }}
            disabled={!shareable || downloading}
            data-testid="bol-download"
          >
            <Download size={14} className="mr-1" />Download
          </TmsButton>
          <TmsButton
            onClick={() => setEmailOpen((v) => !v)}
            disabled={!shareable || includeRates}
            data-testid="bol-email-toggle"
          >
            <Mail size={14} className="mr-1" />E-mail
          </TmsButton>
          <TmsButton
            variant="primary"
            onClick={() => { void generate() }}
            disabled={busy || building || !ready}
            data-testid="bol-generate"
          >
            <Save size={14} className="mr-1" />{saving ? 'Generating…' : `Generate v${version}`}
          </TmsButton>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <TmsBadge tone="gray" className="text-[10px]">Bill of lading</TmsBadge>
        <span className="tms-muted" data-testid="bol-filename">{filename}</span>
        {stale && current && (
          <TmsBadge tone="orange" className="text-[10px]" data-testid="bol-stale-chip">
            {`BOL v${current.version ?? 1} predates these edits — regenerate`}
          </TmsBadge>
        )}
      </div>

      {statusLabel === 'DRAFT' && (
        <TmsAlert tone="orange" role="status">
          <span data-testid="bol-draft-banner">Shipment is still a draft. The BOL prints what is saved.</span>
        </TmsAlert>
      )}

      <div className="flex min-h-0 flex-col gap-3 md:flex-row" data-testid="bol-dialog">
        <div className="flex w-full shrink-0 flex-col gap-3 md:w-72">
          {showScope && (
            <TmsField label="Scope">
              <TmsSelect
                value={scopeKey(scope)}
                onChange={(e) => setScopeId(e.target.value)}
                options={scopeOptions.map((o) => ({ value: scopeKey(o.scope), label: o.label }))}
                data-testid="bol-scope"
              />
            </TmsField>
          )}
          <TmsField label="Include rates">
            <TmsSelect
              value={includeRates ? 'YES' : 'NO'}
              onChange={(e) => setIncludeRates(e.target.value === 'YES')}
              options={[{ value: 'NO', label: 'No' }, { value: 'YES', label: 'Yes' }]}
              data-testid="bol-include-rates"
            />
          </TmsField>
          {includeRates && (
            <p className="text-xs tms-muted" data-testid="bol-rates-note">
              Customer charges print. Saved for the customer only; cannot be e-mailed to a carrier or driver.
            </p>
          )}
          <TmsField label="Language note">
            <TmsSelect
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
              options={[
                { value: 'EN', label: 'English only' },
                { value: 'EN_ES', label: 'English + Spanish receipt line' },
              ]}
              data-testid="bol-language"
            />
          </TmsField>

          {includeRates && shareable && (
            <p className="text-xs tms-muted" data-testid="bol-customer-copy-note">
              Customer copy: send it from Documents → E-mail.
            </p>
          )}

          {emailOpen && shareable && !includeRates && (
            <div className="flex flex-col gap-2" data-testid="bol-email-panel">
              <RecipientPicker
                options={recipientOptions}
                selected={selected}
                extras={extras}
                draft={draft}
                onDraftChange={setDraft}
                onSelectedChange={setSelected}
                onExtrasChange={setExtras}
                disabled={sending}
              />
              <TmsField label="Message">
                <TmsTextarea
                  rows={3}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  disabled={sending}
                  data-testid="bol-email-message"
                />
              </TmsField>
              {emailError && <TmsAlert tone="red"><span data-testid="bol-email-error">{emailError}</span></TmsAlert>}
              <TmsButton
                variant="primary"
                onClick={() => { void send() }}
                disabled={sending}
                data-testid="bol-email-send"
              >
                <Send size={14} className="mr-1" />{sending ? 'Sending…' : 'Send'}
              </TmsButton>
            </div>
          )}
        </div>

        <div className="h-[55vh] min-w-0 flex-1 overflow-hidden rounded-[var(--tms-radius)] border border-[color:var(--tms-border)] bg-[color:var(--tms-card)]">
          {building && (
            <p className="flex h-full items-center justify-center gap-2 text-sm tms-muted">
              <FileText size={14} />Building the document…
            </p>
          )}
          {ready && (
            <iframe src={ready.url} title="Bill of lading preview" className="h-full w-full" data-testid="bol-preview" />
          )}
          {failure && !ready && (
            <p className="flex h-full items-center justify-center text-sm tms-muted">Nothing to preview.</p>
          )}
        </div>
      </div>

      {failure && <TmsAlert tone="red"><span data-testid="bol-build-error">{failure}</span></TmsAlert>}
      {saveError && <TmsAlert tone="red"><span data-testid="bol-save-error">{saveError}</span></TmsAlert>}
    </TmsDialog>
  )
}
