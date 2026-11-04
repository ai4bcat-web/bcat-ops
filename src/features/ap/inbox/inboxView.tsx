/**
 * Step AG §7.1: the AP inbox review queue, as the list config `ApPage` hands to `TmsListPage`.
 * Columns, the row's "why" and the per-row actions live here; the page owns the dialogs.
 */
import type { ReactNode } from 'react'
import { TmsBadge, TmsButton, type ColumnDef, type TmsListPageProps } from '@/features/tms/kit'
import { formatDay } from '@/features/ar/arViews'
import { formatCents } from '@/lib/invoiceBuild'
import type { ApInboxAttachmentRef, ApInboxItemRecord } from '@/lib/apInbox/types'
import { REASON_LABEL, STATUS_LABEL, itemRefs, suggestedLabel, undoBlockedReason } from './inboxModel'
import { ItemWhy } from './InboxParts'

const RIGHT = 'block text-right tabular-nums'

export type InboxViewConfig = Omit<TmsListPageProps<ApInboxItemRecord>, 'title' | 'viewTabs' | 'quickTabs' | 'onRefresh'>

export function inboxView({
  banner, rows, loading, busy, onLink, onCreate, onDismiss, onUndo, onOpenFile,
}: {
  banner: ReactNode
  rows: ApInboxItemRecord[]
  loading: boolean
  busy: boolean
  onLink: (item: ApInboxItemRecord) => void
  onCreate: (item: ApInboxItemRecord) => void
  onDismiss: (item: ApInboxItemRecord) => void
  onUndo: (item: ApInboxItemRecord) => void
  onOpenFile: (file: ApInboxAttachmentRef) => void
}): InboxViewConfig {
  const columns: ColumnDef<ApInboxItemRecord>[] = [
    { key: 'received', header: 'RECEIVED', render: (r) => <span className="text-xs">{formatDay(r.receivedAt.slice(0, 10))}</span> },
    {
      key: 'from',
      header: 'FROM',
      render: (r) => (
        <span className="text-xs">
          {r.fromName || r.fromEmail || '—'}
          {r.fromName && r.fromEmail ? <><br /><span className="tms-muted">{r.fromEmail}</span></> : null}
        </span>
      ),
    },
    {
      key: 'issuer',
      header: 'ISSUER',
      render: (r) => {
        const i = r.extraction.issuer
        const ids = [i.mc ? `MC ${i.mc}` : '', i.dot ? `DOT ${i.dot}` : ''].filter(Boolean).join(' · ')
        return <span className="text-xs">{i.name || '—'}{ids ? <><br /><span className="tms-muted">{ids}</span></> : null}</span>
      },
    },
    { key: 'invoice', header: 'INVOICE #', render: (r) => r.extraction.invoiceNumber ?? '—' },
    { key: 'refs', header: 'PRO / REFS', render: (r) => <span className="text-xs">{itemRefs(r) || '—'}</span> },
    { key: 'invDate', header: 'INVOICE DATE', render: (r) => formatDay(r.extraction.invoiceDate) },
    { key: 'due', header: 'DUE', render: (r) => formatDay(r.extraction.dueDate) },
    {
      key: 'amount',
      header: 'AMOUNT',
      render: (r) => <span className={RIGHT}>{r.extraction.amountCents == null ? '—' : formatCents(r.extraction.amountCents)}</span>,
    },
    {
      key: 'match',
      header: 'SUGGESTED MATCH',
      render: (r) => {
        const label = suggestedLabel(r)
        const vetoed = (r.match?.top?.vetoes.length ?? 0) > 0
        return (
          <span className="text-xs">
            {r.status === 'NEEDS_REVIEW' || r.status === 'APPLIED' || r.status === 'LINKED' ? (label ?? <span className="tms-muted">none</span>) : STATUS_LABEL[r.status]}
            {r.match?.top && <> <TmsBadge tone={vetoed ? 'red' : 'gray'}>{r.match.top.score.toFixed(2)}</TmsBadge></>}
            {r.reviewReason && r.status === 'NEEDS_REVIEW' && <> <TmsBadge tone={vetoed ? 'red' : 'orange'}>{REASON_LABEL[r.reviewReason] ?? r.reviewReason}</TmsBadge></>}
          </span>
        )
      },
    },
    {
      key: 'files',
      header: 'FILES',
      render: (r) => (
        <span className="text-xs">
          {(r.attachments ?? []).map((f) => (
            <button key={f.key} type="button" className="mr-2 underline" onClick={() => onOpenFile(f)}>{f.name}</button>
          ))}
          {r.sourceUrl && <a href={r.sourceUrl} target="_blank" rel="noreferrer" className="underline">Open in Gmail</a>}
        </span>
      ),
    },
    { key: 'why', header: 'WHY', render: (r) => <ItemWhy item={r} testId={`ap-inbox-why-${r.id}`} /> },
    {
      key: 'actions',
      header: '',
      render: (r) => {
        if (r.status === 'NEEDS_REVIEW') {
          return (
            <span className="flex gap-1">
              <TmsButton size="sm" data-testid={`ap-inbox-link-${r.id}`} disabled={busy} onClick={() => onLink(r)}>Link to bill…</TmsButton>
              <TmsButton size="sm" data-testid={`ap-inbox-create-${r.id}`} disabled={busy || r.kind === 'CREDIT_MEMO'} onClick={() => onCreate(r)}>Create bill…</TmsButton>
              <TmsButton size="sm" data-testid={`ap-inbox-dismiss-${r.id}`} disabled={busy} onClick={() => onDismiss(r)}>Dismiss…</TmsButton>
            </span>
          )
        }
        if (r.status !== 'APPLIED' && r.status !== 'LINKED') return null
        const blocked = undoBlockedReason(r)
        return (
          <TmsButton size="sm" data-testid={`ap-inbox-undo-${r.id}`} disabled={busy || blocked !== null} title={blocked ?? 'Restore the values the bill had before this e-mail'} onClick={() => onUndo(r)}>
            Undo
          </TmsButton>
        )
      },
    },
  ]

  return {
    banner,
    columns,
    rows,
    rowKey: (r) => r.id,
    page: { from: rows.length === 0 ? 0 : 1, to: rows.length, total: rows.length, pageSize: rows.length },
    emptyText: loading ? 'Loading…' : 'Nothing here. Invoice e-mails the AP inbox finds will appear in this list.',
  }
}
