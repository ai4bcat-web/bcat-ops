/**
 * Pages that no longer exist and where their old URLs land. Step AE retired Quotes › Lane rates: the
 * lane history it showed now sits in the Rate intelligence panel (Spot inbox, Quote detail), and the
 * `LaneRateSample` data behind it is untouched. A bookmark or an emailed link must still arrive somewhere.
 */
export const RETIRED_ROUTES: readonly { path: string; to: string }[] = [
  { path: '/tms/rates/lanes', to: '/tms/rates' },
  { path: '/rates', to: '/tms/rates' },
]
