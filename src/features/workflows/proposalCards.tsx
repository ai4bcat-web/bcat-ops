/**
 * What a run proposed, one card per kind.
 *
 * Every card ends in a door a person walks through with their own identity:
 * CREATE_SHIPMENT, SAVE_QUOTE, REVIEW_DOCUMENT + RECORD_BILL. The agent has no write
 * grant on any of those tables and no way to invoke anything — the proposal is a draft
 * of what a person would have typed, and these buttons hand it to them. Nothing here
 * applies a proposal by itself, and nothing here deletes a row.
 */
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsButton, TmsCard, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { linkWorkflowRun, listShipments, setWorkflowRunParty } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { proposalToPrefill } from '@/lib/workflows/tenderProposal'
import { NewShipmentDialog } from '@/features/shipments/components/NewShipmentDialog'
import type {
  CapacityProposal,
  CarrierBillProposal,
  QuoteProposal,
  TenderProposal,
  VendorBillProposal,
  WorkflowRunRecord,
} from '@/types/tms'

export interface ProposalCardProps {
  run: WorkflowRunRecord
  /** Re-read the run after a write so the outcome badge and the links follow. */
  onChanged: () => void | Promise<void>
}

/** A label/value row. The cards are read far more often than they are acted on. */
function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="tms-field-label">{label}</dt>
      <dd>{value && value.trim() ? value : '—'}</dd>
    </div>
  )
}

function placeOf(part: { city?: string | null; state?: string | null; zip?: string | null } | null | undefined): string {
  if (!part) return ''
  return [part.city, part.state].filter(Boolean).join(', ') + (part.zip ? ` ${part.zip}` : '')
}

// ── TENDER ───────────────────────────────────────────────────────────────────

/**
 * The tender as the agent read it, and the New shipment form seeded from it.
 *
 * The agent never creates the shipment: a person opens the same dialog the board opens,
 * with their own Cognito identity, and CREATE_SHIPMENT runs its usual checks — the PRO
 * is claimed server-side in that same transaction. The seed carries `source: 'TENDER'`,
 * so the shipment is raised in TENDER_PENDING and TENDER_RESPOND's Accept/Reject stays
 * the review. Only once the create has returned an id is the run pointed at it with
 * `linkWorkflowRun`.
 */
function TenderCard({ run, proposal, onChanged }: ProposalCardProps & { proposal: TenderProposal }) {
  const [open, setOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [number, setNumber] = useState('')
  const [busy, setBusy] = useState(false)
  const tender = proposal.tender
  const applied = run.outcome === 'APPLIED'

  const link = async (shipmentId: string) => {
    try {
      await linkWorkflowRun(run.id, { shipmentId }, run.version ?? 0)
      toast.success('Run linked to the shipment')
      await onChanged()
    } catch (err) {
      // The shipment exists either way — only the link failed, so the offer is to point
      // the run at a shipment by number rather than to create a second one.
      toast.error(err instanceof Error ? err.message : 'Could not link the run to that shipment')
      setLinkOpen(true)
    }
  }

  return (
    <TmsCard
      title="Proposed tender"
      actions={applied ? null : (
        <>
          <TmsButton variant="primary" size="sm" onClick={() => setOpen(true)}>Create shipment</TmsButton>
          <TmsButton size="sm" onClick={() => setLinkOpen(true)}>Link existing shipment</TmsButton>
        </>
      )}
    >
      <dl className="tms-grid tms-grid-4">
        <Fact label="Customer" value={run.partyName ?? proposal.customerName ?? tender.customer} />
        <Fact label="Reference" value={tender.reference} />
        <Fact label="Pickup number" value={tender.pickupNumber} />
        <Fact label="Weight" value={tender.weightLb ? `${tender.weightLb.toLocaleString()} lb` : null} />
      </dl>
      <ol className="mt-3 text-sm">
        {tender.stops.map((stop, i) => (
          <li key={`${stop.type}-${i}`}>
            <strong>{stop.type === 'pickup' ? 'Pickup' : 'Delivery'}</strong>{' '}
            {[stop.name, [stop.city, stop.state].filter(Boolean).join(', '), stop.dateStr].filter(Boolean).join(' — ')}
          </li>
        ))}
        {tender.stops.length === 0 ? <li className="tms-muted">No stops were readable in the tender.</li> : null}
      </ol>
      <p className="tms-muted mt-3 text-sm">
        Creating raises the shipment in Tender Pending under your own login — Accept or Reject it
        from the shipment. The run is linked to it once it exists.
      </p>

      <NewShipmentDialog
        open={open}
        prefill={proposalToPrefill(run)}
        onClose={() => setOpen(false)}
        onCreated={(shipmentId) => { setOpen(false); void link(shipmentId) }}
      />

      <TmsDialog
        open={linkOpen}
        onOpenChange={(next) => { if (!next) setLinkOpen(false) }}
        title="Link an existing shipment"
        description="The run is pointed at a shipment somebody already created. Nothing on the shipment changes."
        footer={
          <>
            <TmsButton onClick={() => setLinkOpen(false)}>Cancel</TmsButton>
            <TmsButton
              variant="primary"
              disabled={busy || !number.trim()}
              onClick={async () => {
                setBusy(true)
                try {
                  // Shipment numbers have no index of their own, so this is the board's
                  // own list read once, on an explicit operator action, not on render.
                  const wanted = number.trim().toLowerCase()
                  const match = (await listShipments()).find((s) => (s.number ?? '').toLowerCase() === wanted)
                  if (!match) { toast.error(`No shipment is numbered ${number.trim()}`); return }
                  setLinkOpen(false)
                  await link(match.id)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? 'Linking…' : 'Link'}
            </TmsButton>
          </>
        }
      >
        <TmsField label="Shipment number">
          <TmsInput aria-label="Shipment number" value={number} onChange={(e) => setNumber(e.target.value)} />
        </TmsField>
      </TmsDialog>
    </TmsCard>
  )
}

// ── QUOTE ────────────────────────────────────────────────────────────────────

/**
 * The rate request as the agent read it, and the New quote editor seeded from it.
 *
 * The agent never raises the quote. "Create quote" opens `/tms/rates/new?run=…`, which is
 * the same editor the rates board opens; it fetches this run, pre-types what was read and
 * leaves the pricing blank. The operator's own Save runs SAVE_QUOTE under their identity,
 * lands the quote in REQUESTED, and only then is this run linked to it.
 */
function QuoteCard({ run, proposal }: ProposalCardProps & { proposal: QuoteProposal }) {
  const navigate = useNavigate()
  const applied = run.outcome === 'APPLIED'
  return (
    <TmsCard
      title="Proposed quote"
      actions={applied ? null : (
        <TmsButton variant="primary" size="sm" onClick={() => navigate(`/tms/rates/new?run=${encodeURIComponent(run.id)}`)}>
          Create quote
        </TmsButton>
      )}
    >
      <p className="tms-muted text-xs">
        Opens a new quote seeded from this proposal. Nothing is priced for you, and saving it
        links this run to the quote.
      </p>
      <dl className="tms-grid tms-grid-4">
        <Fact label="Customer" value={run.partyName ?? proposal.customerName} />
        <Fact label="Origin" value={placeOf(proposal.origin)} />
        <Fact label="Destination" value={placeOf(proposal.destination)} />
        <Fact label="Equipment" value={proposal.equipmentType} />
        <Fact label="Pickup" value={proposal.pickupDate} />
        <Fact label="Delivery" value={proposal.deliveryDate} />
        <Fact label="Commodity" value={proposal.commodity} />
        <Fact label="Weight" value={proposal.weightLbs ? `${proposal.weightLbs.toLocaleString()} lb` : null} />
        {/* Their number, never ours: a target the customer named is not a quote. */}
        <Fact label="Target rate" value={proposal.targetRateCents != null ? formatCents(proposal.targetRateCents) : null} />
      </dl>
      {proposal.memoryHint ? <p className="tms-muted mt-3 text-xs">Memory used: {proposal.memoryHint}</p> : null}
      {proposal.notes ? <p className="mt-3 text-sm">{proposal.notes}</p> : null}
    </TmsCard>
  )
}

// ── CARRIER_BILL ─────────────────────────────────────────────────────────────

function CarrierBillCard({ run, proposal }: ProposalCardProps & { proposal: CarrierBillProposal }) {
  const shipmentId = proposal.shipmentId ?? run.shipmentId ?? null
  const pending = (run.documents ?? []).length
  return (
    <TmsCard
      title="Proposed carrier bill"
      actions={shipmentId ? (
        <Link className="tms-btn tms-btn-primary tms-btn-sm" to={`/tms/shipments/${shipmentId}?tab=carrierPay`}>
          Open Carrier Pay
        </Link>
      ) : null}
    >
      <dl className="tms-grid tms-grid-4">
        <Fact label="Carrier" value={proposal.carrierName ?? run.partyName} />
        <Fact label="Shipment" value={proposal.shipmentNumber ?? run.shipmentNumber} />
        <Fact label="Invoice #" value={proposal.invoiceNumber} />
        <Fact label="Amount" value={proposal.amountCents != null ? formatCents(proposal.amountCents) : null} />
        <Fact label="Invoice date" value={proposal.invoiceDate} />
        <Fact label="Due" value={proposal.dueDate} />
        {/* The run files the invoice as a PENDING document; a person reviews it there. */}
        <Fact label="Documents filed" value={pending ? `${pending} PENDING` : null} />
      </dl>
      {!shipmentId ? (
        <p className="tms-muted mt-3 text-sm">
          No shipment was matched, so there is no Carrier Pay tab to open. Name the party or dismiss the run.
        </p>
      ) : null}
    </TmsCard>
  )
}

// ── VENDOR_BILL ──────────────────────────────────────────────────────────────

function VendorBillCard({ proposal }: ProposalCardProps & { proposal: VendorBillProposal }) {
  return (
    <TmsCard
      title="Proposed vendor bill"
      actions={<Link className="tms-btn tms-btn-primary tms-btn-sm" to="/tms/vendors">Open in Vendors</Link>}
    >
      <dl className="tms-grid tms-grid-4">
        <Fact label="Vendor" value={proposal.vendorName} />
        <Fact label="Invoice #" value={proposal.invoiceNumber} />
        <Fact label="Amount" value={proposal.amountCents != null ? formatCents(proposal.amountCents) : null} />
        <Fact label="Due" value={proposal.dueDate} />
      </dl>
    </TmsCard>
  )
}

// ── CAPACITY ─────────────────────────────────────────────────────────────────

/** A posting is read and noted. There is nothing to apply, so there is no button. */
function CapacityCard({ run, proposal }: ProposalCardProps & { proposal: CapacityProposal }) {
  return (
    <TmsCard title="Capacity noted">
      <dl className="tms-grid tms-grid-4">
        <Fact label="Carrier" value={proposal.carrierName ?? run.partyName} />
        <Fact label="Equipment" value={proposal.equipment} />
        <Fact label="From" value={[proposal.originCity, proposal.originState].filter(Boolean).join(', ')} />
        <Fact label="To" value={[proposal.destinationCity, proposal.destinationState].filter(Boolean).join(', ')} />
        <Fact label="Available" value={proposal.availableDate} />
        <Fact label="Trucks" value={proposal.trucks != null ? String(proposal.trucks) : null} />
      </dl>
      {proposal.notes ? <p className="mt-3 text-sm">{proposal.notes}</p> : null}
    </TmsCard>
  )
}

// ── UNKNOWN_PARTY / NONE ─────────────────────────────────────────────────────

/**
 * Nobody was matched, so the run stops and asks. A candidate is a suggestion and never
 * an answer: naming one is a person's decision, and SET_RUN_PARTY re-runs the match
 * steps from there.
 */
function UnknownPartyCard({ run, onChanged }: ProposalCardProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const candidates = run.partyCandidates ?? []
  const name = (run.partyName ?? run.fromName ?? '').trim()

  return (
    <TmsCard title={candidates.length ? 'Who sent this?' : 'Nothing was proposed'}>
      {candidates.length === 0 ? (
        <p className="text-sm">
          The sender was not matched to a customer or a carrier, and nothing in the message was
          close enough to suggest one.
        </p>
      ) : (
        <ul className="text-sm">
          {candidates.map((candidate) => (
            <li key={`${candidate.kind}:${candidate.id}`} className="flex items-center gap-2 py-1">
              <span>{candidate.name}</span>
              <span className="tms-muted text-xs">{candidate.kind === 'CUSTOMER' ? 'Customer' : 'Carrier'} · matched on {candidate.how.toLowerCase()}</span>
              <TmsButton
                size="sm"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy(candidate.id)
                  try {
                    await setWorkflowRunParty(
                      run.id,
                      { partyKind: candidate.kind, partyId: candidate.id },
                      run.version ?? 0,
                    )
                    toast.success(`Party set to ${candidate.name}`)
                    await onChanged()
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : 'Could not set the party')
                  } finally {
                    setBusy(null)
                  }
                }}
              >
                {busy === candidate.id ? 'Setting…' : 'Pick party'}
              </TmsButton>
            </li>
          ))}
        </ul>
      )}
      <p className="tms-muted mt-3 text-sm">
        {/* The directory list does not seed its form from the query string, so the name is
            printed here to be copied rather than promised in a link that would drop it. */}
        Not one of these? Create the record under its real name
        {name ? <> — the sender signed as <strong>{name}</strong></> : null}:{' '}
        <Link to="/tms/customers">Create customer</Link> · <Link to="/tms/carriers">Create carrier</Link>
      </p>
    </TmsCard>
  )
}

/**
 * The proposal, by kind. `proposalKind` is what the row says it proposed, and the
 * proposal itself carries the same discriminant — the switch is over the proposal so a
 * malformed row renders the honest "nothing was proposed" card instead of guessing.
 */
export function ProposalCard(props: ProposalCardProps) {
  const { run } = props
  if (run.outcome === 'UNKNOWN_PARTY') return <UnknownPartyCard {...props} />
  const proposal = run.proposal
  if (!proposal) return <UnknownPartyCard {...props} />

  switch (proposal.kind) {
    case 'TENDER':
      return <TenderCard {...props} proposal={proposal} />
    case 'QUOTE':
      return <QuoteCard {...props} proposal={proposal} />
    case 'CARRIER_BILL':
      return <CarrierBillCard {...props} proposal={proposal} />
    case 'VENDOR_BILL':
      return <VendorBillCard {...props} proposal={proposal} />
    case 'CAPACITY':
      return <CapacityCard {...props} proposal={proposal} />
  }
}

export default ProposalCard
