/**
 * OTR readiness panel for one factoring queue row.
 *
 * Shows every field OTR requires, the value we resolved, and WHERE it came from,
 * so a wrong ZIP is traceable rather than mysterious.
 *
 * Anything still blank can be typed in right here. A typed value is the highest
 * precedence tier in src/lib/otrInvoice.ts, and it is also read by the owner-operator
 * settlement, so filling a gap in this queue fills it on the settlement too — the two
 * pages describe the same load rather than disagreeing about it.
 *
 * Broker MC is the one exception and keeps its own control: it saves onto the CUSTOMER,
 * so the next load from that broker is already filled in. Storing it as a per-row
 * override would fix one invoice and leave the next one just as blank.
 *
 * Submit is deliberately a human action and is disabled until every field and
 * both documents are present.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Send, ShieldCheck, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import {
  OTR_FIELD_LABEL,
  OTR_REQUIRED_FIELDS,
  type OtrReadiness,
  type OtrRequiredField,
} from '@/lib/otrInvoice'
import { otrStatusMeta } from '@/lib/otrInvoiceStatus'
import { assembleInvoice, checkBroker, markManualInvoice, setBrokerMc, submitToOtr, uploadOtrDocs } from '@/lib/otrClient'
import { setFactoringManualFields } from '@/lib/apiClient'
import { FactoringDocCell } from './FactoringDocCell'
import { useAuthUser } from '@/hooks/useAuth'
import { isReadyToSubmit, whatIsMissing } from './factoringFields'
import type { FactoringItem } from '@/types'

/** Keyboard and format hints per field, so a phone offers the right keys. */
/*
 * Placeholders describe the FORMAT, never an example value.
 *
 * These started as sample data — "60601", "Chicago", "IL" — and every row showed the same
 * ones, so the queue read as though a real ZIP had been filled in on every shipment. A
 * placeholder that looks like data is worse than none: nobody can tell a prefilled value
 * from an empty field, and a wrong ZIP on a factored invoice is a real problem.
 */
const FIELD_HINT: Partial<Record<OtrRequiredField, { placeholder: string; inputMode?: 'numeric' | 'decimal' }>> = {
  InvoiceNo:     { placeholder: 'PRO number', inputMode: 'numeric' },
  // The one field that identifies the broker. Typing it is what fills in the customer.
  BrokerMC:      { placeholder: 'Broker MC number', inputMode: 'numeric' },
  PoNumber:      { placeholder: 'PO number' },
  InvoiceAmount: { placeholder: 'Amount in dollars', inputMode: 'decimal' },
  InvoiceDate:   { placeholder: 'YYYY-MM-DD' },
  FromCity:      { placeholder: 'Pickup city' },
  FromState:     { placeholder: 'Two letters' },
  FromZip:       { placeholder: 'Pickup ZIP', inputMode: 'numeric' },
  ToCity:        { placeholder: 'Delivery city' },
  ToState:       { placeholder: 'Two letters' },
  ToZip:         { placeholder: 'Delivery ZIP', inputMode: 'numeric' },
}

/** Where a value came from, phrased for a human rather than a developer. */
const SOURCE_LABEL: Record<string, string> = {
  manual: 'entered',
  broker: 'broker on file',
  ratecon: 'rate con',
  load: 'load',
  location: 'location',
  geocode: 'geocoded',
  invoice: 'invoice email',
}

/**
 * What the panel will let someone type. The eleven OTR fields, plus the customer name —
 * which OTR never reads from us but the office reads constantly.
 */
type EditableField = OtrRequiredField | 'CustomerName'

interface Props {
  item: FactoringItem
  onChanged: () => void
}

export function OtrPanel({ item, onChanged }: Props) {
  const staffEmail = useAuthUser()?.email ?? 'staff'
  const [busy, setBusy] = useState<string | null>(null)

  const readiness = (item.otrReadiness as OtrReadiness | null) ?? null
  const submitted = Boolean(item.otrInvoiceId)

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>, success: string) => {
      setBusy(label)
      try {
        await fn()
        toast.success(success)
        onChanged()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : `${label} failed`)
      } finally {
        setBusy(null)
      }
    },
    [onChanged],
  )

  /*
   * Prepare the row the moment someone opens it.
   *
   * "Not yet prepared for OTR" with a Prepare button was a dead end dressed as a state:
   * there is no reason anyone would open a row and NOT want it prepared, and until they
   * pressed it the fields could not be typed in and the chips all read missing \u2014 which
   * looked like the queue had no idea what the load was. Preparing is a read plus one
   * write of a cached blob, so doing it on open costs nothing a person would notice.
   *
   * Once per mounted row: the ref stops a failed assemble from retrying in a loop, and
   * the manual button below is the way back out.
   */
  const autoPrepared = useRef(false)
  const [prepareFailed, setPrepareFailed] = useState(false)
  useEffect(() => {
    if (readiness || submitted || autoPrepared.current) return
    autoPrepared.current = true
    assembleInvoice(item.id)
      .then(() => { setPrepareFailed(false); onChanged() })
      .catch(() => setPrepareFailed(true))
  }, [readiness, submitted, item.id, onChanged])

  // Already at OTR: show their board rather than the assembly panel.
  if (submitted) {
    return (
      <div className="rounded-md border border-[var(--ds-border)] bg-[var(--ds-bg)] p-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-semibold text-foreground">OTR invoice {item.otrInvoiceId}</span>
          {/*
            OTR's own word for it, in OTR's own colour — so a glance here and a glance at
            their portal agree. The mapping lives in src/lib/otrInvoiceStatus.ts; their API
            sends a number and their portal shows a word, and inventing our own wording
            would leave the office deciding whether two labels mean the same thing.

            Shown ONLY once OTR has actually reported one. This used to fall back to
            "Pending", which is itself one of OTR's statuses — so a row that had just been
            submitted, and about which OTR had said nothing at all, displayed a status in
            OTR's own wording as though it had come from them. Until the hourly sync brings
            one back there is no OTR status, and the row says exactly that.
          */}
          {(() => {
            const meta = otrStatusMeta(item.otrStatus)
            if (!meta) {
              return (
                <span className="text-xs text-muted-foreground">
                  Submitted &mdash; waiting for OTR&rsquo;s first status
                </span>
              )
            }
            return (
              <span
                className="rounded px-2 py-0.5 text-xs font-semibold"
                style={{ background: meta.tone.bg, color: meta.tone.fg, border: `1px solid ${meta.tone.border}` }}
                title={meta.needsAttention ? 'OTR or the broker is waiting on us' : undefined}
              >
                {meta.label}
              </span>
            )
          })()}
          {item.otrScheduleId && (
            <span className="text-muted-foreground">Schedule {item.otrScheduleId}</span>
          )}
          {item.otrStatusSyncedAt && (
            <span className="text-xs text-muted-foreground">
              synced {new Date(item.otrStatusSyncedAt).toLocaleString()}
            </span>
          )}
        </div>
        {item.otrError && (
          <div className="mt-2 space-y-2">
            <p className="flex items-start gap-1.5 text-xs text-amber-700">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {item.otrError}
            </p>
            {/*
              * The invoice exists; only the paperwork failed. Submitting again would create
              * a second invoice, so this sends the documents to the one OTR already has.
              */}
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                run('docs', () => uploadOtrDocs(item.id), 'Documents sent to OTR')
              }
            >
              {busy === 'docs' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Send the documents again
            </Button>
          </div>
        )}
      </div>
    )
  }

  if (!readiness) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed border-[var(--ds-border)] p-3 text-sm text-muted-foreground">
        {prepareFailed ? (
          <>
            <AlertTriangle className="size-3.5 text-amber-600" />
            <span>Could not prepare this row automatically.</span>
          </>
        ) : (
          <>
            <Loader2 className="size-3.5 animate-spin" />
            <span>Working out what OTR still needs\u2026</span>
          </>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => run('assemble', () => assembleInvoice(item.id), 'Prepared for OTR')}
        >
          {busy === 'assemble' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {prepareFailed ? 'Try again' : 'Prepare now'}
        </Button>
      </div>
    )
  }

  const missing = new Set<OtrRequiredField>(readiness.missingFields)
  const needsMc = missing.has('BrokerMC')
  // From the lists the chips are drawn from, never the cached `ready` flag beside them.
  const canSubmit = isReadyToSubmit(readiness)
  const manual = (item.otrManualFields ?? {}) as Record<string, string>

  /**
   * Save one typed field. The whole override map is rewritten, so it is merged first;
   * an empty value removes the override and lets the load or rate con speak again.
   * Re-assembling afterwards is what turns the typed value into a resolved field.
   */
  const saveField = (field: EditableField, label: string, value: string) =>
    run(
      `field:${field}`,
      async () => {
        await setFactoringManualFields(item.id, { ...manual, [field]: value })
        await assembleInvoice(item.id)
      },
      value.trim() ? `${label} saved` : `${label} cleared`,
    )

  return (
    <div className="space-y-3 rounded-md border border-[var(--ds-border)] bg-[var(--ds-bg)] p-3">
      {/* Every required field, with its source. Missing ones are called out. */}
      <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {/*
          * The customer leads, because it is the field a person checks first. It is not
          * editable here: the MC names the broker, and a typed name was indistinguishable
          * from a resolved one while being nobody's checked answer.
          */}
        {/* Read only — the MC names the customer. See CustomerRow. */}
        <CustomerRow readiness={readiness} pro={item.proNumber} />
        {OTR_REQUIRED_FIELDS.map((f) => (
          <FieldRow
            key={f}
            field={f}
            label={OTR_FIELD_LABEL[f]}
            value={readiness.payload?.[f]}
            source={readiness.sources?.[f]}
            pro={item.proNumber}
            busy={busy !== null}
            saving={busy === (f === 'BrokerMC' ? 'mc' : `field:${f}`)}
            editable
            /*
             * Broker MC saves onto the CUSTOMER, not as a row override: it is entered once
             * per broker, not once per invoice, and saving it is what resolves the name in
             * the row above. Everything else is a per-row override.
             */
            onSave={(v) =>
              f === 'BrokerMC'
                ? void run('mc', () => setBrokerMc(item.id, v), 'Broker MC saved \u2014 customer resolved from it')
                : void saveField(f, OTR_FIELD_LABEL[f], v)
            }
          />
        ))}
      </div>

      {/*
        * The two documents, in the panel rather than only on the collapsed row.
        *
        * Opening a row is what someone does when they are working it, and the paperwork is
        * half of what a row needs — sending them back up to a pair of small chips on the
        * collapsed row to attach a POD is how a row ends up opened, read and left alone.
        */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] p-2.5">
        <span className="text-xs font-semibold text-muted-foreground">Documents</span>
        {(['POD', 'RATECON'] as const).map((kind) => {
          const label = kind === 'POD' ? 'POD' : 'Rate confirmation'
          const present = !readiness.missingDocuments?.includes(label)
          return (
            <span key={kind} className="flex items-center gap-1.5">
              <span className={`text-xs ${present ? 'text-muted-foreground' : 'font-semibold text-red-700'}`}>
                {label}
              </span>
              <FactoringDocCell
                kind={kind}
                present={present}
                loadId={item.loadId}
                proNumber={item.proNumber}
                itemId={item.id}
                staffEmail={staffEmail}
                onUploaded={onChanged}
              />
            </span>
          )
        })}
      </div>

      {readiness.missingDocuments?.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs font-semibold text-red-700">
          <AlertTriangle className="size-3.5" />
          OTR will not take this invoice without the {readiness.missingDocuments.join(' and the ')}.
        </p>
      )}

      {/* Conflicts do not block submission, but a human is told before they send. */}
      {readiness.warnings?.map((w) => (
        <p key={w.field} className="flex items-start gap-1.5 text-xs text-amber-700">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {w.message}
        </p>
      ))}

      {item.brokerCheckResult && (
        <p
          className={`flex items-center gap-1.5 text-xs ${
            item.brokerCheckResult === 'APPROVED'
              ? 'text-emerald-700'
              : item.brokerCheckResult === 'NOT_FOUND'
                ? 'text-red-700'
                : 'text-amber-700'
          }`}
        >
          <ShieldCheck className="size-3.5" />
          {/*
            NOT_FOUND is spelled out rather than left as "not found", because it is the one
            result that stops a submit and the fix is a different MC, not a phone call.
          */}
          {item.brokerCheckResult === 'NOT_FOUND'
            ? `OTR has no broker with MC ${item.brokerMcChecked} — try another MC`
            : `Broker ${item.brokerMcChecked}: ${item.brokerCheckResult.replace('_', ' ').toLowerCase()}`}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => run('assemble', () => assembleInvoice(item.id), 'Refreshed')}
        >
          {busy === 'assemble' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Refresh
        </Button>

        {!needsMc && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() =>
              run('broker', () => checkBroker(item.id), 'Broker checked with OTR')
            }
          >
            {busy === 'broker' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="size-3.5" />
            )}
            Check broker
          </Button>
        )}

        <Button
          size="sm"
          disabled={busy !== null || !canSubmit}
          title={
            canSubmit
              ? 'Create the invoice at OTR and upload the POD and rate confirmation'
              : `Still needed: ${whatIsMissing(readiness, (f) => OTR_FIELD_LABEL[f])}`
          }
          onClick={() =>
            run('submit', () => submitToOtr(item.id), 'Submitted to OTR')
          }
        >
          {busy === 'submit' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : canSubmit ? (
            <CheckCircle2 className="size-3.5" />
          ) : (
            <Send className="size-3.5" />
          )}
          Submit to OTR
        </Button>

        {/* Billing it direct is always an option; No Buy is the version OTR chooses for us. */}
        {item.status === 'NEED_TO_FACTOR' && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            title="Take this row out of the OTR queue and bill the broker directly, with the steps to do it"
            onClick={() => run('manual', () => markManualInvoice(item.id), 'Moved to Invoice manually')}
          >
            Invoice manually instead
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * One required field: its resolved value and source, or an input to supply it.
 *
 * A value that came from the load or the rate con is left alone — the point of the
 * precedence chain is that those are usually right. What is offered is a way to fill a
 * blank, and a way to correct a value someone already typed, which is where mistakes
 * actually live.
 */
/**
 * Who the invoice bills, and how far to trust it.
 *
 * This was built on a belief that turned out to be false: that entering an MC resolved the
 * name. Nothing looks an MC up. `setMc` creates a broker record FROM THE LOAD'S customer
 * string and stamps the typed MC on it, so the name and the MC are independent facts that
 * have never been checked against each other — and the row was reporting the result as
 * "from the MC". MC 20313 went onto a record called AMERIFREIGHT SYSTEMS LLC and the queue
 * announced it as confirmed; the broker is Wayfinder Logistics.
 *
 * So the label now says where the name actually came from, and typing one is back: with no
 * lookup anywhere, a person correcting it is the only way a row gets the right broker on
 * it. A typed name reads as entered, never as verified.
 */
const SOURCE_NOTE: Record<string, string> = {
  verified: 'looked up from the MC',
  entered: 'entered here',
  directory: 'broker record on this load, not checked against the MC',
  load: 'from the load, often a shipper rather than the broker',
}

function CustomerRow({
  readiness, pro,
}: {
  readiness: OtrReadiness
  pro: string
}) {
  const name = (readiness.customerName ?? '').trim()
  const source = readiness.customerSource ?? null

  /*
   * Read only, on purpose.
   *
   * This used to offer a text box. Typing a broker's name asserts it; it does not check
   * it, and a typed name sat on the invoice looking exactly as settled as a resolved one.
   * The customer now comes from the MC and nothing else, so the way to fix a wrong name is
   * to fix the Broker MC below — which is a correction somebody can audit afterwards.
   */
  if (!name) {
    return (
      <div className="flex items-center gap-1.5 rounded-md bg-red-50 px-1.5 py-1" aria-label={`Customer for PRO ${pro}`}>
        <span className="shrink-0 font-semibold text-red-700">Customer</span>
        <span className="min-w-0 flex-1 text-red-700">Enter the Broker MC to name it</span>
      </div>
    )
  }

  const verified = source === 'verified'
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">Customer</span>
      <span className="flex min-w-0 items-baseline gap-1">
        <span
          className={`truncate ${verified ? 'font-medium text-foreground' : 'italic text-muted-foreground'}`}
          title={name}
        >
          {name}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          ({source ? SOURCE_NOTE[source] : 'unknown'})
        </span>
      </span>
    </div>
  )
}

function FieldRow({
  field, label, value, source, pro, busy, saving, editable, onSave,
}: {
  /** Any editable key, which is the eleven OTR fields plus the customer name. */
  field: EditableField
  label: string
  value: string | number | undefined
  source: string | undefined
  pro: string
  busy: boolean
  saving: boolean
  editable: boolean
  onSave: (value: string) => void
}) {
  const typed = source === 'manual'
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const hint = FIELD_HINT[field as OtrRequiredField]

  // Filling a blank: the input is simply there, no extra click to reveal it.
  const showInput = editable && (value === undefined || open)
  /*
   * A gap, rather than a value being corrected.
   *
   * Opened rows showed every field the same way, so the four things actually holding the
   * invoice up looked exactly like the seven that were already fine — and the chips that
   * DO say so are back on the collapsed row, which is the one place you are not looking
   * once you have opened it.
   */
  const isGap = value === undefined

  if (showInput) {
    return (
      <form
        className={`flex items-center gap-1.5 ${isGap ? 'rounded-md bg-red-50 px-1.5 py-1' : ''}`}
        onSubmit={(e) => {
          e.preventDefault()
          onSave(draft)
          setOpen(false)
          setDraft('')
        }}
      >
        <span className={`shrink-0 ${isGap ? 'font-semibold text-red-700' : 'text-muted-foreground'}`}>
          {label}
        </span>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={hint?.placeholder}
          inputMode={hint?.inputMode}
          className={`h-7 min-w-0 flex-1 text-xs ${isGap ? 'border-red-300 bg-white' : ''}`}
          aria-label={`${label} for PRO ${pro}`}
        />
        {/* Named, not just "Save": several of these are open at once on a row with
            more than one gap, and a bare "Save" is ambiguous to a screen reader and
            to anyone automating the page. */}
        <Button
          type="submit"
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          disabled={busy}
          aria-label={`Save ${label} for PRO ${pro}`}
        >
          {saving ? <Loader2 className="size-3 animate-spin" /> : 'Save'}
        </Button>
      </form>
    )
  }

  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-baseline gap-1">
        <span className="truncate font-medium text-foreground" title={String(value)}>
          {String(value)}
        </span>
        {source && (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            ({SOURCE_LABEL[source] ?? source})
          </span>
        )}
        {editable && (
          <button
            type="button"
            className="shrink-0 text-[10px] font-semibold text-[var(--ds-blue,#2563eb)] underline-offset-2 hover:underline disabled:opacity-50"
            disabled={busy}
            aria-label={`${typed ? 'Change' : 'Override'} ${label} for PRO ${pro}`}
            onClick={() => { setDraft(typed ? String(value ?? '') : ''); setOpen(true) }}
          >
            {typed ? 'change' : 'override'}
          </button>
        )}
      </span>
    </div>
  )
}
