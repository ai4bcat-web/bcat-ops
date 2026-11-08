/**
 * Ryne's nine Brokerage cards (`TMS_BUILD_BRIEF.md`, direction change rule 4), in the
 * order he listed them: the board, the DAT post, the money by rep, the leaderboard, the
 * tracking picture live and historical, and the two POD cards.
 *
 * The arithmetic lives in `src/lib/brokerageCharts.ts`; this file is the catalogue —
 * key, title, kind and which function a card computes with — so the page renders these
 * exactly like the 17 Classic cards and the chart picker is one list of keys.
 */
import {
  apByRep,
  arByRep,
  datPosted,
  podNeeded,
  podTiming,
  repLeaderboard,
  statusCounts,
  trackingHistory,
  trackingLive,
} from '@/lib/brokerageCharts'
import type { ChartDef } from './types'

export const BROKERAGE_CHARTS: ChartDef[] = [
  {
    key: 'status-counts',
    title: 'Shipments in each status',
    group: 'brokerage',
    kind: 'bar',
    compute: statusCounts,
  },
  {
    key: 'dat-posted',
    title: 'Posted to DAT',
    group: 'brokerage',
    kind: 'bar',
    compute: datPosted,
  },
  {
    key: 'ar-by-rep',
    title: 'Outstanding AR by rep',
    group: 'brokerage',
    kind: 'bar',
    compute: arByRep,
  },
  {
    key: 'ap-by-rep',
    title: 'Outstanding AP by rep',
    group: 'brokerage',
    kind: 'bar',
    compute: apByRep,
  },
  {
    key: 'rep-leaderboard',
    title: 'Rep leaderboard',
    group: 'brokerage',
    kind: 'table',
    // A league table has one row per rep; the group-by has nowhere to go in it.
    compute: repLeaderboard,
  },
  {
    key: 'tracking-live',
    title: 'Being tracked now',
    group: 'brokerage',
    kind: 'bar',
    compute: trackingLive,
  },
  {
    key: 'tracking-history',
    title: 'Tracking history',
    group: 'brokerage',
    kind: 'bar',
    // The bars are the tracking sources, so a second dimension has nowhere to go.
    compute: trackingHistory,
  },
  {
    key: 'pod-needed',
    title: 'Shipments needing PODs',
    group: 'brokerage',
    kind: 'table',
    compute: podNeeded,
  },
  {
    key: 'pod-timing',
    title: 'POD collection by carrier',
    group: 'brokerage',
    kind: 'table',
    compute: podTiming,
  },
]

export default BROKERAGE_CHARTS
