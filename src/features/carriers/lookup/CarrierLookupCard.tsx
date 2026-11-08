/**
 * Step AS — the one MC / DOT lookup result, used on Carrier Sales, the Cover dialog, the ladder card and
 * Find & Invite. It answers three questions on its first lines (in our directory? packet standing?
 * MCP vetting?) and offers the same actions everywhere. All decisions live in `lookupModel`.
 * The surface owns what a send / cover / add actually does; this card owns the recipient checklist.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { TmsBadge, TmsButton } from '@/features/tms/kit'
import type { McpReviewCard } from '@/lib/integrations/mcpReview'
import { InviteDialog } from '@/features/carriers/find/InviteDialog'
import { lookupState } from './lookupModel'
import type { LookupDirectoryRow } from './lookupModel'
import { formatBoardDate } from '@/lib/date'

export interface CarrierLookupCardProps {
  card: McpReviewCard | null
  mode: 'LIVE' | 'STUB'
  carrier: LookupDirectoryRow | null
  /** ISO instant for the 3-day re-send rule. */
  nowIso: string
  /** Fallback heading when MCP gave no name. */
  heading?: string
  busy?: boolean
  /** Send the setup packet to exactly these addresses (the ticked MCP list plus any typed). */
  onSendPacket: (emails: string[]) => void | Promise<void>
  onCover?: (carrier: LookupDirectoryRow) => void
  onAddToDirectory?: () => void | Promise<void>
  testId?: string
}

const BADGE_FOR_PACKET = { COMPLETE: 'green', INVITED: 'blue', NONE: 'orange', STUB: 'gray' } as const

export function CarrierLookupCard({ card, mode, carrier, nowIso, heading, busy = false, onSendPacket, onCover, onAddToDirectory, testId = 'carrier-lookup' }: CarrierLookupCardProps) {
  const [popover, setPopover] = useState(false)
  const s = lookupState({ card, mode, carrier, nowIso })
  const name = card?.identity.legalName ?? carrier?.name ?? heading ?? 'Carrier'
  const statusText = s.directory.status ? s.directory.status.replace(/_/g, ' ') : ''
  const id = card?.identity

  return (
    <div data-testid={testId} data-packet={s.packet.kind} data-in-directory={s.directory.inDirectory ? 'true' : 'false'}
      style={{ display: 'grid', gap: 8, border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)', padding: 10 }}>
      {s.activeReady ? (
        <div data-testid={`${testId}-active`}><TmsBadge tone="green">Active with us — ready to cover</TmsBadge></div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2" data-testid={`${testId}-standing`}>
        {s.directory.inDirectory ? (
          <TmsBadge tone={s.directory.status === 'ACTIVE' ? 'green' : s.directory.status === 'DO_NOT_USE' ? 'red' : 'orange'}>Set up with us · {statusText}</TmsBadge>
        ) : (
          <TmsBadge tone="gray">Not in directory</TmsBadge>
        )}
        <TmsBadge tone={BADGE_FOR_PACKET[s.packet.kind]} title={s.packet.kind === 'STUB' ? 'No MyCarrierPackets call was made' : undefined}>{s.packet.label}</TmsBadge>
        {s.vetting.failing.length > 0
          ? s.vetting.failing.map((f) => <TmsBadge key={f} tone="red">{f}</TmsBadge>)
          : card && mode === 'LIVE' ? <TmsBadge tone="green">MCP vetting clear</TmsBadge> : null}
      </div>

      <div style={{ display: 'grid', gap: 2, fontSize: 13 }}>
        <strong data-testid={`${testId}-name`}>{name}</strong>
        {carrier ? (
          <span className="tms-muted" data-testid={`${testId}-directory-line`}>
            {carrier.lastLoadAt ? `Last load ${formatBoardDate(carrier.lastLoadAt)}` : 'No load yet'}
            {carrier.loadCount != null ? ` · ${carrier.loadCount} ${carrier.loadCount === 1 ? 'load' : 'loads'}` : ''}
          </span>
        ) : null}
        {carrier && (carrier.dispatcherName || carrier.dispatcherEmail || carrier.email) ? (
          <span className="tms-muted" data-testid={`${testId}-contacts`}>
            We hold: {[carrier.dispatcherName, carrier.dispatcherEmail, carrier.email].filter(Boolean).join(' · ')}
          </span>
        ) : null}
        {card ? (
          <span className="tms-muted" data-testid={`${testId}-mcp-line`}>
            {[
              id?.dbaName && `DBA ${id.dbaName}`,
              id?.address,
              id?.phone,
              card.operating.authorityStatus && `Authority ${card.operating.authorityStatus.toLowerCase()}`,
              ...card.insurance.slice(0, 3).map((r) => `${r.type} ${r.limitText ?? ''} ${r.state.toLowerCase()}${r.expiresAt ? ` ${r.expiresAt.slice(0, 10)}` : ''}`.replace(/\s+/g, ' ')),
              card.operating.safetyRating && `Safety ${card.operating.safetyRating}`,
              card.risk.totalPoints != null && `Risk ${card.risk.totalPoints} pts`,
            ].filter(Boolean).join(' · ')}
          </span>
        ) : null}
        {mode === 'LIVE' && card ? (
          <span data-testid={`${testId}-emails`} className="tms-muted">
            MyCarrierPackets e-mails: {s.emails.length ? s.emails.map((e) => e.address).join(', ') : 'none returned'}
          </span>
        ) : null}
        {mode === 'STUB' ? <span className="tms-muted" data-testid={`${testId}-stub`}>Stub, no MCP call. No e-mail addresses are listed.</span> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2" data-testid={`${testId}-actions`}>
        <TmsButton size="sm" variant={s.send.primary ? 'primary' : undefined} data-testid={`${testId}-send`}
          disabled={busy || !s.send.enabled} title={s.send.enabled ? undefined : s.send.reason} onClick={() => setPopover(true)}>
          {s.send.label}
        </TmsButton>
        {onCover ? (
          <TmsButton size="sm" variant={s.cover.primary ? 'primary' : undefined} data-testid={`${testId}-cover`}
            disabled={busy || !s.cover.enabled || !carrier} title={s.cover.enabled ? undefined : s.cover.reason}
            onClick={() => { if (carrier) onCover(carrier) }}>
            Cover with this carrier
          </TmsButton>
        ) : null}
        {s.directoryAction.kind === 'open' && carrier ? (
          <Link className="tms-btn tms-btn-secondary tms-btn-sm" to={`/tms/carriers/${carrier.id}`} data-testid={`${testId}-open`}>Open carrier</Link>
        ) : null}
        {s.directoryAction.kind === 'add' && onAddToDirectory ? (
          <TmsButton size="sm" data-testid={`${testId}-add`} disabled={busy || !s.directoryAction.enabled}
            title={s.directoryAction.enabled ? 'Creates a Pending carrier from MyCarrierPackets without inviting it' : s.directoryAction.reason}
            onClick={() => { void onAddToDirectory() }}>
            Add to directory
          </TmsButton>
        ) : null}
      </div>

      {popover ? (
        <InviteDialog
          carrierName={name}
          candidates={s.emails}
          stub={mode === 'STUB'}
          busy={busy}
          onClose={() => setPopover(false)}
          onSend={(emails) => { setPopover(false); void onSendPacket(emails) }}
        />
      ) : null}
    </div>
  )
}
