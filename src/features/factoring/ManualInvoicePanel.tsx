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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
    <div className="rounded-lg border border-border bg-muted/30 p-4" aria-label={`Manual invoice steps for PRO ${item.proNumber}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold">
            <ShieldOff className="size-4 text-pink-700" aria-hidden="true" />
            {item.manualReason === 'NO_BUY'
              ? `OTR will not buy from ${customer || `MC ${item.brokerMcChecked ?? ''}`.trim()} — invoice this one manually`
              : 'Invoicing this one manually'}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {progress.complete
              ? `Invoiced manually${item.manualInvoicedAt ? ` · ${when(item.manualInvoicedAt)}` : ''}`
              : `${progress.done} of ${progress.total} steps done`}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => run('return', () => returnToOtrQueue(item.id), 'Back in the OTR queue')}
        >
          <RotateCcw className="size-3.5" /> Send back to OTR queue
        </Button>
      </div>

      {/* The AP address: two of the three steps need it, so it is asked for once, here. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label htmlFor={`ap-${item.id}`} className="text-xs font-semibold text-muted-foreground">Broker AP email</label>
        <Input
          id={`ap-${item.id}`}
          type="email"
          value={apDraft}
          placeholder="ap@broker.com"
          onChange={(e) => setApDraft(e.target.value)}
          className="h-8 max-w-xs text-sm"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null || apDraft.trim() === (item.apEmail ?? '')}
          onClick={() => run('ap', () => setApEmail(item.id, apDraft.trim()), 'AP email saved')}
        >
          {busy === 'ap' ? <Loader2 className="size-3.5 animate-spin" /> : 'Save'}
        </Button>
      </div>

      <ol className="mt-3 flex flex-col gap-2">
        {MANUAL_STEPS.map((step, i) => {
          const mark = steps?.[step.id] ?? null
          const id = `${item.id}-${step.id}`
          return (
            <li key={step.id} className={`flex items-start gap-3 rounded-md border p-3 ${mark ? 'border-emerald-200 bg-emerald-50' : 'border-border bg-background'}`}>
              <input
                id={id}
                type="checkbox"
                className="mt-0.5 size-5 cursor-pointer accent-emerald-600"
                checked={!!mark}
                disabled={busy !== null}
                aria-label={`Step ${i + 1}: ${step.label}`}
                onChange={(e) => run(step.id, () => setManualStep(item.id, step.id, e.target.checked), e.target.checked ? `Step ${i + 1} done` : `Step ${i + 1} reopened`)}
              />
              <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                <span className="block text-sm font-semibold">{i + 1}. {step.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {step.id === 'emailed' && item.apEmail
                    ? <>To <span className="font-medium text-foreground">{item.apEmail}</span>, cc {MANUAL_INVOICE_CC}.</>
                    : step.detail}
                </span>
                {mark && (
                  <span className="mt-1 block text-[11px] text-emerald-700">
                    <CheckCircle2 className="mr-1 inline size-3" aria-hidden="true" />
                    {mark.by} · {when(mark.at)}
                  </span>
                )}
              </label>
              {step.id === 'emailed' && item.apEmail && !mark && (
                <a
                  className="shrink-0 text-xs font-semibold text-primary"
                  href={`mailto:${encodeURIComponent(item.apEmail)}?cc=${encodeURIComponent(MANUAL_INVOICE_CC)}&subject=${encodeURIComponent(`Invoice ${item.proNumber} — Ivan Cartage`)}`}
                >
                  <Mail className="mr-1 inline size-3.5" aria-hidden="true" />Open email
                </a>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
