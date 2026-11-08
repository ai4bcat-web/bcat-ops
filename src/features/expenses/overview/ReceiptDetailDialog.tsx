import { useEffect, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { TmsBadge, TmsDetailSplit, TmsDialog, TmsDocumentFrame, TmsMetaList } from '@/features/tms/kit'
import { formatDateShort } from '@/lib/date'
import { receiptStatus } from '@/lib/expenseOverview'
import type { Receipt } from '@/lib/expenseOverview'
import { formatCents } from '@/lib/invoiceBuild'
import type { VendorPayable } from '@/types/vendorAp'

interface Props {
  receipt: Receipt | null
  /** The linked vendor payable (maintenance ↔ payable by `sourceInvoiceId`), if any. */
  payable: VendorPayable | null
  getAttachmentUrl: (key: string) => Promise<string>
  onClose: () => void
}

interface Loaded { key: string; url: string | null; error: string | null }

/**
 * Receipt detail: the image on the left only where one exists (an e-mailed vendor invoice's
 * first attachment), an explicit "no image on file" state otherwise; the facts on the right.
 */
export function ReceiptDetailDialog({ receipt, payable, getAttachmentUrl, onClose }: Props) {
  const attachment = payable?.attachments?.[0] ?? null
  const key = attachment?.key ?? null
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!key) return
    let live = true
    getAttachmentUrl(key)
      .then((url) => { if (live) setLoaded({ key, url, error: null }) })
      .catch(() => { if (live) setLoaded({ key, url: null, error: 'The image could not be loaded.' }) })
    return () => { live = false }
  }, [key, getAttachmentUrl])

  const current = loaded && loaded.key === key ? loaded : null
  const status = receipt ? receiptStatus(receipt) : null

  return (
    <TmsDialog
      open={receipt !== null}
      onOpenChange={(open) => { if (!open) onClose() }}
      title={receipt ? `Receipt · ${receipt.merchant}` : 'Receipt'}
      className="tms-dialog-xl"
    >
      {receipt && status ? (
        <TmsDetailSplit
          ratio="6/6"
          aside={(
            <TmsMetaList
              items={[
                { label: 'Driver', value: receipt.driverName },
                { label: 'Date', value: formatDateShort(`${receipt.date}T12:00:00Z`) },
                { label: 'Truck', value: receipt.truckUnit },
                { label: 'Category', value: receipt.category },
                {
                  label: 'Amount',
                  value: <strong style={{ color: 'var(--tms-badge-red)' }}>{formatCents(receipt.amountCents)}</strong>,
                  testId: 'receipt-amount',
                },
                { label: 'Status', value: <TmsBadge tone={status.tone}>{status.label}</TmsBadge> },
                { label: 'Location', value: receipt.location },
              ]}
            />
          )}
        >
          {key ? (
            <TmsDocumentFrame
              url={current?.url ?? null}
              fileKey={key}
              title={attachment?.name ?? 'Receipt'}
              error={current?.error ?? null}
              height={420}
              onDownload={current?.url ? () => window.open(current.url!, '_blank', 'noopener') : undefined}
            />
          ) : (
            <div className="tms-empty" data-testid="receipt-no-image">
              <ImageOff className="tms-empty-icon" size={20} aria-hidden="true" />
              <div className="tms-empty-title">No image on file for this receipt</div>
            </div>
          )}
        </TmsDetailSplit>
      ) : null}
    </TmsDialog>
  )
}
