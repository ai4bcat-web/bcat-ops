/**
 * The words each ledger puts on the aging strip.
 *
 * Their own module because the strip is a component file: a constant exported beside
 * a component costs the whole file its fast refresh.
 */
/** The words one ledger puts on the strip. `lag: null` drops that cell entirely. */
export interface AgingStripLabels {
  /** The `aria-label` of the strip itself, so a test can name the one it means. */
  aria: string
  total: string
  late: string
  /** Money that has moved and nobody has billed. */
  pending: string
  /** Singular noun behind the pending count: `order`, `assignment`. */
  pendingUnit: string
  /** Delivery → bill. AP has none: we do not raise the carrier's invoice. */
  lag: string | null
  pay: string
}

export const AR_STRIP_LABELS: AgingStripLabels = {
  aria: 'AR totals',
  total: 'Open AR',
  late: 'Late',
  pending: 'Delivered, not invoiced',
  pendingUnit: 'order',
  lag: 'Avg days to invoice',
  pay: 'Avg days to pay',
}

export const AP_STRIP_LABELS: AgingStripLabels = {
  aria: 'AP totals',
  total: 'Open AP',
  late: 'Late',
  pending: 'Awaiting invoice',
  pendingUnit: 'assignment',
  lag: null,
  pay: 'Avg days to pay',
}

