/**
 * Step AI §2.2 E1 — the ONLY object the executors receive. `makeVisibleReader` wraps a raw
 * source (the Lambda's DynamoDB reads, or a fixture in tests) and returns rows already filtered
 * through the one row predicate in ../dataVisibility. The raw source lives in this closure; the
 * executors never see it. Reads are memoised per reader (one per request), the predicate never is.
 * Relative imports only (Lambda-bundled).
 */
import { canSeeAR, canSeeRow, type DataViewer, type VisCustomer } from '../dataVisibility'
import type { InvoiceRow, QuoteRow, SampleRow, ShipmentRow, VisibleReader } from './execute'

/** Unfiltered rows. Same row shapes as the visible ones, because filtering only removes rows. */
export interface RawSource {
  samples(month: string): Promise<SampleRow[]>
  shipments(month: string): Promise<ShipmentRow[]>
  openInvoices(): Promise<InvoiceRow[]>
  quotes(month: string): Promise<QuoteRow[]>
}

export function makeVisibleReader(
  raw: RawSource,
  viewer: DataViewer,
  customers: ReadonlyMap<string, VisCustomer>,
): VisibleReader {
  const memo = new Map<string, Promise<unknown>>()
  const once = <T>(key: string, load: () => Promise<T[]>): Promise<T[]> => {
    let p = memo.get(key) as Promise<T[]> | undefined
    if (!p) {
      p = load()
      memo.set(key, p)
    }
    return p
  }
  return {
    samples: (m) =>
      once(`s:${m}`, () => raw.samples(m)).then((rows) =>
        rows.filter((r) => canSeeRow(viewer, { customerId: r.customerId, salesRepId: r.salesRepId, customerRepId: r.customerRepId }, customers)),
      ),
    shipments: (m) =>
      once(`h:${m}`, () => raw.shipments(m)).then((rows) =>
        rows.filter((r) => canSeeRow(viewer, { customerId: r.customerId, salesRepId: r.salesRepId }, customers)),
      ),
    openInvoices: () =>
      once('i', () => raw.openInvoices()).then((rows) =>
        rows.filter((r) => canSeeAR(viewer, { customerId: r.customerId }, { customerId: r.customerId, salesRepId: r.salesRepId }, customers)),
      ),
    quotes: (m) =>
      once(`q:${m}`, () => raw.quotes(m)).then((rows) =>
        rows.filter((r) => canSeeRow(viewer, { customerId: r.customerId, customerRepId: r.customerRepId }, customers)),
      ),
  }
}
