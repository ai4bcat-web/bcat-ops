/**
 * Change a draft invoice before it goes out: what the customer is charged, and the POD and customer rate confirmation it carries
 * (Ryne, 2026-11-18). From the Ready to invoice list and from the review-and-send carousel.
 */
import { TmsDialog } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import type { InvoiceAttachmentPlanRow } from '@/lib/invoiceDelivery'
import type { FactoringItem } from '@/types'
import type { InvoiceRecord } from '@/types/tms'
import { InvoiceFilesPanel } from './InvoiceFilesPanel'
import { InvoiceRateEditor } from './InvoiceRateEditor'

export function EditInvoiceRateDialog({ invoice, factoringItem, plan, onClose, onSaved, onFilesChanged }: {
  invoice: InvoiceRecord
  factoringItem?: Pick<FactoringItem, 'status' | 'otrInvoiceId'> | null
  /** The invoice's attachment plan when the page has it already. */
  plan?: InvoiceAttachmentPlanRow
  onClose: () => void
  onSaved: (invoice: InvoiceRecord, change: { beforeCents: number; afterCents: number }) => void
  /** A POD or rate confirmation was replaced or added: the page refreshes its plans, chips and preview. */
  onFilesChanged?: () => void
}) {
  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={`Edit invoice · ${invoice.number}`}
      description={`${invoice.customerName ?? ''} · PRO ${invoice.shipmentNumber || invoice.number} · ${formatCents(invoice.totalCents)}`}
    >
      <div className="flex flex-col gap-4">
        <section aria-label="Amount" className="flex flex-col gap-2">
          <h3 className="font-semibold">Amount</h3>
          <InvoiceRateEditor invoice={invoice} onSaved={onSaved} onCancel={onClose} />
        </section>
        <section aria-label="Files" className="flex flex-col gap-2">
          <h3 className="font-semibold">Files</h3>
          <InvoiceFilesPanel invoice={invoice} factoringItem={factoringItem} plan={plan} onChanged={() => onFilesChanged?.()} />
        </section>
      </div>
    </TmsDialog>
  )
}
