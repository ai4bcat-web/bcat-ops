/**
 * Step AM — "Cover": put a carrier on a load that needs one, the only way a load is covered.
 *
 * Type an MC (or DOT): we look in our carrier directory first. A carrier that is ACTIVE there (MyCarrierPackets
 * finished its packet and monitors it) is assigned straight away. Anything else is looked up on MyCarrierPackets
 * (PreviewCarrier), shown on the same review card as Find & Invite, and assigned only AFTER its setup packet
 * invitation has been sent to an approved or typed address. The ladder cannot move past "waiting for carrier
 * setup" until MyCarrierPackets confirms the packet; nothing on this dialog can mark setup complete. A packet
 * MCP rates UNACCEPTABLE blocks assignment, MODERATE allows it with a warning the rep acknowledges.
 *
 * There is deliberately no "add to carriers" here: a carrier only enters our directory through MyCarrierPackets.
 */
import { useAuth } from '@/hooks/useAuth'
import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { toast } from 'sonner'
import { MoneyField } from '@/features/directory/components/MoneyField'
import { InviteDialog } from '@/features/carriers/find/InviteDialog'
import { McpReviewCardView } from '@/features/carriers/find/McpReviewCardView'
import { CarrierLookupCard } from '@/features/carriers/lookup/CarrierLookupCard'
import { TmsAlert, TmsBadge, TmsButton, TmsDialog, TmsInput, TmsMetaList } from '@/features/tms/kit'
import { useCarriers } from '@/hooks/useCarriers'
import { CoverTrackingStep } from './CoverTrackingStep'
import { addCarrier, carriersByDot, carriersByMc, coverCarrier, getShipmentBundle, pullMcpCarrier, mcpPreviewCarrier, mcpSendInvite } from '@/lib/apiClient'
import type { McpLookupResult } from '@/lib/apiClient'
import { CARRIER_STATUS_LABELS } from '@/lib/carrierStatus'
import { formatDateTime } from '@/lib/date'
import { PACKET_LABELS, parseSearch, refLabel, searchDirectory } from '@/lib/integrations/mcpReview'
import type { McpCarrierStatus } from '@/lib/integrations/mcpAdapter'
import { normalizeMcpStatus } from '@/lib/mcpPacket'
import type { CarrierRecord, ShipmentBundle } from '@/types/tms'
import { liveCarriersOf } from '@/lib/carrierTotals'
import { MODERATE_ACK_KEY, UNACCEPTABLE_ACK_KEY, coverGate, coverRoute, findByNumber } from './coverModel'

type Ref = { mcNumber?: string; dotNumber?: string }

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong')

const packetLabel = (status: string | null | undefined): string => {
  const key = normalizeMcpStatus(status)
  return key ? (PACKET_LABELS[key as McpCarrierStatus] ?? key) : 'No packet on file'
}

const refOf = (c: CarrierRecord): Ref => ({
  ...(c.mcNumber ? { mcNumber: c.mcNumber.replace(/^MC/i, '') } : {}),
  ...(c.dotNumber ? { dotNumber: c.dotNumber } : {}),
})

export function CoverCarrierDialog({ shipmentId, shipmentNumber, initialQuery = '', initialRateCents, bundle, onClose, onCovered }: {
  shipmentId: string
  shipmentNumber?: string
  /** Look this MC / DOT up as soon as the directory has loaded (Carrier Sales' "Cover with this carrier"). */
  initialQuery?: string
  /** The carrier rate already typed somewhere (the shipment form's Rates card); the rep can still change it. */
  initialRateCents?: number
  /** The shipment on screen: when it already has a live carrier the dialog offers the legs choice and adds another carrier. */
  bundle?: ShipmentBundle
  onClose: () => void
  /** The covered shipment bundle, for the caller to swap in or refresh from. */
  onCovered: (bundle: ShipmentBundle) => void
}) {
  const { carriers, loading: carriersLoading, refresh } = useCarriers()
  const [query, setQuery] = useState(initialQuery)
  const [looked, setLooked] = useState(false)
  const [nameMatches, setNameMatches] = useState<CarrierRecord[] | null>(null)
  const [selected, setSelected] = useState<CarrierRecord | null>(null)
  const [ref, setRef] = useState<Ref | null>(null)
  const [preview, setPreview] = useState<McpLookupResult | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [rateCents, setRateCents] = useState<number | null>(initialRateCents && initialRateCents > 0 ? initialRateCents : null)
  const [acked, setAcked] = useState(false)
  // Warnings the server asks to be acknowledged (missing certificates, W-9, agreement...): shown with a checkbox, sent back by key.
  const [serverWarn, setServerWarn] = useState<{ keys: string[]; text: string } | null>(null)
  const [serverWarnOk, setServerWarnOk] = useState(false)
  // Set once the setup packet has gone out and only the cover is left (a warning to acknowledge): the footer then retries the cover alone.
  const [coverTarget, setCoverTarget] = useState<{ id: string; name: string } | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [working, setWorking] = useState(false)
  // A lookup asked for while the directory is still loading waits for it, instead of the click doing nothing.
  const [queued, setQueued] = useState(initialQuery.trim() !== '')
  // Set once COVER_CARRIER succeeded: the dialog moves on to the Tracking section instead of closing.
  const [covered, setCovered] = useState<{ bundle: ShipmentBundle; name: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Legs only matter when the caller already shows a live carrier on the load; empty = every stop.
  const [allStops, setAllStops] = useState(true)
  const [legStopIds, setLegStopIds] = useState<string[]>([])
  const addingMore = bundle != null && liveCarriersOf(bundle.loadCarriers, bundle.loads[0]?.id ?? '').length > 0
  const legStops = (bundle?.loads[0]?.stops ?? []).map((s, i) => ({
    id: s.id,
    label: `${i + 1}. ${s.type === 'pickup' ? 'Pickup' : 'Delivery'} ${s.name ?? s.city ?? ''}`.trim(),
  }))
  const card = preview?.card ?? null
  const stub = preview?.mode === 'STUB'
  const route = coverRoute(selected)
  const { isAdmin: callerIsAdmin, isOwner: callerIsOwner } = useAuth()
  const gate = coverGate(selected ? selected.mcpStatus : card?.packet.status, selected?.status, callerIsAdmin || callerIsOwner)
  const needsMcp = !selected || selected.status !== 'ACTIVE'
  const rateOk = rateCents != null && rateCents > 0
  const ackOk = !gate.warning || acked
  const assignable = rateOk && ackOk && !gate.blocked && !working && !carriersLoading && (allStops || legStopIds.length > 0)

  const pick = (carrier: CarrierRecord | null, next: Ref) => {
    setSelected(carrier)
    setRef(next)
    setPreview(null)
    setAcked(false)
    setServerWarn(null)
    setServerWarnOk(false)
    setCoverTarget(null)
    setError(null)
    setPreviewing(true)
    mcpPreviewCarrier(next)
      .then(setPreview)
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => setPreviewing(false))
  }

  const lookUp = () => {
    setQueued(false)
    const parsed = parseSearch(query)
    setLooked(true)
    setNameMatches(null)
    setSelected(null)
    setRef(null)
    setPreview(null)
    setError(null)
    if (parsed.kind === 'EMPTY') return
    if (parsed.kind === 'NAME') { setNameMatches(searchDirectory(carriers, parsed.name ?? query)); return }
    const next: Ref = { ...(parsed.mcNumber ? { mcNumber: parsed.mcNumber } : {}), ...(parsed.dotNumber ? { dotNumber: parsed.dotNumber } : {}) }
    pick(findByNumber(carriers, parsed), next)
    // The directory list is cached in the browser, so a carrier invited or activated a moment ago can look stale here (Pending, "Setup
    // packet not sent"). Re-read this one carrier straight from the server and use that row.
    void (async () => {
      try {
        const read = async () => (parsed.mcNumber ? await carriersByMc(parsed.mcNumber) : parsed.dotNumber ? await carriersByDot(parsed.dotNumber) : [])[0]
        let row = await read()
        if (row) setSelected((cur) => (cur == null || cur.id === row!.id ? row! : cur))
        // Invited but not Active yet: ask MyCarrierPackets right now (full profile + the status rule), so a carrier that just finished
        // its packet is Active, filled in and assignable the moment someone looks it up, not at the next scheduled sync.
        if (row && row.status !== 'ACTIVE' && row.mcpInvitedAt) {
          await pullMcpCarrier(row.id)
          const fresh = await read()
          if (fresh) { row = fresh; setSelected((cur) => (cur == null || cur.id === fresh.id ? fresh : cur)) }
        }
      } catch { /* the cached row stays */ }
    })()
  }

  useEffect(() => {
    if (!queued || carriersLoading) return
    void Promise.resolve().then(lookUp)
    // lookUp reads the settled directory; it only needs to run once when loading ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, carriersLoading])

  /** Re-read the load right before the write: its updatedAt is the CAS token, and an invitation may have taken a while. */
  const cover = async (carrierId: string) => {
    const fresh = await getShipmentBundle(shipmentId)
    const load = fresh.loads[0]
    if (!load) throw new Error('This shipment has no load to cover.')
    const input = {
      loadId: load.id,
      expectedUpdatedAt: load.updatedAt ?? fresh.shipment.updatedAt,
      carrierId,
      carrierRateCents: rateCents ?? 0,
      ...((gate.warning && acked) || (serverWarn && serverWarnOk)
        ? { acknowledgeWarnings: [...(gate.warning && acked ? [gate.ackKey ?? MODERATE_ACK_KEY] : []), ...(serverWarn && serverWarnOk ? serverWarn.keys : [])] }
        : {}),
    }
    // A load that already has a live carrier gets another one (default: every stop), never a replacement.
    const covered = liveCarriersOf(fresh.loadCarriers, load.id).length > 0
      ? await addCarrier({ ...input, ...(allStops ? {} : { legStopIds }) })
      : await coverCarrier(input)
    onCovered(covered)
    return covered
  }

  /** A server request to acknowledge warnings becomes a checkbox (and the keys it needs); anything else is the error. */
  const reportCoverError = (e: unknown) => {
    const text = messageOf(e)
    const ask = /Acknowledge these before booking:\s*([\s\S]*?)\s*\[ack:([^\]]+)\]/.exec(text)
    if (ask) {
      setServerWarn({ keys: ask[2].split(',').map((k) => k.trim()).filter(Boolean), text: ask[1] })
      setServerWarnOk(false)
      setError(null)
    } else setError(text)
  }

  const assignTarget = async () => {
    if (!coverTarget) return
    setWorking(true)
    setError(null)
    try {
      const bundle = await cover(coverTarget.id)
      toast.success(`${coverTarget.name} assigned`)
      setCovered({ bundle, name: coverTarget.name })
    } catch (e) {
      reportCoverError(e)
    } finally {
      setWorking(false)
    }
  }

  const assign = async () => {
    if (!selected) return
    setWorking(true)
    setError(null)
    try {
      const bundle = await cover(selected.id)
      toast.success(route === 'ASSIGN_NOW' ? `${selected.name} assigned` : `${selected.name} assigned, waiting for carrier setup`)
      setCovered({ bundle, name: selected.name })
    } catch (e) {
      reportCoverError(e)
    } finally {
      setWorking(false)
    }
  }

  const inviteAndAssign = async (emails: string[]) => {
    if (!ref || !card) return
    setWorking(true)
    setError(null)
    try {
      const load = (await getShipmentBundle(shipmentId)).loads[0]
      const invite = await mcpSendInvite({
        ...ref,
        emails,
        carrierId: selected?.id,
        carrierName: card.identity.legalName ?? selected?.name,
        shipmentId,
        loadId: load?.id,
        ensureCarrier: true,
      })
      setInviteOpen(false)
      if (!invite.sent) {
        // STUB (or a refusal): nothing went out and nothing was created, so nothing may be assigned.
        setError(`${invite.message} The carrier was not assigned: a carrier is only assigned once its setup packet has been sent.`)
        return
      }
      void refresh()
      const carrierId = invite.carrierId ?? selected?.id
      if (!carrierId) {
        setError('The setup packet was sent, but the carrier is not in our directory yet. Look it up again in a moment and assign it.')
        return
      }
      setCoverTarget({ id: carrierId, name: card.identity.legalName ?? selected?.name ?? 'The carrier' })
      const bundle = await cover(carrierId)
      toast.success('Setup packet sent. Carrier assigned, waiting for carrier setup')
      setCovered({ bundle, name: card.identity.legalName ?? selected?.name ?? 'The carrier' })
    } catch (e) {
      reportCoverError(e)
    } finally {
      setWorking(false)
    }
  }

  const [nowIso] = useState(() => new Date().toISOString())
  const needRate = 'Enter the carrier rate first: the carrier is assigned right after the setup packet is sent.'
  const requestInvite = (emails: string[]) => {
    if (!rateOk) { setError(needRate); return }
    void inviteAndAssign(emails)
  }
  const requestAssign = async () => {
    if (!rateOk) { setError('Enter the carrier rate first.'); return }
    await assign()
  }

  const title = shipmentNumber ? `Cover ${shipmentNumber}` : 'Cover shipment'
  const mainLabel = route === 'ASSIGN_NOW' ? 'Assign carrier'
    : route === 'ASSIGN_WAITING' ? 'Assign, waiting for carrier setup'
      : 'Send setup packet via MyCarrierPackets'
  const candidates = card?.emails ?? []
  const carrierName = card?.identity.legalName ?? selected?.name ?? (ref ? refLabel(ref) : 'the carrier')
  const hasTarget = selected != null || card != null

  const pending = selected != null && selected.status !== 'ACTIVE'

  if (covered) {
    return (
      <TmsDialog
        open
        onOpenChange={(open) => { if (!open) onClose() }}
        title={title}
        description="Carrier assigned. Last step: how this load is tracked."
        className="tms-dialog-wide"
        footer={<TmsButton variant="primary" data-testid="cover-done" onClick={onClose}>Done</TmsButton>}
      >
        <CoverTrackingStep initial={covered.bundle} carrierName={covered.name} onChanged={onCovered} />
      </TmsDialog>
    )
  }

  return (
    <>
      <TmsDialog
        open
        onOpenChange={(open) => { if (!open && !working) onClose() }}
        title={title}
        description="Look the carrier up by MC or DOT. Only carriers that went through MyCarrierPackets can be assigned."
        className="tms-dialog-wide"
        footer={
          <>
            <TmsButton variant="ghost" onClick={onClose} disabled={working}>Cancel</TmsButton>
            {coverTarget && (
              <TmsButton variant="primary" data-testid="cover-assign-target" disabled={working || (serverWarn != null && !serverWarnOk)} onClick={() => { void assignTarget() }}>
                {working ? 'Assigning…' : `Assign ${coverTarget.name}`}
              </TmsButton>
            )}
            {!coverTarget && hasTarget && (route === 'INVITE_FIRST' ? (
              <TmsButton
                variant="primary"
                data-testid="cover-send-packet"
                disabled={!assignable || !card || previewing}
                title={stub ? 'MyCarrierPackets is not LIVE here (STUB): a packet cannot be sent' : undefined}
                onClick={() => setInviteOpen(true)}
              >
                {mainLabel}
              </TmsButton>
            ) : (
              <TmsButton variant="primary" data-testid="cover-assign" disabled={!assignable} onClick={() => { void assign() }}>
                {working ? 'Assigning…' : mainLabel}
              </TmsButton>
            ))}
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <form
            className="flex flex-wrap items-center gap-2"
            role="search"
            onSubmit={(e) => { e.preventDefault(); if (carriersLoading) setQueued(true); else lookUp() }}
          >
            <TmsInput
              aria-label="Carrier MC or DOT"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="MC 274623 or DOT 1234567"
              style={{ minWidth: 280 }}
              autoFocus
            />
            <TmsButton type="submit" variant="primary" disabled={!query.trim() || previewing || queued} data-testid="cover-lookup">
              <Search size={14} /> {previewing || queued ? 'Looking up…' : 'Look up'}
            </TmsButton>
          </form>

          {serverWarn && (
            <TmsAlert tone="orange" title="Review before assigning" role="status">
              <label className="flex items-start gap-2" data-testid="cover-server-warning">
                <input type="checkbox" checked={serverWarnOk} onChange={(e) => setServerWarnOk(e.target.checked)} aria-label="Acknowledge the missing documents" />
                <span>{serverWarn.text} I have reviewed this and want to assign the carrier anyway. Tick it, then click Assign.</span>
              </label>
            </TmsAlert>
          )}
          {error && <TmsAlert tone="red" title="Could not cover" role="alert"><span data-testid="cover-error">{error}</span></TmsAlert>}

          {nameMatches && (
            <div data-testid="cover-name-results">
              <p className="tms-muted" style={{ fontSize: 12, margin: '0 0 4px' }}>Carriers in our directory matching that name:</p>
              <ul className="flex flex-col gap-1" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {nameMatches.map((c) => (
                  <li key={c.id} className="flex items-center gap-2">
                    <span>{c.name}</span>
                    <span className="tms-muted" style={{ fontSize: 12 }}>{[c.mcNumber && `MC ${c.mcNumber}`, c.dotNumber && `DOT ${c.dotNumber}`].filter(Boolean).join(' · ')}</span>
                    <TmsButton size="sm" variant="ghost" onClick={() => pick(c, refOf(c))}>Select</TmsButton>
                  </li>
                ))}
                {nameMatches.length === 0 && <li className="tms-muted">None. Look the carrier up by MC or DOT number.</li>}
              </ul>
            </div>
          )}

          {(selected || card) && !previewing && (
            <CarrierLookupCard
              card={card}
              mode={preview?.mode ?? 'LIVE'}
              carrier={selected}
              nowIso={nowIso}
              heading={carrierName}
              busy={working}
              onSendPacket={requestInvite}
              onCover={() => { void requestAssign() }}
              testId="cover-lookup-card"
            />
          )}

          {selected && (
            <div className="flex flex-col gap-2" data-testid="cover-directory">
              <TmsMetaList
                columns={3}
                items={[
                  { label: 'Carrier', value: selected.name },
                  { label: 'MC / DOT', value: [selected.mcNumber && `MC ${selected.mcNumber}`, selected.dotNumber && `DOT ${selected.dotNumber}`].filter(Boolean).join(' · ') || null },
                  { label: 'Directory status', value: <TmsBadge tone={selected.status === 'ACTIVE' ? 'green' : selected.status === 'DO_NOT_USE' ? 'red' : 'orange'}>{CARRIER_STATUS_LABELS[selected.status]}</TmsBadge> },
                  { label: 'Packet status', value: <span data-testid="cover-packet-status">{packetLabel(selected.mcpStatus)}</span> },
                  { label: 'Setup packet sent', value: selected.mcpInvitedAt ? `${formatDateTime(selected.mcpInvitedAt)}${selected.mcpInvitedTo ? ` to ${selected.mcpInvitedTo}` : ''}` : 'Not sent' },
                ]}
              />
              {route === 'ASSIGN_NOW' && (
                <TmsAlert tone="green" title="Setup complete" role="status">MyCarrierPackets reports this carrier’s packet complete and is monitoring it. The rate con can be sent right after assigning.</TmsAlert>
              )}
              {pending && route === 'ASSIGN_WAITING' && (
                <TmsAlert tone="orange" title="Waiting for carrier setup" role="status">The setup packet was sent. The carrier is assigned now and the load waits on MyCarrierPackets; the rate con can only go out once MyCarrierPackets confirms the packet.</TmsAlert>
              )}
              {pending && route === 'INVITE_FIRST' && (
                <TmsAlert tone="orange" title="Setup packet not sent yet" role="status">This carrier has not finished setup. Send it the setup packet below; it is assigned as soon as the packet has gone out.</TmsAlert>
              )}
            </div>
          )}

          {looked && !selected && !nameMatches && !previewing && preview && !card && (
            <TmsAlert tone="orange" title="No MyCarrierPackets record" role="status">
              MyCarrierPackets has no record of {ref ? refLabel(ref) : 'that number'}. Check it, or try the other number (MC vs DOT).
            </TmsAlert>
          )}

          {needsMcp && card && (
            <div data-testid="cover-mcp-card">
              <McpReviewCardView card={card} />
            </div>
          )}
          {preview?.mode === 'STUB' && preview.reason && (
            <p className="tms-muted" style={{ fontSize: 12, margin: 0 }} data-testid="cover-stub-reason">STUB because: {preview.reason}</p>
          )}

          {hasTarget && (
            <div className="flex flex-col gap-2" data-testid="cover-assign-panel">
              {gate.blocked && <TmsAlert tone="red" title="Cannot be assigned" role="alert"><span data-testid="cover-blocked">{gate.blocked}</span></TmsAlert>}
              {gate.warning && (
                <TmsAlert tone="orange" title={gate.ackKey === UNACCEPTABLE_ACK_KEY ? 'Unacceptable rating: admin override' : 'Moderate risk'} role="status">
                  <label className="flex items-start gap-2" data-testid="cover-warning">
                    <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} aria-label="Acknowledge moderate risk" />
                    <span>{gate.warning} I have reviewed it and want to assign this carrier.</span>
                  </label>
                </TmsAlert>
              )}
              <div className="max-w-56">
                <MoneyField label="Carrier rate" value={rateCents} onChange={setRateCents} />
              </div>
              {addingMore && legStops.length > 1 && (
                <div className="flex flex-col gap-1" data-testid="cover-legs">
                  <p className="tms-muted" style={{ fontSize: 12, margin: 0 }}>Legs this carrier covers</p>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" data-testid="cover-legs-all" aria-label="All stops" checked={allStops} onChange={(e) => setAllStops(e.target.checked)} />
                    <span>All stops</span>
                  </label>
                  {!allStops && legStops.map((s) => (
                    <label key={s.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        data-testid={`cover-leg-${s.id}`}
                        aria-label={`Stop ${s.label}`}
                        checked={legStopIds.includes(s.id)}
                        onChange={() => setLegStopIds((prev) => (prev.includes(s.id) ? prev.filter((id) => id !== s.id) : [...prev, s.id]))}
                      />
                      <span>{s.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </TmsDialog>

      {inviteOpen && card && (
        <InviteDialog
          carrierName={carrierName}
          candidates={candidates}
          stub={stub}
          busy={working}
          onClose={() => setInviteOpen(false)}
          onSend={(emails) => { setInviteOpen(false); void inviteAndAssign(emails) }}
        />
      )}
    </>
  )
}
