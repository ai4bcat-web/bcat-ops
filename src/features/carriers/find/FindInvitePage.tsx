/**
 * `/tms/carriers/find` — Carriers › Find & Invite (Step AD).
 *
 * Look a carrier up on MyCarrierPackets by MC / DOT (names search our own directory: MCP has no
 * name search), review it on a card laid out like MCP's review screen, then send it the setup packet.
 * Step AM: that is the only way a carrier enters our directory (the invitation creates its Pending row);
 * there is no "add to carriers". Every MyCarrierPackets call runs in the Lambda; this page
 * never holds a credential. When MCP is not LIVE the card is a labelled STUB fixture and the
 * invite action does nothing real.
 *
 * Launch points pass `?shipmentId=&loadId=` so an invitation sent from a load is also noted on
 * that load's thread, and `?mc=` / `?dot=` to open straight on a carrier.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Search } from 'lucide-react'
import { toast } from 'sonner'
import { TmsAlert, TmsButton, TmsInput, TmsPage } from '@/features/tms/kit'
import { useCarriers } from '@/hooks/useCarriers'
import { mcpGetCarrier, mcpPreviewCarrier, mcpSendInvite } from '@/lib/apiClient'
import type { McpInviteResult, McpLookupResult } from '@/lib/apiClient'
import {
  PACKET_LABELS, matchDirectoryCarrier, mergeReviewCards, parseSearch, refLabel, searchDirectory,
  type McpReviewCard,
} from '@/lib/integrations/mcpReview'
import type { McpCarrierStatus } from '@/lib/integrations/mcpAdapter'
import { InviteDialog } from './InviteDialog'
import { McpReviewCardView } from './McpReviewCardView'

type Ref = { mcNumber?: string; dotNumber?: string }

interface Shown {
  ref: Ref
  card: McpReviewCard | null
  mode: 'LIVE' | 'STUB'
  reason: string | null
  notFound: boolean
  /** GetCarrierData is still on its way: the card is the preview so far. */
  completing: boolean
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong')

export function FindInvitePage() {
  const [params] = useSearchParams()
  const shipmentId = params.get('shipmentId') ?? undefined
  const loadId = params.get('loadId') ?? undefined
  const { carriers, refresh } = useCarriers()
  const [query, setQuery] = useState(params.get('q') ?? params.get('mc') ?? (params.get('dot') ? `DOT ${params.get('dot')}` : ''))
  const [shown, setShown] = useState<Shown | null>(null)
  const [nameQuery, setNameQuery] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [lastInvite, setLastInvite] = useState<McpInviteResult | null>(null)
  const request = useRef(0)

  const run = useCallback(async (raw: string) => {
    const parsed = parseSearch(raw)
    const mine = ++request.current
    setError(null)
    setLastInvite(null)
    if (parsed.kind === 'EMPTY') { setShown(null); setNameQuery(null); return }
    if (parsed.kind === 'NAME') { setShown(null); setNameQuery(parsed.name ?? raw); return }
    setNameQuery(null)
    const ref: Ref = { ...(parsed.mcNumber ? { mcNumber: parsed.mcNumber } : {}), ...(parsed.dotNumber ? { dotNumber: parsed.dotNumber } : {}) }
    setSearching(true)
    setShown(null)
    try {
      const dataCall = mcpGetCarrier(ref)
      // The preview answers first and fills the card; the full record folds in when it lands.
      const preview = await mcpPreviewCarrier(ref)
      if (mine !== request.current) return
      setShown({ ref, card: preview.card, mode: preview.mode, reason: preview.reason, notFound: preview.notFound, completing: preview.mode === 'LIVE' && !!preview.card })
      setSearching(false)
      let data: McpLookupResult | null = null
      try { data = await dataCall } catch { data = null }
      if (mine !== request.current) return
      setShown({
        ref,
        card: mergeReviewCards(preview.card, data?.card ?? null),
        mode: preview.mode,
        reason: preview.reason,
        notFound: preview.notFound && (data?.notFound ?? true),
        completing: false,
      })
    } catch (e) {
      if (mine !== request.current) return
      setError(messageOf(e))
      setSearching(false)
    }
  }, [])

  // Open straight on a carrier when a launch point supplies one.
  const auto = useRef(false)
  useEffect(() => {
    if (auto.current) return
    auto.current = true
    const initial = params.get('q') ?? params.get('mc') ?? (params.get('dot') ? `DOT ${params.get('dot')}` : '')
    // Through a promise so no state is set synchronously inside the effect.
    if (initial) void Promise.resolve().then(() => run(initial))
  }, [params, run])

  const card = shown?.card ?? null
  const inDirectory = useMemo(() => (card ? matchDirectoryCarrier(carriers, card) : null), [carriers, card])
  const nameMatches = useMemo(() => (nameQuery ? searchDirectory(carriers, nameQuery) : []), [carriers, nameQuery])
  const stub = shown?.mode === 'STUB'

  const send = async (email: string) => {
    if (!card) return
    setSending(true)
    try {
      const result = await mcpSendInvite({
        ...shown!.ref,
        email,
        carrierId: inDirectory?.carrier.id,
        carrierName: card.identity.legalName,
        shipmentId,
        loadId,
        ensureCarrier: true,
      })
      setLastInvite(result)
      setInviteOpen(false)
      if (result.sent) toast.success(result.message)
      else toast.info(result.message)
      if (result.carrierLogged) void refresh()
    } catch (e) {
      toast.error(messageOf(e))
    } finally {
      setSending(false)
    }
  }

  const packetLabel = (status: string | null | undefined): string =>
    status ? (PACKET_LABELS[status as McpCarrierStatus] ?? status) : 'No packet on file'

  const actions = card && (
    <>
      {inDirectory && (
        <Link className="tms-btn tms-btn-secondary tms-btn-sm" to={`/tms/carriers/${inDirectory.carrier.id}`} data-testid="mcp-open-profile">Open carrier profile</Link>
      )}
      {/* Step AM: no "Add to carriers". A carrier enters the directory only through its MyCarrierPackets setup packet. */}
      <TmsButton size="sm" variant="primary" onClick={() => setInviteOpen(true)} data-testid="mcp-send-invite">Send setup packet via MyCarrierPackets</TmsButton>
    </>
  )

  const banner = card && (
    <>
      {inDirectory && (
        <TmsAlert tone="blue" title="Already in directory" role="status">
          <span data-testid="mcp-in-directory">
            {inDirectory.carrier.name} is in our carriers (matched on {inDirectory.by === 'MC' ? 'MC' : inDirectory.by === 'DOT' ? 'DOT' : 'name'}).
            {' '}Packet status on the row: <strong>{packetLabel(inDirectory.carrier.mcpStatus)}</strong>
            {inDirectory.carrier.mcpInvitedAt ? `; last invited ${inDirectory.carrier.mcpInvitedAt.slice(0, 10)}${inDirectory.carrier.mcpInvitedTo ? ` at ${inDirectory.carrier.mcpInvitedTo}` : ''}` : ''}.
            {' '}<Link to={`/tms/carriers/${inDirectory.carrier.id}`}>Open profile</Link>
          </span>
        </TmsAlert>
      )}
      {shown?.completing && <p className="tms-muted" style={{ fontSize: 12, margin: 0 }}>Loading the full MyCarrierPackets record…</p>}
      {lastInvite && (
        <TmsAlert tone={lastInvite.sent ? 'green' : 'orange'} title={lastInvite.sent ? 'Invitation sent' : 'Nothing was sent (STUB)'} role="status">
          <span data-testid="mcp-invite-result">
            {lastInvite.message}
            {lastInvite.sent && shipmentId ? (lastInvite.threadLogged ? ' Noted on the shipment thread.' : ' The shipment thread could not be updated.') : ''}
            {lastInvite.sent && inDirectory ? (lastInvite.carrierLogged ? ' Logged on the carrier.' : ' The carrier row could not be updated.') : ''}
          </span>
        </TmsAlert>
      )}
    </>
  )

  return (
    <TmsPage
      title="Find & invite a carrier"
      actions={shipmentId ? <Link className="tms-btn tms-btn-ghost tms-btn-sm" to={`/tms/shipments/${shipmentId}?tab=carrier`}>Back to the shipment</Link> : undefined}
    >
      <form
        className="mb-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); void run(query) }}
        role="search"
      >
        <TmsInput
          aria-label="Find a carrier"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="MC 274623, DOT 1234567 or a carrier name"
          style={{ minWidth: 320 }}
        />
        <TmsButton type="submit" variant="primary" disabled={searching || !query.trim()} data-testid="mcp-search"><Search size={14} /> {searching ? 'Looking up…' : 'Look up'}</TmsButton>
        <span className="tms-muted" style={{ fontSize: 12 }}>MyCarrierPackets looks carriers up by number; a name searches our directory.</span>
      </form>

      {error && <TmsAlert tone="red" title="Lookup failed">{error}</TmsAlert>}

      {stub && shown?.reason && (
        <p className="tms-muted" style={{ fontSize: 12 }} data-testid="mcp-stub-reason">STUB because: {shown.reason}</p>
      )}

      {nameQuery && (
        <div data-testid="mcp-name-results">
          <p className="tms-muted">Carriers in our directory matching “{nameQuery}”:</p>
          <ul className="flex flex-col gap-1" style={{ listStyle: 'none', padding: 0 }}>
            {nameMatches.map((c) => (
              <li key={c.id}>
                <Link to={`/tms/carriers/${c.id}`}>{c.name}</Link>
                <span className="tms-muted"> {[c.mcNumber && `MC ${c.mcNumber}`, c.dotNumber && `DOT ${c.dotNumber}`].filter(Boolean).join(' · ')}</span>
                {(c.mcNumber || c.dotNumber) && (
                  <TmsButton size="sm" variant="ghost" onClick={() => { const q = c.mcNumber ? `MC ${c.mcNumber.replace(/^MC/i, '')}` : `DOT ${c.dotNumber}`; setQuery(q); void run(q) }}>Review on MCP</TmsButton>
                )}
              </li>
            ))}
            {nameMatches.length === 0 && <li className="tms-muted">None. Not in the directory by that name: look it up by MC or DOT number.</li>}
          </ul>
        </div>
      )}

      {shown && !card && !searching && (
        <TmsAlert tone="orange" title="No MyCarrierPackets record">
          MyCarrierPackets has no record of {refLabel(shown.ref)}. Check the number, or look it up by the other one (MC vs DOT).
        </TmsAlert>
      )}

      {card && <McpReviewCardView card={card} actions={actions} banner={banner} />}

      {inviteOpen && card && (
        <InviteDialog
          carrierName={card.identity.legalName ?? refLabel(card.identity)}
          approved={card.approvedEmails}
          stub={stub}
          busy={sending}
          onClose={() => setInviteOpen(false)}
          onSend={(email) => { void send(email) }}
        />
      )}
    </TmsPage>
  )
}
