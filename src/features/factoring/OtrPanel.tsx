/**
 * OTR readiness panel for one factoring queue row.
 *
 * Shows every field OTR requires, the value we resolved, and WHERE it came from,
 * so a wrong ZIP is traceable rather than mysterious. Anything still blank is a
 * manual step; broker MC is normally the only one, and entering it saves onto
 * the customer so the next load from that broker fills it automatically.
 *
 * Submit is deliberately a human action and is disabled until every field and
 * both documents are present.
 */
import { useCallback, useState } from 'react'
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
import type { FactoringItem } from '@/types'

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
        <span>Not yet prepared for OTR.</span>
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
          Prepare
        </Button>
      </div>
    )
  }

  const missing = new Set<OtrRequiredField>(readiness.missingFields)
  const needsMc = missing.has('BrokerMC')

  return (
    <div className="space-y-3 rounded-md border border-[var(--ds-border)] bg-[var(--ds-bg)] p-3">
      {/* Every required field, with its source. Missing ones are called out. */}
      <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {OTR_REQUIRED_FIELDS.map((f) => {
          const value = readiness.payload?.[f]
          const source = readiness.sources?.[f]
          return (
            <div key={f} className="flex items-baseline justify-between gap-2">
              <span className="text-muted-foreground">{OTR_FIELD_LABEL[f]}</span>
              {value === undefined ? (
                <span className="font-medium text-amber-700">needed</span>
              ) : (
                <span className="truncate font-medium text-foreground" title={String(value)}>
                  {String(value)}
                  {source && (
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      ({SOURCE_LABEL[source] ?? source})
                    </span>
                  )}
                </span>
              )}
            </div>
          )
        })}
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
          disabled={busy !== null || !readiness.ready}
          title={
            readiness.ready
              ? 'Create the invoice at OTR and upload the POD and rate confirmation'
              : `Still needed: ${[...readiness.missingFields.map((f) => OTR_FIELD_LABEL[f]), ...readiness.missingDocuments].join(', ')}`
          }
          onClick={() =>
            run('submit', () => submitToOtr(item.id), 'Submitted to OTR')
          }
        >
          {busy === 'submit' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : readiness.ready ? (
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
