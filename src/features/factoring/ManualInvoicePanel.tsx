/**
 * The checklist for an invoice that goes out by hand.
 *
 * A broker OTR will not buy from still gets invoiced — just not through OTR. Three steps,
 * each ticked by the person who did it, so the row says exactly where it stands and who
 * sent it. The AP address sits at the top because two of the three steps need it.
 */
import { useState } from 'react'
import { CheckCircle2, Loader2, Mail, RotateCcw, ShieldOff } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsInput, TmsTimeline } from '@/features/tms/kit'
import type { FactoringItem } from '@/types'
import { MANUAL_STEPS, MANUAL_INVOICE_CC, manualProgress } from '@/lib/manualInvoice'
import { returnToOtrQueue, setApEmail, setManualStep } from '@/lib/otrClient'
import { errorText } from '@/lib/errorText'

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function ManualInvoicePanel({ item, onChanged }: { item: FactoringItem; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [apDraft, setApDraft] = useState(item.apEmail ?? '')
  const steps = item.manualSteps ?? null
  const progress = manualProgress(steps)
  // Once e-mailed (or the row is finished) the server refuses the return; say so up front.
  const sent = Boolean(steps?.emailed) || item.status === 'INVOICED_MANUALLY'
  const customer = ((item.otrReadiness as { customerName?: string } | null)?.customerName ?? '').trim()

  async function run(key: string, fn: () => Promise<unknown>, okMsg: string) {
    setBusy(key)
    try {
      await fn()
      toast.success(okMsg)
      onChanged()
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div aria-label={`Manual invoice steps for PRO ${item.proNumber}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-semibold">
            <ShieldOff className="size-4 text-[color:var(--tms-badge-pink)]" aria-hidden="true" />
            {item.manualReason === 'NO_BUY'
              ? `OTR will not buy from ${customer || `MC ${item.brokerMcChecked ?? ''}`.trim()} — invoice this one manually`
              : 'Invoicing this one manually'}
          </p>
          <p className="mt-0.5 text-xs tms-muted">
            {progress.complete
              ? `Invoiced manually${item.manualInvoicedAt ? ` · ${when(item.manualInvoicedAt)}` : ''}`
              : `${progress.done} of ${progress.total} steps done`}
          </p>
        </div>
        <TmsButton
          variant="ghost"
          size="sm"
          disabled={busy !== null || sent}
          title={sent ? 'Already sent to the customer — it cannot go back to factoring' : undefined}
          onClick={() => run('return', () => returnToOtrQueue(item.id), 'Back in the OTR queue')}
        >
          <RotateCcw className="size-3.5" /> Send back to OTR queue
        </TmsButton>
      </div>

      {/* The AP address: two of the three steps need it, so it is asked for once, here. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label htmlFor={`ap-${item.id}`} className="text-xs font-semibold tms-muted">Broker AP email</label>
        <TmsInput
          id={`ap-${item.id}`}
          type="email"
          value={apDraft}
          placeholder="ap@broker.com"
          onChange={(e) => setApDraft(e.target.value)}
          className="max-w-xs"
        />
        <TmsButton
          size="sm"
          disabled={busy !== null || apDraft.trim() === (item.apEmail ?? '')}
          onClick={() => run('ap', () => setApEmail(item.id, apDraft.trim()), 'AP email saved')}
        >
          {busy === 'ap' ? <Loader2 className="size-3.5 animate-spin" /> : 'Save'}
        </TmsButton>
      </div>

      <TmsTimeline
        compact
        className="mt-3"
        ariaLabel="Manual invoice steps"
        items={MANUAL_STEPS.map((step, i) => {
          const mark = steps?.[step.id] ?? null
          const id = `${item.id}-${step.id}`
          return {
            id: step.id,
            state: mark ? 'done' : 'upcoming',
            title: (
              <span className="inline-flex items-center gap-2">
                <input
                  id={id}
                  type="checkbox"
                  className="size-4 cursor-pointer"
                  checked={!!mark}
                  disabled={busy !== null}
                  aria-label={`Step ${i + 1}: ${step.label}`}
                  onChange={(e) => run(step.id, () => setManualStep(item.id, step.id, e.target.checked), e.target.checked ? `Step ${i + 1} done` : `Step ${i + 1} reopened`)}
                />
                <label htmlFor={id} className="cursor-pointer font-semibold">{i + 1}. {step.label}</label>
              </span>
            ),
            description: (
              <>
                <span className="block">
                  {step.id === 'emailed' && item.apEmail
                    ? <>To <span className="font-medium">{item.apEmail}</span>, cc {MANUAL_INVOICE_CC}.</>
                    : step.detail}
                </span>
                {mark && (
                  <span className="mt-1 block text-[11px]">
                    <CheckCircle2 className="mr-1 inline size-3" aria-hidden="true" />
                    {mark.by} · {when(mark.at)}
                  </span>
                )}
                {step.id === 'emailed' && item.apEmail && !mark && (
                  <a
                    className="mt-1 inline-block text-xs font-semibold"
                    href={`mailto:${encodeURIComponent(item.apEmail)}?cc=${encodeURIComponent(MANUAL_INVOICE_CC)}&subject=${encodeURIComponent(`Invoice ${item.proNumber} — Ivan Cartage`)}`}
                  >
                    <Mail className="mr-1 inline size-3.5" aria-hidden="true" />Open email
                  </a>
                )}
              </>
            ),
          }
        })}
      />
    </div>
  )
}
