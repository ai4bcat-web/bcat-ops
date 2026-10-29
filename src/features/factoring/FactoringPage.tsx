import { useMemo, useState, useCallback } from 'react'
import { Loader2, Trash2, FilePlus2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  TmsBadge, TmsButton, TmsCard, TmsDialog, TmsIconButton, TmsListPage, TmsSelect,
  type ColumnDef, type TmsTone,
} from '@/features/tms/kit'
import { OtrPanel } from './OtrPanel'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import { useAppStore } from '@/store/useAppStore'
import { useFactoringItems } from '@/hooks/useFactoringItems'
import { useAuth } from '@/hooks/useAuth'
import { canDeleteFactoringItem } from '@/lib/auth/admin'
import { toast } from 'sonner'
import { FactoringRowFields } from './FactoringRowFields'
import { fieldsReadyLabel, isReadyToSubmit } from './factoringFields'
import { invoiceAmountOf, totalsByStatus, money } from './factoringTotals'
import { FactoringDocCell } from './FactoringDocCell'
import type { OtrReadiness } from '@/lib/otrInvoice'
import type { FactoringItem, FactoringItemStatus } from '@/types'
import { otrStatusMeta } from '@/lib/otrInvoiceStatus'
import { otrDocsIncomplete, otrDocsErrorMessage } from '@/lib/otrSubmitOutcome'
import { uploadOtrDocs, resolveLoad, assembleInvoice } from '@/lib/otrClient'
import { loadFromFactoringItem } from './loadFromInvoice'
import { ManualInvoicePanel } from './ManualInvoicePanel'

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
    <TmsCard title="What the queue is worth">
      <div role="group" aria-label="What the queue is worth, by status" className="flex flex-wrap gap-3">
        {buckets.map(([key, label]) => {
          const t = totals[key]
          return (
            <div
              key={key}
              aria-label={`${label}: ${money(t.total)} across ${t.count} invoices`}
              className="min-w-[160px] flex-1 px-3 py-2"
              style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
            >
              <p className="text-[11px] font-semibold uppercase tracking-wider tms-muted">{label}</p>
              <p className="text-lg font-bold tabular-nums">{money(t.total)}</p>
              <p className="text-[11px] tms-muted">
                {t.count} {t.count === 1 ? 'invoice' : 'invoices'}
                {t.missingRate > 0 && (
                  <span className="font-semibold" style={RED}> {'\u00b7'} {t.missingRate} with no rate</span>
                )}
              </p>
            </div>
          )
        })}
      </div>
    </TmsCard>
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

/** OTR knows this broker and will not buy its paper. Said on the row, not only in the panel. */
function NoBuyFlag({ item }: { item: FactoringItem }) {
  if (item.brokerCheckResult !== 'NO_BUY') return null
  return (
    <TmsBadge tone="pink" title={`OTR will not buy from MC ${item.brokerMcChecked ?? ''} — invoice manually`}>
      NO BUY
    </TmsBadge>
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

function StatusBadge({ item }: { item: FactoringItem }) {
  return (
    <TmsBadge
      tone={STATUS_TONE[item.status]}
      title={STATUS_CAUSE[item.status]}
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
      <span
        title={`Submitted to OTR; their board has not reported a status yet${synced}`}
        aria-label={`OTR status for PRO ${item.proNumber}: not reported yet`}
        className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold tms-muted"
        style={{ border: '1px dashed var(--tms-border)', whiteSpace: 'nowrap' }}
      >
        OTR: {OTR_UNREPORTED.toLowerCase()}
      </span>
    )
  }
  return (
    <span
      title={`${meta.needsAttention ? 'OTR or the broker is waiting on us' : "OTR's board"}${synced}`}
      aria-label={`OTR status for PRO ${item.proNumber}: ${meta.label}`}
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold"
      style={{
        whiteSpace: 'nowrap',
        background: meta.tone.bg,
        color: meta.tone.fg,
        border: `1px solid ${meta.tone.border}`,
      }}
    >
      OTR: {meta.label}{meta.needsAttention ? ' ⚠' : ''}
    </span>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export function FactoringPage() {
  const { items, loading, error, pendingIds, refresh, removeItem } = useFactoringItems()
  const { user } = useAuth()
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState<FilterKey>('NEED_TO_FACTOR')
  /** On the Pending tab: one of OTR's own labels (or OTR_UNREPORTED) to narrow to, or null for all. */
  const [otrFilter, setOtrFilter] = useState<string | null>(null)
  /**
   * The row whose editor is open. One at a time and over the list, not inside it: the
   * panel is eleven fields, two documents and a submit button, and ten of those stacked
   * turned a queue of twenty PROs into a page nobody could scan.
   */
  const [openId, setOpenId] = useState<string | null>(null)

  // Deleting a row drops the record that a PRO was ever sent for factoring, so it is
  // limited to the two people who run factoring rather than every admin.
  const canDelete = canDeleteFactoringItem(user?.email)
  const staffEmail = user?.email ?? ''
  // "Create load" on a row whose PRO was never entered in BCAT Ops.
  const addLoad = useAppStore((s) => s.addLoad)
  const [creatingLoadFor, setCreatingLoadFor] = useState<string | null>(null)

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
        activeTab === 'ALL' ? item.status !== 'ARCHIVED' : item.status === activeTab,
      )
      .filter((item) => activeTab !== 'PENDING_WITH_OTR' || !otrFilter || otrLabelOf(item) === otrFilter)
      .filter((item) => matchesSearch(item, search))
      .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
  }, [items, activeTab, search, otrFilter])

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

  /*
   * Ten at a time: the queue runs to hundreds, and a page of ten is what somebody works
   * through before refreshing.
   */
  const [perPage, setPerPage] = useState(10)
  const pageCount = Math.max(1, Math.ceil(filtered.length / perPage))

  /*
   * The page number is remembered AGAINST the filter it belongs to, rather than reset by
   * an effect. Changing tab, search or page size yields a different key, so page 1 is what
   * this render reads — no second render, and no window where the table is empty because
   * the rows are behind you.
   */
  const filterKey = `${activeTab}|${otrFilter ?? ''}|${search}|${perPage}`
  const [pageState, setPageState] = useState({ key: filterKey, page: 1 })
  const page = pageState.key === filterKey ? pageState.page : 1
  const setPage = (next: number | ((p: number) => number)) =>
    setPageState({ key: filterKey, page: typeof next === 'function' ? next(page) : next })
  const safePage = Math.min(page, pageCount)
  const paged = useMemo(
    () => filtered.slice((safePage - 1) * perPage, safePage * perPage),
    [filtered, safePage, perPage],
  )

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
              title={`No load for PRO ${item.proNumber} in BCAT Ops. Create one from this invoice so the POD and rate confirmation can be attached and the row submitted.`}
              onClick={async () => {
                setCreatingLoadFor(item.id)
                try {
                  const created = await addLoad(loadFromFactoringItem(item, readinessOf(item), staffEmail, new Date().toISOString()))
                  await resolveLoad(item.id)
                  await assembleInvoice(item.id).catch(() => undefined)
                  await refresh()
                  toast.success(`Load ${created.aljexId} created and linked — upload the POD and rate confirmation now`)
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Could not create the load')
                } finally {
                  setCreatingLoadFor(null)
                }
              }}
            >
              <FilePlus2 size={12} /> {creatingLoadFor === item.id ? 'Creating…' : 'Create load'}
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
      key: 'received',
      header: 'RECEIVED',
      render: (item) => (
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
          <OtrDocsFlag item={item} onResent={refresh} />
          {pendingIds.has(item.id) && <Loader2 className="size-3.5 animate-spin tms-muted" />}
        </div>
      ),
    },
    ...(canDelete
      ? [{
        key: 'actions',
        header: 'ACTIONS',
        render: (item: FactoringItem) => (
          <TmsIconButton
            aria-label={`Delete queue row for PRO ${item.proNumber}`}
            title="Delete queue row"
            disabled={pendingIds.has(item.id)}
            onClick={() => handleDelete(item)}
          >
            <Trash2 size={14} />
          </TmsIconButton>
        ),
      }]
      : []),
  ]

  return (
    <>
      <TmsListPage<FactoringItem>
        title="Factoring"
        quickTabs={{
          tabs: FILTER_ORDER.map((key) => ({
            key,
            label: key === 'ALL' ? 'All' : FACTORING_STATUS_LABEL[key],
            count: counts[key],
          })),
          active: activeTab,
          onSelect: (key) => setActiveTab(key as FilterKey),
        }}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: 'Search PRO, subject, or sender…',
        }}
        onRefresh={() => { void refresh() }}
        banner={
          <>
            {error && <p style={RED}>{error}</p>}
            {activeTab === 'PENDING_WITH_OTR' && otrBreakdown.length > 0 && (
              <div role="group" aria-label="OTR status" className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider tms-muted">OTR says</span>
                {otrBreakdown.map(({ label, count, attention }) => {
                  const meta = label === OTR_UNREPORTED ? null : otrStatusMeta(label)
                  const on = otrFilter === label
                  return (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setOtrFilter(on ? null : label)}
                      title={attention ? 'OTR or the broker is waiting on us' : undefined}
                      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-bold"
                      style={{
                        cursor: 'pointer',
                        background: meta ? meta.tone.bg : 'transparent',
                        color: meta ? meta.tone.fg : 'var(--tms-muted)',
                        border: `${meta ? '1px solid' : '1px dashed'} ${meta ? meta.tone.border : 'var(--tms-border)'}`,
                        outline: on ? '2px solid var(--tms-primary)' : 'none',
                        outlineOffset: 1,
                      }}
                    >
                      {label}{attention ? ' ⚠' : ''}
                      <span className="rounded-full px-1.5 text-[10px] font-bold" style={{ background: 'rgba(0,0,0,0.15)' }}>
                        {count}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            {/* What the queue is worth, not just how many rows are in it. */}
            <StatusTotals items={items} />
          </>
        }
        columns={columns}
        rows={paged}
        rowKey={(item) => item.id}
        page={{
          from: filtered.length === 0 ? 0 : (safePage - 1) * perPage + 1,
          to: Math.min(safePage * perPage, filtered.length),
          total: filtered.length,
          pageSize: perPage,
        }}
        emptyText={
          loading && items.length === 0
            ? 'Loading factoring queue…'
            : error ? 'Couldn’t load queue. Try refreshing.' : 'No items match the current filters.'
        }
        onClearFilters={() => { setSearch(''); setOtrFilter(null) }}
        footerExtra={
          <div className="flex items-center gap-2">
            <label className="text-xs tms-muted">
              Per page{' '}
              <TmsSelect
                aria-label="Invoices per page"
                value={perPage}
                onChange={(e) => setPerPage(Number(e.target.value))}
                className="w-auto"
              >
                {[10, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
              </TmsSelect>
            </label>
            <TmsButton
              size="sm"
              aria-label="Previous page"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </TmsButton>
            <span className="min-w-[76px] text-center text-xs tms-muted">Page {safePage} of {pageCount}</span>
            <TmsButton
              size="sm"
              aria-label="Next page"
              disabled={safePage >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            >
              Next
            </TmsButton>
          </div>
        }
      />

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

      {/* Opened by the PRO column. */}
      <LoadDrawer />
    </>
  )
}
