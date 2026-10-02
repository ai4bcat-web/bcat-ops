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
import { assembleInvoice, checkBroker, setBrokerMc, submitToOtr } from '@/lib/otrClient'
import { setFactoringManualFields } from '@/lib/apiClient'
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
  ratecon: 'rate con',
  load: 'load',
  location: 'location',
  geocode: 'geocoded',
}

interface Props {
  item: FactoringItem
  onChanged: () => void
}

export function OtrPanel({ item, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [mc, setMc] = useState('')

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
          <span className="text-muted-foreground">
            Status: <span className="font-medium text-foreground">{item.otrStatus ?? 'Pending'}</span>
          </span>
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
          <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {item.otrError}
          </p>
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
  const saveField = (field: OtrRequiredField, value: string) =>
    run(
      `field:${field}`,
      async () => {
        await setFactoringManualFields(item.id, { ...manual, [field]: value })
        await assembleInvoice(item.id)
      },
      value.trim() ? `${OTR_FIELD_LABEL[field]} saved` : `${OTR_FIELD_LABEL[field]} cleared`,
    )

  return (
    <div className="space-y-3 rounded-md border border-[var(--ds-border)] bg-[var(--ds-bg)] p-3">
      {/* Every required field, with its source. Missing ones are called out. */}
      <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {OTR_REQUIRED_FIELDS.map((f) => (
          <FieldRow
            key={f}
            field={f}
            value={readiness.payload?.[f]}
            source={readiness.sources?.[f]}
            pro={item.proNumber}
            busy={busy !== null}
            saving={busy === `field:${f}`}
            /* Broker MC has its own control below, because it saves to the customer. */
            editable={f !== 'BrokerMC'}
            onSave={(v) => void saveField(f, v)}
          />
        ))}
      </div>

      {readiness.missingDocuments?.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-amber-700">
          <AlertTriangle className="size-3.5" />
          Missing {readiness.missingDocuments.join(' and ')}
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
            item.brokerCheckResult === 'APPROVED' ? 'text-emerald-700' : 'text-amber-700'
          }`}
        >
          <ShieldCheck className="size-3.5" />
          Broker {item.brokerMcChecked}: {item.brokerCheckResult.replace('_', ' ').toLowerCase()}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {needsMc && (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              const v = mc.trim()
              if (!v) return
              void run('mc', () => setBrokerMc(item.id, v), 'Broker MC saved to the customer')
            }}
          >
            <Input
              value={mc}
              onChange={(e) => setMc(e.target.value)}
              placeholder="Broker MC"
              inputMode="numeric"
              className="h-8 w-32 text-xs"
              aria-label={`Broker MC for PRO ${item.proNumber}`}
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy !== null || !mc.trim()}>
              {busy === 'mc' ? <Loader2 className="size-3.5 animate-spin" /> : 'Save MC'}
            </Button>
          </form>
        )}

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
function FieldRow({
  field, value, source, pro, busy, saving, editable, onSave,
}: {
  field: OtrRequiredField
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
  const hint = FIELD_HINT[field]

  // Filling a blank: the input is simply there, no extra click to reveal it.
  const showInput = editable && (value === undefined || open)

  if (showInput) {
    return (
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          onSave(draft)
          setOpen(false)
          setDraft('')
        }}
      >
        <span className="shrink-0 text-muted-foreground">{OTR_FIELD_LABEL[field]}</span>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={hint?.placeholder}
          inputMode={hint?.inputMode}
          className="h-7 min-w-0 flex-1 text-xs"
          aria-label={`${OTR_FIELD_LABEL[field]} for PRO ${pro}`}
        />
        <Button type="submit" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy}>
          {saving ? <Loader2 className="size-3 animate-spin" /> : 'Save'}
        </Button>
      </form>
    )
  }

  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{OTR_FIELD_LABEL[field]}</span>
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
            aria-label={`${typed ? 'Change' : 'Override'} ${OTR_FIELD_LABEL[field]} for PRO ${pro}`}
            onClick={() => { setDraft(typed ? String(value ?? '') : ''); setOpen(true) }}
          >
            {typed ? 'change' : 'override'}
          </button>
        )}
      </span>
    </div>
  )
}
