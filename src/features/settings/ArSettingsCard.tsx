/**
 * Invoicing & AR: the house rules every issued invoice is built from.
 *
 * Two of these settings are load-bearing enough to be refused here rather than
 * discovered later. A number format with no counter would hand every invoice the same
 * number, so it is checked through `invoiceNumberFormatError` — the same function
 * `GENERATE_INVOICE` refuses with, so the card and the Lambda cannot disagree. An
 * e-mail body with no `{number}` would arrive naming nothing, so it is checked through
 * `templateHasNumber`. The live example underneath the format box is rendered by the
 * real `formatInvoiceNumber` against the real next number, which is why the next number
 * is shown and never typed: it is taken with an atomic ADD, and a hand-edit would either
 * collide with an issued invoice or silently skip a block of numbers.
 *
 * The factor remit-to is printed instead of the division's own on a factored customer's
 * invoice, assignment notice included. Blank boxes mean "use the house default".
 */
import { useEffect, useState } from 'react'
import { Receipt, Save } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { DocumentTypesField } from '@/features/documents/DocumentTypesField'
import { getTmsSettings, listDivisions, saveArSettings } from '@/lib/apiClient'
import {
  DEFAULT_INVOICE_ATTACH_TYPES, DEFAULT_INVOICE_NUMBER_FORMAT, formatInvoiceNumber, invoiceNumberFormatError,
} from '@/lib/invoiceBuild'
import { DEFAULT_INVOICE_EMAIL_TEMPLATE, templateHasNumber } from '@/lib/shipmentNotices'
import type { InvoiceBatchEmailMode, TmsSettings } from '@/types/tms'
import { CheckRow, ErrorText, GroupLabel, Hint, Loading, Panel, SettingsCard, Stack } from './settingsKit'

/** What `{prefix}` resolves to when no division has set one. */
const FALLBACK_PREFIX = 'INV-'

const BATCH_MODES: { value: InvoiceBatchEmailMode; label: string }[] = [
  { value: 'PER_INVOICE', label: 'One e-mail per invoice' },
  { value: 'PER_BILL_TO', label: 'One e-mail per customer and bill-to' },
]

export function ArSettingsCard() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [numberFormat, setNumberFormat] = useState('')
  const [nextNumber, setNextNumber] = useState<number | null>(null)
  const [prefix, setPrefix] = useState(FALLBACK_PREFIX)
  const [terms, setTerms] = useState('')
  const [emailTemplate, setEmailTemplate] = useState('')
  const [attachTypes, setAttachTypes] = useState<string[]>([])
  const [factorName, setFactorName] = useState('')
  const [factorStreet, setFactorStreet] = useState('')
  const [factorCity, setFactorCity] = useState('')
  const [factorState, setFactorState] = useState('')
  const [factorZip, setFactorZip] = useState('')
  const [factorEmail, setFactorEmail] = useState('')
  const [factorNotice, setFactorNotice] = useState('')
  const [postingAdminOnly, setPostingAdminOnly] = useState(true)
  const [batchEmail, setBatchEmail] = useState<InvoiceBatchEmailMode>('PER_INVOICE')
  const [error, setError] = useState<string | null>(null)

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    Promise.all([getTmsSettings(), listDivisions().catch(() => [])])
      .then(([s, divisions]: [TmsSettings | null, { invoicePrefix?: string | null }[]]) => {
        setNumberFormat(s?.invoiceNumberFormat ?? '')
        setNextNumber(s?.nextInvoiceNumber ?? null)
        setPrefix(divisions.find((d) => d.invoicePrefix)?.invoicePrefix ?? FALLBACK_PREFIX)
        setTerms(s?.invoiceTerms ?? '')
        setEmailTemplate(s?.invoiceEmailTemplate ?? '')
        setAttachTypes(s?.invoiceAttachTypes ?? [])
        setFactorName(s?.factorRemitTo?.name ?? '')
        setFactorStreet(s?.factorRemitTo?.address?.street ?? '')
        setFactorCity(s?.factorRemitTo?.address?.city ?? '')
        setFactorState(s?.factorRemitTo?.address?.state ?? '')
        setFactorZip(s?.factorRemitTo?.address?.zip ?? '')
        setFactorEmail(s?.factorRemitTo?.email ?? '')
        setFactorNotice(s?.factorRemitTo?.noticeText ?? '')
        // Posting money is admin-only unless somebody deliberately opened it up.
        setPostingAdminOnly(s?.arPostingAdminOnly !== false)
        setBatchEmail(s?.invoiceBatchEmail ?? 'PER_INVOICE')
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const effectiveFormat = numberFormat.trim() || DEFAULT_INVOICE_NUMBER_FORMAT
  const formatError = invoiceNumberFormatError(effectiveFormat)
  const example = formatError
    ? null
    : formatInvoiceNumber(effectiveFormat, {
        prefix,
        n: nextNumber ?? 1,
        date: new Date().toISOString().slice(0, 10),
      })

  const save = async () => {
    setError(null)
    if (formatError) { setError(formatError); return }
    const body = emailTemplate.trim()
    if (body && !templateHasNumber(body)) {
      setError('The invoice e-mail must contain {number} — without it the bill arrives naming nothing')
      return
    }
    // A factor remit-to with no name is not a remit-to; it clears the whole block.
    const name = factorName.trim()
    const address = [factorStreet, factorCity, factorState, factorZip].some((v) => v.trim())
      ? {
          street: factorStreet.trim() || null,
          city: factorCity.trim() || null,
          state: factorState.trim() || null,
          zip: factorZip.trim() || null,
        }
      : null

    setSaving(true)
    try {
      await saveArSettings({
        invoiceNumberFormat: numberFormat.trim() || null,
        invoiceTerms: terms.trim() || null,
        invoiceEmailTemplate: body || null,
        // Nothing ticked means the house list, not "attach nothing".
        invoiceAttachTypes: attachTypes.length > 0 ? attachTypes : null,
        factorRemitTo: name
          ? { name, address, email: factorEmail.trim() || null, noticeText: factorNotice.trim() || null }
          : null,
        arPostingAdminOnly: postingAdminOnly,
        invoiceBatchEmail: batchEmail,
      })
      toast.success('Invoicing settings saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <SettingsCard
      icon={Receipt}
      title="Invoicing & AR"
      description="How invoices are numbered, what they say, what travels with them, where a factored customer pays, and who may post money."
    >
      {loading ? <Loading /> : (
        <Stack>
          <div className="tms-grid tms-grid-2">
            <TmsField
              label="Invoice number format"
              hint={
                <>
                  {'{prefix}'} is the division&rsquo;s invoice prefix, {'{yyyy}'} the year, {'{n}'} or {'{n:6}'} the counter.{' '}
                  {formatError
                    ? <span className="tms-field-error">{formatError}.</span>
                    : <>Next invoice: <strong data-testid="invoice-number-example">{example}</strong></>}
                </>
              }
            >
              <TmsInput
                aria-label="Invoice number format"
                value={numberFormat}
                onChange={(e) => setNumberFormat(e.target.value)}
                placeholder={DEFAULT_INVOICE_NUMBER_FORMAT}
              />
            </TmsField>
            <TmsField
              label="Next number"
              hint="Taken with an atomic add when an invoice is generated; it cannot be set by hand."
            >
              <TmsInput
                aria-label="Next invoice number"
                value={nextNumber != null ? String(nextNumber) : '1'}
                readOnly
                disabled
              />
            </TmsField>
          </div>

          <TmsField label="Invoice terms">
            <TmsTextarea
              aria-label="Invoice terms"
              rows={3}
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              placeholder="Printed at the foot of every invoice this system generates."
            />
          </TmsField>

          <TmsField
            label="Invoice e-mail"
            hint={<>{'{number}'}, {'{shipment}'}, {'{total}'} and {'{dueAt}'} are filled in. {'{number}'} is required.</>}
          >
            <TmsTextarea
              aria-label="Invoice email template"
              rows={3}
              value={emailTemplate}
              onChange={(e) => setEmailTemplate(e.target.value)}
              placeholder={DEFAULT_INVOICE_EMAIL_TEMPLATE}
            />
          </TmsField>

          <DocumentTypesField
            label="Documents attached to an invoice"
            value={attachTypes}
            onChange={setAttachTypes}
            disabled={saving}
            help={`Attached on top of whatever the customer's own required-document list asks for. Leave every box clear for the house default: ${DEFAULT_INVOICE_ATTACH_TYPES.join(' and ')}.`}
          />

          <Panel>
            <GroupLabel>Factor remit-to</GroupLabel>
            <Hint>Printed instead of the division&rsquo;s remit-to on a factored customer&rsquo;s invoice. Leave the name blank to turn it off.</Hint>
            <div className="tms-grid tms-grid-2">
              <TmsField label="Name">
                <TmsInput aria-label="Factor name" value={factorName} onChange={(e) => setFactorName(e.target.value)} />
              </TmsField>
              <TmsField label="E-mail">
                <TmsInput aria-label="Factor email" value={factorEmail} onChange={(e) => setFactorEmail(e.target.value)} />
              </TmsField>
            </div>
            <div className="tms-grid tms-grid-4">
              <TmsField label="Street">
                <TmsInput aria-label="Factor street" value={factorStreet} onChange={(e) => setFactorStreet(e.target.value)} />
              </TmsField>
              <TmsField label="City">
                <TmsInput aria-label="Factor city" value={factorCity} onChange={(e) => setFactorCity(e.target.value)} />
              </TmsField>
              <TmsField label="State">
                <TmsInput aria-label="Factor state" value={factorState} onChange={(e) => setFactorState(e.target.value)} />
              </TmsField>
              <TmsField label="ZIP">
                <TmsInput aria-label="Factor ZIP" value={factorZip} onChange={(e) => setFactorZip(e.target.value)} />
              </TmsField>
            </div>
            <TmsField label="Assignment notice">
              <TmsTextarea
                aria-label="Factor notice text"
                rows={2}
                value={factorNotice}
                onChange={(e) => setFactorNotice(e.target.value)}
                placeholder="The notice of assignment the factor requires on the face of the invoice."
              />
            </TmsField>
          </Panel>

          <div className="tms-grid tms-grid-2">
            <TmsField label="Batch e-mail">
              <TmsSelect
                aria-label="Batch e-mail mode"
                value={batchEmail}
                onChange={(e) => setBatchEmail(e.target.value as InvoiceBatchEmailMode)}
              >
                {BATCH_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </TmsSelect>
            </TmsField>
            <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 6 }}>
              <CheckRow
                ariaLabel="AR posting admin only"
                label="Only an admin may void, pay, credit, write off or reverse"
                checked={postingAdminOnly}
                onChange={setPostingAdminOnly}
              />
            </div>
          </div>

          {error && <ErrorText>{error}</ErrorText>}
          <div>
            <TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>
              <Save size={14} /> Save invoicing settings
            </TmsButton>
          </div>
        </Stack>
      )}
    </SettingsCard>
  )
}
