import { useEffect, useMemo, useState, useCallback } from 'react'
import { Loader2, Trash2, FilePlus2, Landmark, Search } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  TmsBadge, TmsButton, TmsCountBadge, TmsDialog, TmsIconButton, TmsInput, TmsSegmentedTabs, TmsStatRow,
  type ColumnDef, type TmsTone,
  TmsTabs,
  type TmsTabGroup,
} from '@/features/tms/kit'
import { DenseGrid } from '@/features/tms/grid/DenseGrid'
import { ClearFiltersButton, ColumnsButton, DensityToggle } from '@/features/tms/grid/DenseControls'
import {
  activeFilterCount, filterRows, nextSort, reorderKeys, sortDenseRows,
  type DenseColumn, type DenseColumnFilter, type DenseFilters,
} from '@/features/tms/grid/denseGridModel'
import { useDenseGridPrefs } from '@/features/tms/grid/useDenseGridPrefs'
import '@/features/tms/styles/directory.css'
import { OtrPanel } from './OtrPanel'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import { ShipmentDrawer } from '@/features/shipments/components/ShipmentDrawer'
import { useAppStore } from '@/store/useAppStore'
import { useFactoringItems } from '@/hooks/useFactoringItems'
import { useAuth } from '@/hooks/useAuth'
import { useDirectory } from '@/hooks/useDirectory'
import { createShipment, getTmsSettings } from '@/lib/apiClient'
import { errorMessage } from '@/lib/utils/errorMessage'
import { canDeleteFactoringItem, canSetCustomerPaid } from '@/lib/auth/admin'
import { toast } from 'sonner'
import { FactoringRowFields } from './FactoringRowFields'
import { fieldsReadyLabel, isReadyToSubmit } from './factoringFields'
import { OTR_FIELD_LABEL, OTR_REQUIRED_FIELDS, type OtrRequiredField } from '@/lib/otrInvoice'
import { invoiceAmountOf, totalsByStatus, money } from './factoringTotals'
import { FactoringDocCell } from './FactoringDocCell'
import { useResolveLoads } from '@/hooks/useResolveLoads'
import type { OtrReadiness } from '@/lib/otrInvoice'
import type { FactoringItem, FactoringItemStatus } from '@/types'
import type { TmsSettings } from '@/types/tms'
import { otrStatusMeta } from '@/lib/otrInvoiceStatus'
import { otrDocsIncomplete, otrDocsErrorMessage } from '@/lib/otrSubmitOutcome'
import { uploadOtrDocs, resolveLoad, assembleInvoice } from '@/lib/otrClient'
import { loadFromFactoringItem } from './loadFromInvoice'
import { ManualInvoicePanel } from './ManualInvoicePanel'
import { manualSentInfo } from '@/lib/manualInvoice'
import { noBuyInfo } from '@/lib/noBuy'
import { mayInvoiceManually, needsManualInvoice, otrRejection } from '@/lib/otrRejection'
import { canReleaseToBilling } from '@/lib/navItems'
import { InvoiceManuallyDialog } from './InvoiceManuallyDialog'
import { CustomerPaidCell, CustomerPaidDialog } from './CustomerPaidCell'
import { formatPaidOn } from './formatPaidOn'
import { ResendToOtrDialog } from './ResendToOtrDialog'
import { offersResend } from '@/lib/factoringResubmit'

// ── Status labels ────────────────────────────────────────────────────────────

const FACTORING_STATUS_LABEL: Record<FactoringItemStatus, string> = {
  NEED_TO_FACTOR:    'Need to factor',
  PENDING_WITH_OTR:  'Pending with OTR',
  MANUAL_INVOICE:    'Invoice manually',
  FACTORED:          'Factored',
  INVOICED_MANUALLY: 'Invoiced manually',
  ARCHIVED:          'Archived',
}

/**
 * Filter order is the order of the work: what still needs doing, what is waiting on OTR,
 * then everything, then what is finished. "Need to factor" is the default because an empty
 * queue there is the only state worth celebrating.
 */
const FILTER_ORDER = ['NEED_TO_FACTOR', 'PENDING_WITH_OTR', 'MANUAL_INVOICE', 'ALL', 'FACTORED', 'INVOICED_MANUALLY', 'ARCHIVED'] as const
type FilterKey = (typeof FILTER_ORDER)[number]

const RED = { color: 'var(--tms-badge-red)' }
const PAGE_STEP = 50

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatReceivedAt(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function relativeReceived(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/**
 * The PRO number, as the way into the load it names.
 *
 * Everything in this queue is discussed by PRO, and the next question after "why is 14538
 * still red" is always on the shipment — its stops, its rate, its rate confirmation.
 * Opening the drawer here beats copying the number onto another page.
 *
 * A row whose PRO never matched a load keeps its plain number: an underline that goes
 * nowhere is worse than no underline.
 */
function ProLink({ loadId, proNumber }: { loadId: string | null | undefined; proNumber: string }) {
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)
  // The identity table on purpose: this resolves a factoring row's load id to a real load,
  // and a voided load is still the owner of that Pro # and that id.
  const loads = useAppStore((s) => s.loads)
  const known = loadId ? loads.some((l) => l.id === loadId) : false
  const text = <span className="font-bold tabular-nums">{proNumber}</span>
  if (!known || !loadId) {
    return <span title="This PRO is not linked to a load yet">{text}</span>
  }
  return (
    <button
      type="button"
      onClick={() => setSelectedLoad(loadId, 'view')}
      aria-label={`Open the load for PRO ${proNumber}`}
      title="Open this load"
      style={{
        border: 'none', background: 'none', padding: 0, cursor: 'pointer',
        fontFamily: 'inherit', color: 'var(--tms-primary)',
        textDecoration: 'underline', textUnderlineOffset: 3,
      }}
    >
      {text}
    </button>
  )
}

/**
 * The readiness the Lambda cached on the row. It is an `a.json()` column, already parsed
 * on read by apiClient, so this is only a cast with a guard rather than a parse.
 */
function readinessOf(item: FactoringItem): OtrReadiness | null {
  const r = item.otrReadiness
  return r && typeof r === 'object' ? (r as OtrReadiness) : null
}

/**
 * Who the invoice bills, and how far to trust it.
 *
 * Nothing looks an MC up today, so no name here is verified against one. The best we have
 * is the broker record this load points at — whose name came from the load and whose MC
 * came from whoever typed one, independently — or a name someone entered against the row.
 */
function customerOf(item: FactoringItem): { name: string; source: string | null } {
  const r = readinessOf(item)
  return { name: (r?.customerName ?? '').trim(), source: r?.customerSource ?? null }
}

const CUSTOMER_SOURCE_NOTE: Record<string, string> = {
  verified: 'Looked up from the broker MC',
  entered: 'Entered on this row',
  directory: 'From the broker record on this load \u2014 not checked against the MC',
  email: 'Read off the forwarded e-mail \u2014 not checked against the MC',
}

/** The PO number OTR requires, once it has resolved. */
function poOf(item: FactoringItem): string {
  const v = readinessOf(item)?.payload?.PoNumber
  return v == null ? '' : String(v)
}

/** Documents OTR still wants. Unknown readiness means both, since neither is proven. */
function missingDocs(item: FactoringItem): Array<'POD' | 'Rate confirmation'> {
  return readinessOf(item)?.missingDocuments ?? ['POD', 'Rate confirmation']
}

function matchesSearch(item: FactoringItem, query: string) {
  if (!query.trim()) return true
  const q = query.toLowerCase().trim()
  return (
    item.proNumber.toLowerCase().includes(q) ||
    item.subject.toLowerCase().includes(q) ||
    item.fromEmail.toLowerCase().includes(q)
  )
}

// ── Row cells ────────────────────────────────────────────────────────────────

/**
 * What the invoice is worth.
 *
 * Pulled from the same resolved payload the invoice is submitted with, so the column and
 * the invoice can never disagree. The rate is typed on the row by the office, so until it
 * is this is a way in rather than a dash: a red cell that does nothing when clicked is how
 * a queue ends up with rows nobody ever priced.
 */
function AmountCell({ item, onEdit }: { item: FactoringItem; onEdit: () => void }) {
  const amount = invoiceAmountOf(item)
  if (amount != null) {
    return <span className="font-semibold tabular-nums">{money(amount)}</span>
  }
  return (
    <TmsButton
      size="sm"
      onClick={onEdit}
      aria-label={`Add the rate for PRO ${item.proNumber}`}
      title="Type the invoice amount for this row"
      style={{ borderColor: 'var(--tms-badge-red)', color: 'var(--tms-badge-red)' }}
    >
      Add rate
    </TmsButton>
  )
}

/**
 * What the queue is worth, per status.
 *
 * Counts were on the tabs already, and a count of invoices is not money. Rows with no rate
 * are called out beside the figure rather than folded into it: a total that silently
 * swallows what it could not price reads as complete and is not.
 */
function StatusTotals({ items }: { items: FactoringItem[] }) {
  const totals = totalsByStatus(items)
  const buckets = [
    ['NEED_TO_FACTOR', 'Need to factor'],
    ['PENDING_WITH_OTR', 'Pending with OTR'],
    ['FACTORED', 'Factored'],
    ['ALL', 'All'],
  ] as const

  return (
    <div className="tms-factoring-totals" style={{ padding: '4px 8px' }}>
      <TmsStatRow
        aria-label="What the queue is worth, by status"
        columns={4}
        compact
        items={buckets.map(([key, label]) => {
          const t = totals[key]
          return {
            key,
            label,
            value: money(t.total),
            ariaLabel: `${label}: ${money(t.total)} across ${t.count} invoices`,
            sub: `${t.count} ${t.count === 1 ? 'invoice' : 'invoices'}${t.missingRate > 0 ? ` \u00b7 ${t.missingRate} with no rate` : ''}`,
            tone: t.missingRate > 0 ? 'warn' : 'default',
          }
        })}
      />
    </div>
  )
}

/** The customer column: the confirmed broker, an unconfirmed guess, or nothing yet. */
function CustomerCell({ item }: { item: FactoringItem }) {
  const { name, source } = customerOf(item)
  if (!name) {
    return <span className="tms-muted" title="Open the row to enter it">{'\u2014'}</span>
  }
  // Only a real lookup earns plain, confident styling. Everything else reads as a guess,
  // because that is what it is.
  const verified = source === 'verified'
  return (
    <span
      title={source ? CUSTOMER_SOURCE_NOTE[source] : undefined}
      className={verified ? 'block truncate font-semibold' : 'block truncate italic tms-muted'}
    >
      {name}
    </span>
  )
}

/**
 * Where a row stands. Reported, never chosen.
 *
 * This was a dropdown, which made the status a label somebody applied rather than a fact
 * about the invoice. A row could read "Pending with OTR" having never been submitted, or
 * "Factored" on money nobody had been paid — and the queue is the thing people use to
 * answer exactly those questions.
 *
 * Each value now has one cause and no other:
 *   Need to factor    — the resting state, until Submit to OTR is pressed
 *   Pending with OTR  — set by the submit, which is also what creates the invoice
 *   Factored          — set when OTR's own board says Paid
 */
const STATUS_CAUSE: Record<FactoringItemStatus, string> = {
  NEED_TO_FACTOR: 'Not submitted yet. Press Submit to OTR on the row to send it.',
  PENDING_WITH_OTR: 'Submitted to OTR. This clears when their board says Paid.',
  MANUAL_INVOICE: 'Going out by hand — OTR will not buy this broker, or it was routed here on purpose. Open the row for the steps.',
  FACTORED: 'OTR has paid this invoice.',
  INVOICED_MANUALLY: 'Sent to the broker’s AP by hand; every step on the row is done.',
  ARCHIVED: 'Taken out of the queue by hand. Nothing was deleted — set a status to bring it back.',
}

const STATUS_TONE: Record<FactoringItemStatus, TmsTone> = {
  NEED_TO_FACTOR: 'orange',
  PENDING_WITH_OTR: 'blue',
  MANUAL_INVOICE: 'pink',
  FACTORED: 'green',
  INVOICED_MANUALLY: 'purple',
  ARCHIVED: 'gray',
}

/**
 * Rows the Invoice manually button applies to: No buy rows, in the queue or already under
 * Invoice manually (the button then finishes the move: Invoice.factored and the customer's
 * default; repeating it changes nothing). Any other row (Dead, an OTR error, just queued)
 * stays with OTR; only an admin gets the button there.
 */
function canMoveManually(item: FactoringItem, user: { email?: string | null; groups?: readonly string[] | null } | null): boolean {
  return mayInvoiceManually(item, user).allowed
}

/** OTR will not buy this paper. Said on the row, with OTR's reason, not only in the panel. */
function NoBuyFlag({ item }: { item: FactoringItem }) {
  const { noBuy, reason } = noBuyInfo(item)
  if (!noBuy) return null
  return (
    <>
      <TmsBadge tone="pink" title={reason ?? undefined}>No buy</TmsBadge>
      {reason && <span className="max-w-[18rem] truncate text-xs tms-muted" title={reason}>{reason}</span>}
    </>
  )
}

/** OTR turned this invoice down for a reason other than "will not buy" (that has its own flag). It stays in the queue until it is resolved with OTR. */
function RejectedFlag({ item }: { item: FactoringItem }) {
  const rejection = otrRejection(item)
  if (!rejection || rejection.kind === 'NO_BUY') return null
  return (
    <>
      <TmsBadge tone="red" title={`${rejection.reason}. Stays in the factoring queue: resolve it with OTR.`} data-testid="otr-rejected-flag">Needs attention</TmsBadge>
      <span className="max-w-[18rem] truncate text-xs tms-muted" title={rejection.reason}>{rejection.reason}</span>
    </>
  )
}

/** OTR's label for the row, or the stand-in for one OTR has not reported on. */
function otrLabelOf(item: FactoringItem): string {
  return otrStatusMeta(item.otrStatus)?.label ?? OTR_UNREPORTED
}

/** The invoice is at OTR without its paperwork: red, with Resend right there, until the documents land. */
function OtrDocsFlag({ item, onResent }: { item: FactoringItem; onResent: () => void }) {
  const [busy, setBusy] = useState(false)
  if (!otrDocsIncomplete(item)) return null
  const resend = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setBusy(true)
    try {
      const r = await uploadOtrDocs(item.id)
      onResent()
      if (r.documentErrors.length) toast.error(otrDocsErrorMessage(r.documentErrors))
      else toast.success(`PRO ${item.proNumber}: documents at OTR — now pending with OTR`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not resend the documents')
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="inline-flex items-center gap-1">
      <TmsBadge
        tone="red"
        title={item.otrError ?? 'A document did not reach OTR — upload it again and press Resend'}
        aria-label={`OTR documents missing for PRO ${item.proNumber}`}
      >
        DOCS NOT AT OTR
      </TmsBadge>
      <TmsButton
        size="sm"
        disabled={busy}
        onClick={(e) => void resend(e)}
        aria-label={`Resend documents for PRO ${item.proNumber}`}
        title="Send the POD and rate con on this row to the invoice OTR already has"
        style={{ borderColor: 'var(--tms-badge-red)', color: 'var(--tms-badge-red)' }}
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : null} Resend
      </TmsButton>
    </span>
  )
}

/**
 * The send record for a row invoiced by hand — when it went out, who sent it, and to
 * which AP address — so the Invoiced manually tab works as the log of everything that
 * left without OTR. The stamps come from the steps the sender ticked.
 */
function SentByHandCell({ item }: { item: FactoringItem }) {
  const sent = manualSentInfo(item)
  if (!sent) return <span className="tms-muted">—</span>
  const who = sent.by.split('@')[0] || 'unknown'
  return (
    <div className="whitespace-nowrap" aria-label={`PRO ${item.proNumber} sent by hand ${formatReceivedAt(sent.at)} by ${who}${sent.to ? ` to ${sent.to}` : ''}`}>
      <span style={{ fontWeight: 600 }}>{formatReceivedAt(sent.at)}</span>
      <span className="tms-muted"> · by {who}{sent.to ? <> · to {sent.to}</> : ' · AP email not recorded'}</span>
    </div>
  )
}

function StatusBadge({ item }: { item: FactoringItem }) {
  const sent = item.status === 'INVOICED_MANUALLY' ? manualSentInfo(item) : null
  const title = sent
    ? `${STATUS_CAUSE[item.status]} Sent ${formatReceivedAt(sent.at)} by ${sent.by}${sent.to ? ` to ${sent.to}` : ''}.`
    : STATUS_CAUSE[item.status]
  return (
    <TmsBadge
      tone={STATUS_TONE[item.status]}
      title={title}
      aria-label={`Status for PRO ${item.proNumber}: ${FACTORING_STATUS_LABEL[item.status]}`}
    >
      {FACTORING_STATUS_LABEL[item.status]}
    </TmsBadge>
  )
}

/** The label the Pending tab's chips use for a row OTR has said nothing about yet. */
const OTR_UNREPORTED = 'Awaiting OTR'

/** What OTR's board says, in OTR's words — on the row, so the tab answers "where is it at OTR" without opening anything. */
function OtrStatusFlag({ item }: { item: FactoringItem }) {
  if (item.status !== 'PENDING_WITH_OTR') return null
  const meta = otrStatusMeta(item.otrStatus)
  const synced = item.otrStatusSyncedAt ? ` · synced ${new Date(item.otrStatusSyncedAt).toLocaleString()}` : ''
  if (!meta) {
    return (
      <TmsBadge
        tone="gray"
        title={`Submitted to OTR; their board has not reported a status yet${synced}`}
        aria-label={`OTR status for PRO ${item.proNumber}: not reported yet`}
        className="tms-otr-unreported"
      >
        OTR: {OTR_UNREPORTED.toLowerCase()}
      </TmsBadge>
    )
  }
  return (
    <TmsBadge
      tone={meta.tone}
      title={`${meta.needsAttention ? 'OTR or the broker is waiting on us' : "OTR's board"}${synced}`}
      aria-label={`OTR status for PRO ${item.proNumber}: ${meta.label}`}
    >
      OTR: {meta.label}{meta.needsAttention ? ' ⚠' : ''}
    </TmsBadge>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

/** `viewTabs`: shown inside Invoicing as its Factored view (Receivable | Factored | Payable). */
export function FactoringPage({ viewTabs }: { viewTabs?: TmsTabGroup } = {}) {
  const { items, loading, error, pendingIds, refresh, removeItem } = useFactoringItems()
  useResolveLoads(items.map((i) => i.loadId))
  const { user, isAdmin } = useAuth()
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState<FilterKey>('NEED_TO_FACTOR')
  /** On the Pending tab: one of OTR's own labels (or OTR_UNREPORTED) to narrow to, or null for all. */
  const [otrFilter, setOtrFilter] = useState<string | null>(null)
  /** Show only the rows OTR turned down (they have to be invoiced by hand), across every tab. */
  const [rejectedOnly, setRejectedOnly] = useState(false)
  /**
   * The row whose editor is open. One at a time and over the list, not inside it: the
   * panel is eleven fields, two documents and a submit button, and ten of those stacked
   * turned a queue of twenty PROs into a page nobody could scan.
   */
  const [openId, setOpenId] = useState<string | null>(null)
  /** The row whose Invoice manually confirmation is open. */
  const [manualMoveId, setManualMoveId] = useState<string | null>(null)
  /** The row whose Customer paid dialog / Send to OTR again confirmation is open. */
  const [paidEditId, setPaidEditId] = useState<string | null>(null)
  const [resendId, setResendId] = useState<string | null>(null)
  const canEditPaid = canSetCustomerPaid(user)

  // Deleting a row drops the record that a PRO was ever sent for factoring, so it is
  // limited to the two people who run factoring rather than every admin.
  const canDelete = canDeleteFactoringItem(user?.email)
  const staffEmail = user?.email ?? ''
  // "Create shipment" on a row whose PRO was never entered in BCAT Ops.
  const [creatingLoadFor, setCreatingLoadFor] = useState<string | null>(null)
  // Where it lands afterwards: the shipment's own detail.
  const [openShipmentId, setOpenShipmentId] = useState<string | null>(null)
  const { customers, locations } = useDirectory()
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  useEffect(() => { getTmsSettings().then(setSettings).catch(() => setSettings(null)) }, [])

  const counts = useMemo(() => ({
    ALL: items.filter((i) => i.status !== 'ARCHIVED').length,
    NEED_TO_FACTOR: items.filter((i) => i.status === 'NEED_TO_FACTOR').length,
    PENDING_WITH_OTR: items.filter((i) => i.status === 'PENDING_WITH_OTR').length,
    MANUAL_INVOICE: items.filter((i) => i.status === 'MANUAL_INVOICE').length,
    FACTORED: items.filter((i) => i.status === 'FACTORED').length,
    INVOICED_MANUALLY: items.filter((i) => i.status === 'INVOICED_MANUALLY').length,
    ARCHIVED: items.filter((i) => i.status === 'ARCHIVED').length,
  }), [items])

  const filtered = useMemo(() => {
    return items
      /*
       * "All" means all the LIVE work, not literally every row. Archived items are the
       * ones somebody deliberately took out of the queue, and putting them back into the
       * default view would undo the only thing archiving does. They keep their own tab so
       * nothing is actually lost.
       */
      .filter((item) =>
        rejectedOnly ? otrRejection(item) != null : activeTab === 'ALL' ? item.status !== 'ARCHIVED' : item.status === activeTab,
      )
      .filter((item) => activeTab !== 'PENDING_WITH_OTR' || !otrFilter || otrLabelOf(item) === otrFilter)
      .filter((item) => matchesSearch(item, search))
      // The Invoiced manually tab is a send log, so it reads newest send first.
      .sort((a, b) => activeTab === 'INVOICED_MANUALLY'
        ? (manualSentInfo(b)?.at ?? '').localeCompare(manualSentInfo(a)?.at ?? '')
        : new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
  }, [items, activeTab, search, otrFilter, rejectedOnly])

  /*
   * The Pending tab broken down by what OTR's board says — IssueClient, IssueFollowUp,
   * Pending — so the rows OTR is waiting on us for are one click away. Counted over the
   * whole tab, not the search, so the chips read the same whatever is typed.
   */
  const otrBreakdown = useMemo(() => {
    const counts = new Map<string, { count: number; attention: boolean }>()
    for (const item of items) {
      if (item.status !== 'PENDING_WITH_OTR') continue
      const label = otrLabelOf(item)
      const cur = counts.get(label) ?? { count: 0, attention: otrStatusMeta(item.otrStatus)?.needsAttention ?? false }
      counts.set(label, { ...cur, count: cur.count + 1 })
    }
    return [...counts.entries()]
      .map(([label, v]) => ({ label, ...v }))
      .sort((a, b) => Number(b.attention) - Number(a.attention) || b.count - a.count || a.label.localeCompare(b.label))
  }, [items])

  /* The grid scrolls (rows are virtualised); this only caps how many a very long queue mounts at once. */
  const [pageSize, setPageSize] = useState(PAGE_STEP)
  const [dense, setDense] = useState<DenseFilters>({})
  const setDenseFilter = useCallback((key: string, next: DenseColumnFilter | null) => {
    setPageSize(PAGE_STEP)
    setDense((prev) => { const copy = { ...prev }; if (next) copy[key] = next; else delete copy[key]; return copy })
  }, [])

  const manualMoveItem = manualMoveId ? items.find((i) => i.id === manualMoveId) ?? null : null
  const paidEditItem = paidEditId ? items.find((i) => i.id === paidEditId) ?? null : null
  const resendItem = resendId ? items.find((i) => i.id === resendId) ?? null : null
  const openItem = openId ? items.find((i) => i.id === openId) ?? null : null
  const manualPanel = openItem?.status === 'MANUAL_INVOICE' || openItem?.status === 'INVOICED_MANUALLY'

  const handleDelete = useCallback(async (item: FactoringItem) => {
    if (!window.confirm(
      `Delete the queue row for PRO ${item.proNumber}?\n\n` +
      'This permanently removes the factoring queue entry. The original email remains in the inbox; forwarding it again will recreate the row.'
    )) return

    try {
      await removeItem(item.id)
      toast.success(`PRO ${item.proNumber} deleted from queue`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete queue row')
    }
  }, [removeItem])

  const columns: ColumnDef<FactoringItem>[] = [
    {
      key: 'pro',
      header: 'PRO #',
      render: (item) => (
        <span className="inline-flex items-center gap-2 whitespace-nowrap">
          <TmsIconButton
            shape="plain"
            aria-expanded={openId === item.id}
            aria-label={
              item.status === 'MANUAL_INVOICE' || item.status === 'INVOICED_MANUALLY'
                ? `${openId === item.id ? 'Hide' : 'Open'} the steps for PRO ${item.proNumber}`
                : `${openId === item.id ? 'Hide' : 'Edit'} the OTR fields for PRO ${item.proNumber}`
            }
            title={item.subject || undefined}
            onClick={() => setOpenId(openId === item.id ? null : item.id)}
          >
            {openId === item.id ? '\u2212' : '\u2026'}
          </TmsIconButton>
          <ProLink loadId={item.loadId} proNumber={item.proNumber} />
          {/* Raised here rather than mailed in: the invoice it bills is ours, and the
              queue row is only the OTR half of it. */}
          {item.source !== 'TMS' && <TmsBadge tone="gray" title="Came in by e-mail to the factoring address">E-mail</TmsBadge>}
          {item.source === 'TMS' && (
            <>
              <TmsBadge tone="blue">TMS</TmsBadge>
              {item.invoiceId && (
                <Link to={`/tms/invoicing/invoices/${item.invoiceId}`} title="Open this invoice">
                  {item.invoiceId}
                </Link>
              )}
            </>
          )}
        </span>
      ),
    },
    {
      key: 'po',
      header: 'PO #',
      render: (item) => (
        <span className="tabular-nums" style={poOf(item) ? undefined : { ...RED, fontWeight: 600 }}>
          {poOf(item) || 'missing'}
        </span>
      ),
    },
    { key: 'customer', header: 'CUSTOMER', width: 190, render: (item) => <CustomerCell item={item} /> },
    {
      key: 'amount',
      header: 'AMOUNT',
      render: (item) => (
        <span className="block whitespace-nowrap text-right">
          <AmountCell item={item} onEdit={() => setOpenId(item.id)} />
        </span>
      ),
    },
    {
      // How close this row is to being invoiceable, as a count then the individual
      // fields. Green means resolved, red means still missing.
      key: 'fields',
      header: 'FIELDS',
      render: (item) => (
        <span
          className="whitespace-nowrap font-bold tabular-nums"
          style={isReadyToSubmit(readinessOf(item)) ? { color: 'var(--tms-badge-green)' } : undefined}
        >
          {fieldsReadyLabel(readinessOf(item))}
        </span>
      ),
    },
    {
      key: 'required',
      header: 'REQUIRED FOR OTR',
      render: (item) => <FactoringRowFields readiness={readinessOf(item)} />,
    },
    {
      key: 'documents',
      header: 'DOCUMENTS',
      render: (item) => (
        <div className="flex items-center gap-1.5">
          {/* No load in BCAT Ops for this PRO: the documents have nothing to attach to until one exists. */}
          {!item.loadId && (
            <TmsButton
              size="sm"
              disabled={creatingLoadFor === item.id}
              title={`No shipment for PRO ${item.proNumber} in BCAT Ops. Create one from this invoice so the POD and rate confirmation can be attached and the row submitted.`}
              onClick={async () => {
                const readiness = readinessOf(item)
                /*
                 * The customer record when the row resolved to one, the row's own typed
                 * text when it did not. Never a guess: an invented name on money OTR has
                 * already bought is worse than a shipment that says it is not linked yet.
                 */
                const typed = readiness?.customerName?.trim() ?? ''
                if (!item.customerId && !typed) {
                  toast.error('This row names no customer at all — fill the customer on the row first.')
                  return
                }
                setCreatingLoadFor(item.id)
                try {
                  /*
                   * `source: 'FACTORING'` is what files the order as AR status LEGACY. The
                   * Aljex invoice for this PRO already went out and OTR already bought it,
                   * so putting it in the AR worklist would double-count collected money
                   * and inflate the customer's credit exposure.
                   */
                  const bundle = await createShipment({
                    ...(item.customerId ? { customerId: item.customerId } : { customerName: typed }),
                    pro: item.proNumber,
                    source: 'FACTORING',
                    load: loadFromFactoringItem(item, readiness, new Date().toISOString()),
                  })
                  await resolveLoad(item.id)
                  await assembleInvoice(item.id).catch(() => undefined)
                  await refresh()
                  toast.success(`Shipment ${bundle.shipment.number} created and linked — upload the POD and rate confirmation now`)
                  setOpenShipmentId(bundle.shipment.id)
                } catch (err) {
                  toast.error(errorMessage(err))
                } finally {
                  setCreatingLoadFor(null)
                }
              }}
            >
              <FilePlus2 size={12} /> {creatingLoadFor === item.id ? 'Creating…' : 'Create shipment'}
            </TmsButton>
          )}
          <FactoringDocCell
            kind="POD"
            present={!missingDocs(item).includes('POD')}
            loadId={item.loadId}
            proNumber={item.proNumber}
            itemId={item.id}
            staffEmail={staffEmail}
            onUploaded={refresh}
          />
          <FactoringDocCell
            kind="RATECON"
            present={!missingDocs(item).includes('Rate confirmation')}
            loadId={item.loadId}
            proNumber={item.proNumber}
            itemId={item.id}
            staffEmail={staffEmail}
            onUploaded={refresh}
          />
        </div>
      ),
    },
    {
      key: 'customerPaid',
      header: 'CUSTOMER PAID',
      render: (item) => <CustomerPaidCell item={item} canEdit={canEditPaid} onEdit={() => setPaidEditId(item.id)} />,
    },
    {
      key: 'received',
      header: activeTab === 'INVOICED_MANUALLY' ? 'SENT' : 'RECEIVED',
      render: (item) => activeTab === 'INVOICED_MANUALLY'
        ? <SentByHandCell item={item} />
        : (
          <span className="whitespace-nowrap tms-muted" title={formatReceivedAt(item.receivedAt)}>
            {relativeReceived(item.receivedAt)}
          </span>
        ),
    },
    {
      key: 'status',
      header: 'STATUS',
      render: (item) => (
        <div className="flex items-center gap-2 whitespace-nowrap">
          <StatusBadge item={item} />
          <OtrStatusFlag item={item} />
          <NoBuyFlag item={item} />
          <RejectedFlag item={item} />
          <OtrDocsFlag item={item} onResent={refresh} />
          {pendingIds.has(item.id) && <Loader2 className="size-3.5 animate-spin tms-muted" />}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'ACTIONS',
      render: (item: FactoringItem) => (
        <div className="flex items-center gap-2 whitespace-nowrap">
          {canMoveManually(item, user) && (
            <TmsButton
              size="sm"
              variant="ghost"
              aria-label={`Invoice manually for PRO ${item.proNumber}`}
              title={mayInvoiceManually(item, user).override ? 'Admin override: OTR has not said No buy for this invoice' : undefined}
              disabled={pendingIds.has(item.id)}
              onClick={() => setManualMoveId(item.id)}
            >
              Invoice manually
            </TmsButton>
          )}
          {offersResend(item) && !noBuyInfo(item).noBuy && (
            <TmsButton
              size="sm"
              variant="secondary"
              aria-label={`Send PRO ${item.proNumber} to OTR again`}
              disabled={pendingIds.has(item.id)}
              onClick={() => setResendId(item.id)}
            >
              Send to OTR again
            </TmsButton>
          )}
          {canDelete && (
            <TmsIconButton
              aria-label={`Delete queue row for PRO ${item.proNumber}`}
              title="Delete queue row"
              disabled={pendingIds.has(item.id)}
              onClick={() => handleDelete(item)}
            >
              <Trash2 size={14} />
            </TmsIconButton>
          )}
        </div>
      ),
    },
  ]

  const sentAtOf = (item: FactoringItem) => manualSentInfo(item)?.at ?? ''
  const resolvedCount = (item: FactoringItem) => { const r = readinessOf(item); return r ? OTR_REQUIRED_FIELDS.length - r.missingFields.length : -1 }
  const denseCols = useMemo<Array<DenseColumn<FactoringItem>>>(() => [
    { key: 'pro', header: 'PRO #', group: 'Invoice', text: (i) => i.proNumber, extraPx: 110 },
    { key: 'po', header: 'PO #', group: 'Invoice', text: (i) => poOf(i) || 'missing' },
    { key: 'customer', header: 'Customer', group: 'Invoice', text: (i) => customerOf(i).name || '\u2014', width: 190 },
    {
      key: 'amount', header: 'Amount', group: 'Invoice', align: 'right', extraPx: 24,
      text: (i) => { const a = invoiceAmountOf(i); return a == null ? 'Add rate' : money(a) },
      sortValue: (i) => { const a = invoiceAmountOf(i); return a == null ? null : Math.round(a * 100) },
      filter: 'number', numberUnit: '$', numberOf: (i) => invoiceAmountOf(i),
    },
    { key: 'fields', header: 'Fields', group: 'OTR readiness', text: (i) => fieldsReadyLabel(readinessOf(i)), sortValue: (i) => resolvedCount(i) },
    {
      key: 'required', header: 'Required for OTR', group: 'OTR readiness', sortable: false,
      text: (i) => { const r = readinessOf(i); return !r ? 'Not prepared yet' : r.missingFields.length ? `Missing: ${r.missingFields.map((f: OtrRequiredField) => OTR_FIELD_LABEL[f]).join(', ')}` : 'All fields resolved' },
      extraPx: 120,
    },
    {
      key: 'documents', header: 'Documents', group: 'OTR readiness', sortable: false, extraPx: 150,
      text: (i) => { const m = missingDocs(i); return m.length ? `Missing: ${m.join(', ')}` : 'POD and rate con on file' },
      filter: 'multi',
      optionsOf: (i) => { const m = missingDocs(i); return m.length ? m.map((d) => ({ value: d, label: `${d} missing` })) : [{ value: 'complete', label: 'Complete' }] },
    },
    {
      key: 'customerPaid', header: 'Customer paid', group: 'Status', extraPx: 40,
      text: (i) => formatPaidOn(i.customerPaidOn) || '\u2014',
      sortValue: (i) => i.customerPaidOn ?? null,
      filter: 'date', dateOf: (i) => i.customerPaidOn ?? null,
    },
    {
      key: 'received', header: activeTab === 'INVOICED_MANUALLY' ? 'Sent' : 'Received', group: 'Status', extraPx: activeTab === 'INVOICED_MANUALLY' ? 200 : 0,
      text: (i) => activeTab === 'INVOICED_MANUALLY' ? (manualSentInfo(i) ? formatReceivedAt(sentAtOf(i)) : '\u2014') : relativeReceived(i.receivedAt),
      sortValue: (i) => (activeTab === 'INVOICED_MANUALLY' ? sentAtOf(i) : i.receivedAt) || null,
      filter: 'date', dateOf: (i) => (activeTab === 'INVOICED_MANUALLY' ? sentAtOf(i) : i.receivedAt) || null,
    },
    {
      key: 'status', header: 'Status', group: 'Status', extraPx: 130,
      text: (i) => `${FACTORING_STATUS_LABEL[i.status]}${i.status === 'PENDING_WITH_OTR' ? ` \u00b7 OTR: ${otrLabelOf(i)}` : ''}${noBuyInfo(i).noBuy ? ' \u00b7 No buy' : ''}${otrRejection(i) && !noBuyInfo(i).noBuy ? ' \u00b7 Needs attention' : ''}`,
      filter: 'multi',
      optionsOf: (i) => [{ value: i.status, label: FACTORING_STATUS_LABEL[i.status] }],
      sortValue: (i) => FACTORING_STATUS_LABEL[i.status],
    },
    { key: 'actions', header: 'Actions', group: 'Status', text: () => '', fixed: true, filter: false, sortable: false, width: 280 },
  ], [activeTab])
  const prefs = useDenseGridPrefs({
    gridId: 'factoring-queue',
    email: user?.email,
    defaultColumns: denseCols.map((c) => c.key),
    validKeys: denseCols.map((c) => c.key),
    defaultSort: null,
  })
  const gridColumns = useMemo(
    () => prefs.columns.map((k) => denseCols.find((c) => c.key === k)).filter((c): c is DenseColumn<FactoringItem> => c != null),
    [denseCols, prefs.columns],
  )
  const gridRows = useMemo(() => sortDenseRows(filterRows(filtered, denseCols, dense), denseCols, prefs.sort), [filtered, denseCols, dense, prefs.sort])
  const shown = gridRows.slice(0, pageSize)
  const renderFactoringCell = (item: FactoringItem, key: string) => columns.find((c) => c.key === key)?.render(item) ?? null
  const rejected = useMemo(() => needsManualInvoice(items), [items])
  const rejectedNoBuy = rejected.filter((i) => otrRejection(i)?.kind === 'NO_BUY').length
  const rejectedAttention = rejected.length - rejectedNoBuy
  const filterCount = activeFilterCount(dense) + (search.trim() ? 1 : 0) + (otrFilter ? 1 : 0) + (rejectedOnly ? 1 : 0)
  const resetPaging = () => setPageSize(PAGE_STEP)

  return (
    <>
      <div className="tms-dense-page">
        {viewTabs ? <TmsTabs tabs={viewTabs.tabs} active={viewTabs.active} onSelect={viewTabs.onSelect} /> : null}
        <div className="tms-dense-bar">
          <h1 className="tms-dense-title" style={{ margin: 0 }}><Landmark size={18} aria-hidden="true" /> {viewTabs ? 'Invoicing · Factored' : 'Factoring'}</h1>
          <Search size={14} className="tms-muted" aria-hidden="true" />
          <TmsInput
            className="tms-dense-search"
            aria-label="Search"
            placeholder="Search PRO, subject, or sender\u2026"
            value={search}
            onChange={(e) => { setSearch(e.target.value); resetPaging() }}
          />
          <TmsSegmentedTabs
            aria-label="Factoring status"
            size="sm"
            active={activeTab}
            onSelect={(key) => { setActiveTab(key as FilterKey); resetPaging() }}
            tabs={FILTER_ORDER.map((key) => ({ key, label: key === 'ALL' ? 'All' : FACTORING_STATUS_LABEL[key], count: counts[key] }))}
          />
          <ClearFiltersButton count={filterCount} onClear={() => { setSearch(''); setOtrFilter(null); setDense({}); resetPaging() }} />
          <span className="tms-dense-spacer" />
          <TmsButton size="sm" variant="secondary" onClick={() => { void refresh() }}>Refresh</TmsButton>
          <ColumnsButton catalog={denseCols} columns={prefs.columns} widths={prefs.widths} pinned={prefs.pinned} onApply={(next) => prefs.applyLayout({ ...next, replaceWidths: true })} />
          <DensityToggle density={prefs.density} onChange={prefs.setDensity} />
        </div>
        {error && <p style={RED}>{error}</p>}
        {rejected.length > 0 && (
          <div role="status" data-testid="otr-rejected-strip" className="flex flex-wrap items-center gap-2" style={{ padding: '6px 8px', background: 'var(--tms-badge-red-tint, transparent)' }}>
            <TmsBadge tone="red">{rejected.length}</TmsBadge>
            <span className="text-sm">
              {rejectedNoBuy > 0 && <>{rejectedNoBuy} {rejectedNoBuy === 1 ? 'invoice' : 'invoices'} OTR will not buy: invoice manually.</>}
              {rejectedNoBuy > 0 && rejectedAttention > 0 && ' '}
              {rejectedAttention > 0 && <>{rejectedAttention} {rejectedAttention === 1 ? 'invoice needs' : 'invoices need'} attention at OTR (Dead or refused): resolve with OTR.</>}
            </span>
            <TmsButton size="sm" variant="secondary" aria-pressed={rejectedOnly} data-testid="otr-rejected-toggle" onClick={() => { setRejectedOnly((v) => !v); resetPaging() }}>
              {rejectedOnly ? 'Show the whole queue' : 'Show them'}
            </TmsButton>
          </div>
        )}
        {activeTab === 'PENDING_WITH_OTR' && otrBreakdown.length > 0 && (
          <div role="group" aria-label="OTR status" className="flex flex-wrap items-center gap-2" style={{ padding: '4px 8px' }}>
            <span className="text-[11px] font-semibold uppercase tracking-wider tms-muted">OTR says</span>
            {otrBreakdown.map(({ label, count, attention }) => {
              const meta = label === OTR_UNREPORTED ? null : otrStatusMeta(label)
              const on = otrFilter === label
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => { setOtrFilter(on ? null : label); resetPaging() }}
                  title={attention ? 'OTR or the broker is waiting on us' : undefined}
                  className={`tms-badge tms-badge-${meta ? meta.tone : 'gray'} tms-otr-chip${meta ? '' : ' tms-otr-chip-unreported'}${on ? ' tms-active' : ''}`}
                >
                  {label}{attention ? ' \u26a0' : ''}
                  <TmsCountBadge count={count} />
                </button>
              )
            })}
          </div>
        )}
        {/* What the queue is worth, not just how many rows are in it. */}
        <StatusTotals items={items} />
        <div className="tms-dense-body">
          <DenseGrid<FactoringItem>
            aria-label="Factoring queue"
            recentKey={`tms:factoring:recent:${user?.email ?? 'anon'}`}
            resetKey={`${activeTab}|${rejectedOnly}|${otrFilter ?? ''}|${search}|${JSON.stringify(dense)}|${JSON.stringify(prefs.sort)}`}
            columns={gridColumns}
            rows={shown}
            fitRows={filtered}
            rowKey={(item) => item.id}
            renderCell={renderFactoringCell}
            density={prefs.density}
            userWidths={prefs.widths}
            stickyCount={Math.max(1, prefs.pinned.length)}
            sort={prefs.sort}
            onSort={(key) => prefs.setSort(nextSort(prefs.sort, key))}
            filters={dense}
            onFilterChange={setDenseFilter}
            onReorder={(from, to) => prefs.setColumns(reorderKeys(prefs.columns, from, to))}
            onResize={prefs.setWidth}
            empty={
              loading && items.length === 0
                ? 'Loading factoring queue\u2026'
                : error ? 'Couldn\u2019t load queue. Try refreshing.' : 'No items match the current filters.'
            }
          />
          <div className="tms-dense-bar" data-testid="factoring-count">
            <span className="tms-muted">Showing {shown.length} of {gridRows.length}</span>
            {gridRows.length > shown.length && (
              <TmsButton size="sm" variant="secondary" onClick={() => setPageSize((n) => n + PAGE_STEP)}>Show next {PAGE_STEP}</TmsButton>
            )}
          </div>
        </div>
      </div>

      {/* The editor, over the queue rather than inside it. */}
      {openItem && (
        <TmsDialog
          open
          onOpenChange={(next) => { if (!next) setOpenId(null) }}
          title={`PRO ${openItem.proNumber}`}
          className="tms-dialog-xl"
        >
          {manualPanel
            ? <ManualInvoicePanel item={openItem} onChanged={refresh} />
            : <OtrPanel item={openItem} onChanged={refresh} />}
        </TmsDialog>
      )}

      {manualMoveItem && (
        <InvoiceManuallyDialog
          item={manualMoveItem}
          customer={customers.find((c) => c.id === manualMoveItem.customerId) ?? null}
          canChangeDefault={canReleaseToBilling(user?.groups, user?.email)}
          onClose={() => setManualMoveId(null)}
          onDone={refresh}
        />
      )}

      {paidEditItem && <CustomerPaidDialog item={paidEditItem} onClose={() => setPaidEditId(null)} onDone={refresh} />}
      {resendItem && <ResendToOtrDialog item={resendItem} onClose={() => setResendId(null)} onDone={refresh} />}

      {/* Opened by the PRO column — the leg editor, for the documents on it. */}
      <LoadDrawer />

      {/* Where "Create shipment" lands. */}
      <ShipmentDrawer
        shipmentId={openShipmentId}
        onClose={() => setOpenShipmentId(null)}
        onChanged={refresh}
        customers={customers}
        locations={locations}
        settings={settings}
        isAdmin={isAdmin}
        currentUser={staffEmail}
      />
    </>
  )
}
