/**
 * The rate confirmation for one booked carrier: build it, look at it, send it, chase it
 * (spec §6.2 "Rate con").
 *
 * The PDF is built in the browser from what is on screen — the division letterhead (with
 * its logo), the stops, the CARRIER charge lines — and handed to the Lambda as base64, so
 * what the carrier opens is exactly the document the booker approved. The server owns the
 * token, the expiry and the status; this panel only reports them. Recipients are picked
 * from the carrier's known addresses (or typed), the sender is copied by the server, and
 * a carrier without a completed MyCarrierPackets packet cannot be sent a rate con.
 */
import { useEffect, useMemo, useState } from 'react'
import { Ban, Copy, FileText, Send } from 'lucide-react'
import { Link } from 'react-router-dom'
import { TmsBadge, TmsButton, TmsField, TmsInput } from '@/features/tms/kit'
import { toast } from 'sonner'
import { getRateConfirmUrl, listDivisions } from '@/lib/apiClient'
import { buildRateConPdf, joinRateConNotes, rateConFilename, rateConPdfBase64 } from '@/lib/carrierRateCon'
import { useAuthUser } from '@/hooks/useAuth'
import { dedupeEmails } from '@/lib/emailAddress'
import { mcpPacketStanding } from '@/lib/mcpPacket'
import { RecipientPicker } from './RecipientPicker'
import { commitAddress, defaultSelection, knownRecipientOptions, parseCcList } from './rateConRecipients'
import { quickPayTiersOf, tierFor } from '@/lib/quickPay'
import { formatDateTime } from '@/lib/date'
import { formatCents } from '@/lib/tmsDirectory'
import type { RateConInput, RateConStop } from '@/lib/carrierRateCon'
import { readExtras } from '@/features/shipments/form/model'
import type {
  CarrierContactRecord, CarrierRecord, Division, LoadCarrierRecord, RateConRequiredField, RateConStatus,
  ShipmentBundle, TmsSettings,
} from '@/types/tms'

/** The lifecycle the panel reports, in the order it happens. */
const TIMELINE: RateConStatus[] = ['NOT_SENT', 'SENT', 'OPENED', 'SIGNED']

const STATUS_LABELS: Record<RateConStatus, string> = {
  NOT_SENT: 'Not sent',
  SENT: 'Sent',
  OPENED: 'Opened',
  SIGNED: 'Signed',
  DECLINED: 'Declined',
  VOIDED: 'Voided',
  EXPIRED: 'Expired',
}

const DEFAULT_REQUIRED_FIELDS: RateConRequiredField[] = ['DRIVER_NAME', 'DRIVER_PHONE', 'TRUCK_NUMBER']

export interface RateConPanelProps {
  bundle: ShipmentBundle
  loadCarrier: LoadCarrierRecord
  carrier: CarrierRecord | null
  contacts: CarrierContactRecord[]
  settings: TmsSettings | null
  busy: boolean
  onSend: (input: { loadCarrierId: string; pdfBase64: string; to: string[]; cc?: string[]; expiresHours?: number }) => Promise<void>
  onVoid: (input: { loadCarrierId: string }) => Promise<void>
}

export function RateConPanel({ bundle, loadCarrier, carrier, contacts, settings, busy, onSend, onVoid }: RateConPanelProps) {
  const [divisions, setDivisions] = useState<Division[]>([])
  // The ticked list starts from the carrier profile and only becomes state once the
  // user edits it — mirroring the default into state would fight the carrier bundle
  // arriving a tick later.
  const [selectedOverride, setSelectedOverride] = useState<string[] | null>(null)
  const [extras, setExtras] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const user = useAuthUser()
  const [cc, setCc] = useState('')
  const [expiryHours, setExpiryHours] = useState('')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    listDivisions().catch(() => []).then((d) => { if (live) setDivisions(d) })
    return () => { live = false }
  }, [])

  // Everything the profile knows for this booking, and who is ticked until the user
  // touches the list (the carrier's own dispatcher is the fallback when it has no contacts).
  const options = useMemo(
    () => knownRecipientOptions({ carrier, contacts, loadCarrier }),
    [carrier, contacts, loadCarrier],
  )
  const defaults = useMemo(() => defaultSelection({ carrier, contacts }), [carrier, contacts])
  const selected = selectedOverride ?? defaults
  const recipients = dedupeEmails([...selected, ...extras])
  // Text still in the "Add another address" box counts: Send commits it (or refuses it).
  const noRecipients = recipients.length === 0 && !draft.trim()

  const standing = carrier ? mcpPacketStanding(carrier) : null
  // When the carrier bundle has not loaded the server is the authority; only a loaded
  // carrier known to lack a completed packet pre-blocks the button.
  const blocked = standing != null && !standing.completed

  const load = bundle.loads[0]
  const division = divisions.find((d) => d.key === load?.divisionKey) ?? null
  const status: RateConStatus = loadCarrier.rateConStatus ?? 'NOT_SENT'
  const sent = status === 'SENT' || status === 'OPENED'
  const version = loadCarrier.rateConVersion ?? 0

  const charges = bundle.charges
    .filter((c) => c.side === 'CARRIER' && (c.loadCarrierId == null || c.loadCarrierId === loadCarrier.id))
    .map((c) => ({ label: c.label || c.code, amountCents: c.amountCents }))
  const totalCents = charges.reduce((sum, c) => sum + c.amountCents, 0)

  const tier = loadCarrier.quickPayDays ? tierFor(loadCarrier.quickPayDays, quickPayTiersOf(settings)) : null

  const buildInput = (): RateConInput => ({
    division,
    carrier: {
      name: carrier?.name ?? loadCarrier.carrierName ?? 'Carrier',
      mcNumber: carrier?.mcNumber ?? loadCarrier.carrierMc ?? null,
      dotNumber: carrier?.dotNumber ?? null,
      phone: carrier?.phone ?? null,
      email: carrier?.email ?? null,
    },
    loadCarrier,
    loadNumber: load?.loadNumber ?? load?.id ?? '',
    equipmentType: load?.equipmentType ?? null,
    commodity: load?.commodity ?? null,
    weightLbs: load?.weight ?? null,
    stops: (load?.stops ?? []).map<RateConStop>((s) => ({
      kind: s.type === 'pickup' ? 'PICKUP' : 'DELIVERY',
      name: s.name ?? null,
      address: s.address?.street ?? null,
      city: s.address?.city ?? s.city ?? null,
      state: s.address?.state ?? null,
      zip: s.address?.zip ?? null,
      apptAt: s.appt ?? null,
      apptEnd: s.apptEnd ?? null,
      apptType: s.apptType ?? null,
      // Only what the carrier is allowed to see — internal and customer-only references
      // never reach a rate con.
      references: (s.refs ?? [])
        .filter((r) => r.visibility === 'CARRIER' || r.visibility === 'ALL')
        .map((r) => ({ label: r.label || r.code, value: r.value })),
      instructions: s.stopNotes ?? null,
    })),
    charges,
    totalCents,
    quickPay: tier && loadCarrier.quickPayFeeCents != null
      ? {
        days: tier.days,
        feeBps: tier.feeBps,
        feeCents: loadCarrier.quickPayFeeCents,
        netCents: (loadCarrier.carrierRateCents ?? totalCents) - loadCarrier.quickPayFeeCents,
      }
      : null,
    paymentTermsDays: loadCarrier.paymentTermsDays ?? settings?.defaultCarrierTermsDays ?? null,
    terms: settings?.rateConTerms ?? '',
    notes: joinRateConNotes(
      readExtras(bundle.orders[0])?.instructions?.special,
      readExtras(bundle.orders[0])?.instructions?.rateCon,
    ),
    requiredFields: (settings?.rateConRequiredFields as RateConRequiredField[] | null) ?? DEFAULT_REQUIRED_FIELDS,
  })

  const preview = async () => {
    setWorking(true)
    setError(null)
    try {
      const doc = await buildRateConPdf(buildInput())
      setPreviewUrl(doc.output('datauristring'))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build the rate confirmation.')
    } finally {
      setWorking(false)
    }
  }

  const send = async () => {
    let toList = recipients
    if (draft.trim()) {
      // A half-typed address is sent, or refuses the send — never silently dropped.
      const result = commitAddress({ text: draft, options, selected, extras })
      if (!result.ok) { setError(result.error); return }
      setSelectedOverride(result.selected)
      setExtras(result.extras)
      setDraft('')
      toList = dedupeEmails([...result.selected, ...result.extras])
    }
    if (toList.length === 0) { setError('At least one recipient is required.'); return }
    const ccParsed = parseCcList(cc)
    if (ccParsed.invalid.length > 0) { setError(`CC: "${ccParsed.invalid[0]}" is not a valid email address.`); return }
    setWorking(true)
    setError(null)
    try {
      const doc = await buildRateConPdf(buildInput())
      await onSend({
        loadCarrierId: loadCarrier.id,
        pdfBase64: rateConPdfBase64(doc),
        to: toList,
        cc: ccParsed.emails,
        expiresHours: expiryHours ? Number(expiryHours) : undefined,
      })
    } catch (err) {
      if (err instanceof Error && err.message) setError(err.message)
    } finally {
      setWorking(false)
    }
  }

  const copyLink = async () => {
    if (!loadCarrier.rateConToken) return
    const link = `${window.location.origin}/sign/rate-con/${loadCarrier.rateConToken}`
    await navigator.clipboard.writeText(link)
    toast.success('Signing link copied')
  }

  const openSigned = async () => {
    if (!loadCarrier.rateConKey) return
    window.open(await getRateConfirmUrl(loadCarrier.rateConKey), '_blank', 'noopener')
  }

  return (
    <div
      className="flex flex-col gap-3 p-3"
      style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
    >
      <div className="flex items-center gap-2">
        <FileText size={14} className="tms-muted" />
        <p className="font-medium">Rate confirmation</p>
        <TmsBadge tone="gray">{STATUS_LABELS[status]}{version > 0 ? ` · v${version}` : ''}</TmsBadge>
      </div>

      <ol className="flex items-center gap-2 text-[10px] uppercase tracking-wider">
        {TIMELINE.map((s) => {
          const reached = TIMELINE.indexOf(status) >= TIMELINE.indexOf(s) && TIMELINE.includes(status)
          return (
            <li
              key={s}
              className="rounded px-1.5 py-0.5"
              style={reached
                ? { color: 'var(--tms-text)', border: '1px solid var(--tms-primary)' }
                : { color: 'var(--tms-muted)' }}
            >
              {STATUS_LABELS[s]}
            </li>
          )
        })}
      </ol>

      <dl className="tms-grid tms-grid-3 text-xs">
        <Fact label="Sent" value={loadCarrier.rateConSentAt ? formatDateTime(loadCarrier.rateConSentAt) : '—'} />
        <Fact label="Sent to" value={loadCarrier.rateConSentTo ?? '—'} />
        <Fact label="Expires" value={loadCarrier.rateConExpiresAt ? formatDateTime(loadCarrier.rateConExpiresAt) : '—'} />
        <Fact label="Signed" value={loadCarrier.rateConSignedAt ? formatDateTime(loadCarrier.rateConSignedAt) : '—'} />
        <Fact label="Signed by" value={loadCarrier.rateConSignerName ?? '—'} />
        <Fact label="Total" value={`$${formatCents(totalCents)}`} />
      </dl>

      <RecipientPicker
        options={options}
        selected={selected}
        extras={extras}
        draft={draft}
        onDraftChange={setDraft}
        onSelectedChange={setSelectedOverride}
        onExtrasChange={setExtras}
        disabled={busy || working}
      />
      <div className="tms-grid tms-grid-2">
        <TmsField label="CC">
          <TmsInput aria-label="Rate con cc" value={cc} onChange={(e) => setCc(e.target.value)} />
        </TmsField>
        <TmsField label="Expires in (hours)">
          <TmsInput
            aria-label="Rate con expiry hours"
            type="number"
            min={1}
            value={expiryHours}
            onChange={(e) => setExpiryHours(e.target.value)}
            placeholder={String(settings?.rateConExpiryHours ?? 48)}
          />
        </TmsField>
      </div>
      {user?.email && (
        <p className="text-xs tms-muted">You ({user.email}) are copied automatically.</p>
      )}

      {blocked && carrier && standing && (
        <p role="status" className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>
          Can't send yet — {carrier.name} {standing.reason}{' '}
          <Link to={`/tms/carriers/${carrier.id}`} className="underline">Open carrier profile</Link>
          {' '}(send a setup packet there).
        </p>
      )}
      {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}

      <div className="flex flex-wrap gap-2">
        <TmsButton size="sm" onClick={preview} disabled={working}>
          <FileText size={14} />Preview
        </TmsButton>
        <TmsButton
          variant="primary"
          size="sm"
          onClick={send}
          disabled={busy || working || blocked || noRecipients}
          title={blocked
            ? 'This carrier has no completed MyCarrierPackets packet'
            : noRecipients ? 'Pick at least one recipient' : undefined}
        >
          <Send size={14} />{version > 0 ? 'Re-send' : 'Send'}
        </TmsButton>
        {sent && (
          <>
            <TmsButton size="sm" onClick={copyLink} disabled={!loadCarrier.rateConToken}>
              <Copy size={14} />Copy link
            </TmsButton>
            <TmsButton size="sm" onClick={() => onVoid({ loadCarrierId: loadCarrier.id })} disabled={busy}>
              <Ban size={14} />Void
            </TmsButton>
          </>
        )}
        {status === 'SIGNED' && loadCarrier.rateConKey && (
          <TmsButton size="sm" onClick={openSigned}>Open signed PDF</TmsButton>
        )}
      </div>

      {previewUrl && (
        <div className="flex flex-col gap-1">
          <iframe
            title="Rate confirmation preview"
            src={previewUrl}
            className="h-96 w-full"
            style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
          />
          <a
            href={previewUrl}
            download={rateConFilename(load?.loadNumber ?? 'load', version + 1)}
            className="text-xs underline"
          >
            Download a copy
          </a>
        </div>
      )}
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wider tms-muted">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  )
}
