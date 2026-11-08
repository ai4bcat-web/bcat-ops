/**
 * Step AI §8.2 — the built-in Overview every non-viewAll user gets instead of the classic
 * client-computed page. Run server-side through the same VisibleReader as any dashboard.
 * Relative imports only (Lambda-bundled; the client imports it for titles and layout).
 */
import type { DashboardSpec } from './types'

export const OVERVIEW_SPEC: DashboardSpec = {
  v: 1,
  title: 'Overview',
  description: 'This month at a glance, for the customers you own or your team covers.',
  scope: { kind: 'ME' },
  filters: { window: { preset: 'THIS_MONTH' }, divisions: [], customerIds: [], repIds: [], modes: [] },
  widgets: [
    { id: 'w1', type: 'KPI', title: 'Revenue', size: 'M', query: { id: 'fin.summary', params: { metrics: ['revenue', 'profit', 'margin'] } } },
    { id: 'w2', type: 'KPI', title: 'Shipments', size: 'M', query: { id: 'ship.summary', params: { metrics: ['count', 'delivered', 'inTransit'] } } },
    { id: 'w3', type: 'KPI', title: 'Open receivables', size: 'M', query: { id: 'ar.summary', params: { metrics: ['open', 'overdue', 'count'] } } },
    { id: 'w4', type: 'KPI', title: 'Quotes', size: 'M', query: { id: 'quote.summary', params: { metrics: ['count', 'won', 'openValue'] } } },
    { id: 'w5', type: 'PIE', title: 'Shipments by status', size: 'M', query: { id: 'ship.byStatus', params: {} } },
    { id: 'w6', type: 'BAR', title: 'Revenue by customer', size: 'M', query: { id: 'fin.byGroup', params: { metric: 'revenue', groupBy: 'CUSTOMER', limit: 10 } } },
    { id: 'w7', type: 'BAR', title: 'AR aging', size: 'M', query: { id: 'ar.aging', params: {} } },
    { id: 'w8', type: 'TABLE', title: 'Open AR by customer', size: 'M', query: { id: 'ar.byCustomer', params: { limit: 10 } } },
    { id: 'w9', type: 'LIST', title: 'Recent shipments', size: 'F', query: { id: 'ship.recent', params: { limit: 10 } } },
  ],
}
