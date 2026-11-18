/**
 * A person's own layout for one Shipments list, kept next to the team default (teamColumnLayout.ts).
 *
 * - A person with no layout of their own sees the team default.
 * - A person with one sees theirs, and can switch back to the team default or reset to it.
 * - When an admin saves the team default after a person last saved theirs, the board says so once
 *   and offers a switch; the person's own layout is never replaced.
 * - Money, invoice and payables columns stay out of a layout for anyone without an accounting
 *   page, unless the team default already shows that column to them.
 */
import type { ShipmentColumnTemplateRecord } from '@/types/tms'
import type { ShipmentList } from '@/lib/shipmentLists'
import { personalTemplateId } from '@/lib/personalColumnLayout'
import { ACCOUNTING_PAGE_KEYS, hasAccountingPage } from '@/lib/accountingAccess'
import {
  TEAM_DEFAULT_COLUMN_TEMPLATE_ID, resolveTeamLayout, teamTemplateIdFor,
  type TeamColumnLayout,
} from './teamColumnLayout'

type TemplateRow = Pick<ShipmentColumnTemplateRecord, 'id' | 'columns' | 'widths' | 'pinned'> & {
  ownerEmail?: string | null
  updatedAt?: string | null
}

/**
 * Columns that show what a load earns, costs, is owed or has been paid: customer and carrier money, profit,
 * invoices, AR, AP and factoring. Only people with an accounting page may add them to a layout of their own.
 */
export const MONEY_COLUMN_KEYS: ReadonlySet<string> = new Set([
  'customerTotalRate', 'carrierTotalRates', 'grossProfit', 'netMargin',
  'customerRate', 'orderRevenue', 'loadRate', 'carrierRate', 'legCost', 'quoteAmount',
  'arStatus', 'arStatusChangedAt', 'arBalance', 'invoiceNumber', 'invoicedAt', 'paidAt', 'invoiceStatus',
  'factorInfo', 'factoringItem', 'pastDueDays', 'readyToInvoice',
  'apStatus', 'apBalance', 'apPaidAt', 'quickPay', 'paymentTerms', 'creditLimit',
])

/** Whether this person holds any accounting page (the owner and admins hold them all). */
export function holdsAnyAccountingPage(groups: readonly string[] | null | undefined, email: string | null | undefined): boolean {
  return ACCOUNTING_PAGE_KEYS.some((key) => hasAccountingPage(groups, email, key))
}

/**
 * The column keys this person may choose from: everything, but the money columns only for people with an
 * accounting page. `teamColumns` are what the team default already shows them, so a layout never loses a
 * column they have always seen.
 */
export function allowedColumnKeys(
  allKeys: readonly string[],
  moneyAllowed: boolean,
  teamColumns: readonly string[] = [],
): string[] {
  if (moneyAllowed) return [...allKeys]
  return allKeys.filter((k) => !MONEY_COLUMN_KEYS.has(k) || teamColumns.includes(k))
}

/** Drops the columns (and their widths and pins) a person may not have. Keeps at least what is left, never an empty grid. */
export function limitLayoutToAllowed(layout: TeamColumnLayout, allowed: readonly string[]): TeamColumnLayout {
  const ok = new Set(allowed)
  const columns = layout.columns.filter((k) => ok.has(k))
  if (columns.length === layout.columns.length) return layout
  if (columns.length === 0) return layout
  return {
    columns,
    widths: Object.fromEntries(Object.entries(layout.widths).filter(([k]) => columns.includes(k))),
    pinned: layout.pinned.filter((k) => columns.includes(k)),
  }
}

/** This person's saved row for `list`, or null. A row that does not name them as its owner is never theirs. */
export function personalRow(list: ShipmentList, templates: readonly TemplateRow[], email: string): TemplateRow | null {
  if (!email.trim()) return null
  const id = personalTemplateId(list, email)
  const row = templates.find((t) => t.id === id)
  if (!row) return null
  if ((row.ownerEmail ?? '').trim().toLowerCase() !== email.trim().toLowerCase()) return null
  return row
}

/**
 * The layout this person saved for `list`, cleaned the way the team layout is (a retired column is dropped, a pin
 * on a hidden column is dropped); null when they have none or none of its columns still exist.
 */
export function resolvePersonalLayout(
  list: ShipmentList,
  templates: readonly TemplateRow[],
  email: string,
  validKeys: readonly string[],
  defaultColumns: readonly string[],
  defaultPinned: readonly string[] = [],
): TeamColumnLayout | null {
  const row = personalRow(list, templates, email)
  if (!row || !Array.isArray(row.columns)) return null
  const valid = new Set(validKeys)
  if (!row.columns.some((k) => typeof k === 'string' && valid.has(k))) return null
  return resolveTeamLayout([{ ...row, id: TEAM_DEFAULT_COLUMN_TEMPLATE_ID }], validKeys, defaultColumns, defaultPinned)
}

export type LayoutMode = 'mine' | 'team'

/** The layout the board shows: their own when they have one and have not switched to the team default. */
export function pickLayout(
  mode: LayoutMode,
  personal: TeamColumnLayout | null,
  team: TeamColumnLayout,
): { layout: TeamColumnLayout; source: LayoutMode } {
  if (mode === 'mine' && personal) return { layout: personal, source: 'mine' }
  return { layout: team, source: 'team' }
}

/**
 * True when an admin saved the team default for `list` after this person last saved their own layout, and the person
 * has not already looked at that version of it. `seenTeamUpdatedAt` is the team save time they last dismissed.
 */
export function teamDefaultIsNewer(
  list: ShipmentList,
  templates: readonly TemplateRow[],
  email: string,
  seenTeamUpdatedAt: string | null,
): boolean {
  const mine = personalRow(list, templates, email)
  if (!mine?.updatedAt) return false
  const team = templates.find((t) => t.id === teamTemplateIdFor(list))
  const teamAt = team?.updatedAt ?? null
  if (!teamAt || teamAt <= mine.updatedAt) return false
  return seenTeamUpdatedAt == null || teamAt > seenTeamUpdatedAt
}

export function teamUpdatedAtFor(list: ShipmentList, templates: readonly TemplateRow[]): string | null {
  return templates.find((t) => t.id === teamTemplateIdFor(list))?.updatedAt ?? null
}

// What a person last chose to look at (their layout or the team's) and which team update they have seen, per browser.
const MODE_KEY = 'bcat.shipments.layoutMode'
const SEEN_KEY = 'bcat.shipments.teamLayoutSeen'

function scoped(key: string, userKey: string, list: ShipmentList): string {
  return `${key}.${userKey || 'anon'}.${list}`
}

export function readLayoutMode(userKey: string, list: ShipmentList): LayoutMode {
  try {
    return window.localStorage.getItem(scoped(MODE_KEY, userKey, list)) === 'team' ? 'team' : 'mine'
  } catch {
    return 'mine'
  }
}

export function writeLayoutMode(userKey: string, list: ShipmentList, mode: LayoutMode): void {
  try { window.localStorage.setItem(scoped(MODE_KEY, userKey, list), mode) } catch { /* private window or blocked site data: the choice just does not stick */ }
}

export function readSeenTeamUpdate(userKey: string, list: ShipmentList): string | null {
  try { return window.localStorage.getItem(scoped(SEEN_KEY, userKey, list)) } catch { return null }
}

export function writeSeenTeamUpdate(userKey: string, list: ShipmentList, at: string): void {
  try { window.localStorage.setItem(scoped(SEEN_KEY, userKey, list), at) } catch { /* see above */ }
}
