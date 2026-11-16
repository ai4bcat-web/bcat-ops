/**
 * The Why cell on the Factoring queue (Ryne 2026-11-16): one plain sentence for why a row is here,
 * a warning chip when the invoice and the queue disagree, and a details dialog (source e-mail, customer,
 * missing OTR fields, the linked invoice) behind a click.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { TmsBadge, TmsDialog, type TmsTone } from '@/features/tms/kit'
import { FACTORING_REASON_LABEL, type FactoringReason, type FactoringReasonInvoice } from '@/lib/factoringReason'

const TONE_COLOR: Record<FactoringReason['tone'], string | undefined> = {
  red: 'var(--tms-badge-red)',
  orange: 'var(--tms-badge-orange, var(--tms-badge-red))',
  blue: undefined,
  green: undefined,
  gray: undefined,
}

export function FactoringWhy({ proNumber, reason, invoice }: { proNumber: string; reason: FactoringReason; invoice?: FactoringReasonInvoice | null }) {
  const [open, setOpen] = useState(false)
  const color = TONE_COLOR[reason.tone]
  return (
    <>
      <span className="flex flex-col gap-1 items-start" style={{ minWidth: 0 }}>
        <button
          type="button"
          className="text-xs text-left whitespace-normal"
          style={{ color, fontWeight: reason.tone === 'red' ? 600 : undefined, background: 'none', border: 0, padding: 0, cursor: 'pointer', overflowWrap: 'anywhere' }}
          aria-label={`Why PRO ${proNumber} is here`}
          data-testid={`factoring-why-${proNumber}`}
          onClick={() => setOpen(true)}
        >
          {reason.short}
        </button>
        {reason.warning && (
          <TmsBadge tone={'orange' as TmsTone} title={reason.warning} data-testid={`factoring-why-warning-${proNumber}`}>
            Invoice says factored, queue says manual
          </TmsBadge>
        )}
      </span>
      {open && (
        <TmsDialog open onOpenChange={(next) => { if (!next) setOpen(false) }} title={`Why PRO ${proNumber} is here`}>
          <div className="flex flex-col gap-3" data-testid="factoring-why-dialog">
            <div>
              <TmsBadge tone={reason.tone as TmsTone}>{FACTORING_REASON_LABEL[reason.kind]}</TmsBadge>
              <p className="text-sm" style={{ marginTop: 8 }}>{reason.short}</p>
            </div>
            {reason.warning && <p className="text-sm" style={{ color: 'var(--tms-badge-red)' }}>{reason.warning}</p>}
            {reason.lines.length > 0 && (
              <ul className="text-sm" style={{ margin: 0, paddingLeft: 18 }}>
                {reason.lines.map((line) => <li key={line}>{line}</li>)}
              </ul>
            )}
            {invoice && (
              <p className="text-sm">
                <Link to={`/tms/invoicing/invoices/${invoice.id}`}>Open invoice {invoice.number}</Link>
              </p>
            )}
          </div>
        </TmsDialog>
      )}
    </>
  )
}
