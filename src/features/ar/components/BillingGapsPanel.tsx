/**
 * "Missing from AP/AR": loads moved to billing from Load Review that never reached the
 * invoice queue or the carrier's payables. Shown on both the Invoicing and Payables pages,
 * empty (and invisible) when everything released is where it belongs.
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { TmsAlert, TmsButton } from '@/features/tms/kit'
import {
  createMissingApRecords,
  graphqlErrorText,
  reconcileBilling,
  releaseToBilling,
  type BillingGap,
} from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'

export function BillingGapsPanel({ onFixed }: { onFixed?: () => void }) {
  const [gaps, setGaps] = useState<BillingGap[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() =>
    Promise.resolve()
      .then(() => reconcileBilling())
      .then((r) => setGaps(r.gaps ?? []))
      // A check that cannot run hides itself: the pages still work without it.
      .catch(() => setGaps([])),
  [])
  useEffect(() => { void load() }, [load])

  const run = (key: string, work: () => Promise<unknown>, done: string) => {
    setBusy(key)
    work()
      .then(() => { toast.success(done); onFixed?.() })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'That did not work'))
      .finally(() => { setBusy(null); void load() })
  }

  if (gaps.length === 0) return null
  return (
    <TmsAlert tone="orange" title={`Missing from AP/AR: ${gaps.length} released ${gaps.length === 1 ? 'load' : 'loads'}`}>
      <ul className="flex flex-col gap-2" data-testid="billing-gaps">
        {gaps.map((g) => (
          <li key={g.orderId} className="flex flex-wrap items-center gap-2">
            <strong>PRO {g.shipmentNumber ?? g.shipmentId}</strong>
            {g.customerName ? <span>{g.customerName}</span> : null}
            {g.arMissing ? (
              <>
                <span>Not in AR: {g.arReason}</span>
                <TmsButton size="sm" disabled={busy !== null} onClick={() => run(`ar:${g.orderId}`, () => releaseToBilling({ orderId: g.orderId }), 'Invoice created')}>
                  Create invoice
                </TmsButton>
              </>
            ) : null}
            {g.apMissing.length > 0 ? (
              <>
                <span>Not in AP: {g.apMissing.map((a) => `${a.carrierName} ${formatCents(a.grossCents)}`).join(', ')}</span>
                <TmsButton size="sm" disabled={busy !== null} onClick={() => run(`ap:${g.orderId}`, () => createMissingApRecords(g.orderId), 'AP record created')}>
                  Create AP record
                </TmsButton>
              </>
            ) : null}
            {g.apUnbillable.map((u) => (
              <span key={u.loadCarrierId}>Cannot bill {u.carrierName}: {u.reasons.join('; ') || 'no reason given'}</span>
            ))}
          </li>
        ))}
      </ul>
    </TmsAlert>
  )
}
