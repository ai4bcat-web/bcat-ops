/**
 * Step AG §7.1: the AP inbox review queue, as the list config `ApPage` hands to `TmsListPage`.
 * Columns, the row's "why" and the per-row actions live here; the page owns the dialogs.
 */
import type { ReactNode } from 'react'
import { TmsBadge, TmsButton } from '@/features/tms/kit'
import type { ApColumn, ApListConfig } from '../ApDenseList'
import { formatDay } from '@/features/ar/arViews'
import { formatCents } from '@/lib/invoiceBuild'
import type { ApInboxAttachmentRef, ApInboxItemRecord } from '@/lib/apInbox/types'
import { REASON_LABEL, STATUS_LABEL, itemRefs, suggestedLabel, undoBlockedReason } from './inboxModel'
import { ItemWhy } from './InboxParts'

const RIGHT = 'block text-right tabular-nums'

export type InboxViewConfig = ApListConfig<ApInboxItemRecord>

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
  const fromText = (r: ApInboxItemRecord) => [r.fromName, r.fromEmail].filter(Boolean).join(' ') || '—'
  const issuerText = (r: ApInboxItemRecord) => {
    const i = r.extraction.issuer
    return [i.name, i.mc ? `MC ${i.mc}` : '', i.dot ? `DOT ${i.dot}` : ''].filter(Boolean).join(' · ') || '—'
  }
  const matchText = (r: ApInboxItemRecord) => (
    r.status === 'NEEDS_REVIEW' || r.status === 'APPLIED' || r.status === 'LINKED' ? (suggestedLabel(r) ?? 'none') : STATUS_LABEL[r.status]
  )
  const columns: ApColumn<ApInboxItemRecord>[] = [
    { key: 'received', header: 'RECEIVED', text: (r) => formatDay(r.receivedAt.slice(0, 10)), sortValue: (r) => r.receivedAt, filter: 'date', dateOf: (r) => r.receivedAt, render: (r) => <span className="text-xs">{formatDay(r.receivedAt.slice(0, 10))}</span> },
    {
      key: 'from',
      header: 'FROM',
      text: fromText,
      extraPx: 30,
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
      text: issuerText,
      extraPx: 30,
      render: (r) => {
        const i = r.extraction.issuer
        const ids = [i.mc ? `MC ${i.mc}` : '', i.dot ? `DOT ${i.dot}` : ''].filter(Boolean).join(' · ')
        return <span className="text-xs">{i.name || '—'}{ids ? <><br /><span className="tms-muted">{ids}</span></> : null}</span>
      },
    },
    { key: 'invoice', header: 'INVOICE #', text: (r) => r.extraction.invoiceNumber ?? '—', render: (r) => r.extraction.invoiceNumber ?? '—' },
    { key: 'refs', header: 'PRO / REFS', text: (r) => itemRefs(r) || '—', render: (r) => <span className="text-xs">{itemRefs(r) || '—'}</span> },
    { key: 'invDate', header: 'INVOICE DATE', text: (r) => formatDay(r.extraction.invoiceDate), sortValue: (r) => r.extraction.invoiceDate ?? '', filter: 'date', dateOf: (r) => r.extraction.invoiceDate ?? null, render: (r) => formatDay(r.extraction.invoiceDate) },
    { key: 'due', header: 'DUE', text: (r) => formatDay(r.extraction.dueDate), sortValue: (r) => r.extraction.dueDate ?? '', filter: 'date', dateOf: (r) => r.extraction.dueDate ?? null, render: (r) => formatDay(r.extraction.dueDate) },
    {
      key: 'amount',
      header: 'AMOUNT',
      align: 'right',
      text: (r) => (r.extraction.amountCents == null ? '—' : formatCents(r.extraction.amountCents)),
      sortValue: (r) => r.extraction.amountCents ?? null,
      filter: 'number',
      numberOf: (r) => (r.extraction.amountCents == null ? null : r.extraction.amountCents / 100),
      numberUnit: '$',
      render: (r) => <span className={RIGHT}>{r.extraction.amountCents == null ? '—' : formatCents(r.extraction.amountCents)}</span>,
    },
    {
      key: 'match',
      header: 'SUGGESTED MATCH',
      text: matchText,
      extraPx: 90,
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
      text: (r) => (r.attachments ?? []).map((f) => f.name).join(', ') || (r.sourceUrl ? 'Open in Gmail' : '—'),
      filter: false,
      sortable: false,
      render: (r) => (
        <span className="text-xs">
          {(r.attachments ?? []).map((f) => (
            <button key={f.key} type="button" className="mr-2 underline" onClick={() => onOpenFile(f)}>{f.name}</button>
          ))}
          {r.sourceUrl && <a href={r.sourceUrl} target="_blank" rel="noreferrer" className="underline">Open in Gmail</a>}
        </span>
      ),
    },
    { key: 'why', header: 'WHY', text: (r) => (r.reviewReason ? (REASON_LABEL[r.reviewReason] ?? r.reviewReason) : ''), width: 360, filter: false, sortable: false, render: (r) => <ItemWhy item={r} testId={`ap-inbox-why-${r.id}`} /> },
    {
      key: 'actions',
      header: '',
      text: () => '',
      width: 330,
      filter: false,
      sortable: false,
      fixed: true,
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
    gridId: 'ap-inbox',
    banner,
    columns,
    rows,
    rowKey: (r) => r.id,
    emptyText: loading ? 'Loading…' : 'Nothing here. Invoice e-mails the AP inbox finds will appear in this list.',
  }
}
