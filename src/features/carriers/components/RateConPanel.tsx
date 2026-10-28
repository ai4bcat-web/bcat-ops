/**
 * The rate confirmation for one booked carrier: build it, look at it, send it, chase it
 * (spec §6.2 "Rate con").
 *
 * The PDF is built in the browser from what is on screen — the division letterhead, the
 * stops, the CARRIER charge lines — and handed to the Lambda as base64, so what the
 * carrier opens is exactly the document the booker approved. The server owns the token,
 * the expiry and the status; this panel only reports them.
 */
import { useEffect, useMemo, useState } from 'react'
import { Ban, Copy, FileText, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { getRateConfirmUrl, listDivisions } from '@/lib/apiClient'
import { buildRateConPdf, rateConFilename, rateConPdfBase64 } from '@/lib/carrierRateCon'
import { quickPayTiersOf, tierFor } from '@/lib/quickPay'
import { formatDateTime } from '@/lib/date'
import { formatCents } from '@/lib/tmsDirectory'
import { cn } from '@/lib/utils'
import type { RateConInput, RateConStop } from '@/lib/carrierRateCon'
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
  // The recipient box starts from the carrier profile and only becomes state once the
  // user edits it — mirroring the default into state would fight the carrier bundle
  // arriving a tick later.
  const [toOverride, setToOverride] = useState<string | null>(null)
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

  // Dispatch contacts first, then anyone flagged as a rate-con recipient; the carrier's
  // own dispatcher email is the fallback when the profile has no contacts yet.
  const defaultRecipients = useMemo(() => {
    const picked = contacts
      .filter((c) => c.active !== false && c.email)
      .filter((c) => c.rateConRecipient || c.types?.includes('DISPATCH'))
      .map((c) => c.email as string)
    const fallback = [carrier?.dispatcherEmail, carrier?.email].filter((e): e is string => !!e)
    return Array.from(new Set(picked.length > 0 ? picked : fallback))
  }, [contacts, carrier])

  const to = toOverride ?? defaultRecipients.join(', ')

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
    const recipients = to.split(',').map((e) => e.trim()).filter(Boolean)
    if (recipients.length === 0) { setError('At least one recipient is required.'); return }
    setWorking(true)
    setError(null)
    try {
      const doc = await buildRateConPdf(buildInput())
      await onSend({
        loadCarrierId: loadCarrier.id,
        pdfBase64: rateConPdfBase64(doc),
        to: recipients,
        cc: cc.split(',').map((e) => e.trim()).filter(Boolean),
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
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <FileText size={14} className="text-muted-foreground" />
        <p className="text-sm font-medium">Rate confirmation</p>
        <Badge variant="outline" className="text-[10px]">{STATUS_LABELS[status]}{version > 0 ? ` · v${version}` : ''}</Badge>
      </div>

      <ol className="flex items-center gap-2 text-[10px] uppercase tracking-wider">
        {TIMELINE.map((s) => {
          const reached = TIMELINE.indexOf(status) >= TIMELINE.indexOf(s) && TIMELINE.includes(status)
          return (
            <li key={s} className={cn('rounded px-1.5 py-0.5', reached ? 'bg-primary/10 text-foreground' : 'text-muted-foreground')}>
              {STATUS_LABELS[s]}
            </li>
          )
        })}
      </ol>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        <Fact label="Sent" value={loadCarrier.rateConSentAt ? formatDateTime(loadCarrier.rateConSentAt) : '—'} />
        <Fact label="Sent to" value={loadCarrier.rateConSentTo ?? '—'} />
        <Fact label="Expires" value={loadCarrier.rateConExpiresAt ? formatDateTime(loadCarrier.rateConExpiresAt) : '—'} />
        <Fact label="Signed" value={loadCarrier.rateConSignedAt ? formatDateTime(loadCarrier.rateConSignedAt) : '—'} />
        <Fact label="Signed by" value={loadCarrier.rateConSignerName ?? '—'} />
        <Fact label="Total" value={`$${formatCents(totalCents)}`} />
      </dl>

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">To</Label>
          <Input aria-label="Rate con recipients" value={to} onChange={(e) => setToOverride(e.target.value)} className="h-9 text-sm" />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">CC</Label>
          <Input aria-label="Rate con cc" value={cc} onChange={(e) => setCc(e.target.value)} className="h-9 text-sm" />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Expires in (hours)</Label>
          <Input
            aria-label="Rate con expiry hours"
            type="number"
            min={1}
            value={expiryHours}
            onChange={(e) => setExpiryHours(e.target.value)}
            placeholder={String(settings?.rateConExpiryHours ?? 48)}
            className="h-9 text-sm"
          />
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={preview} disabled={working}>
          <FileText size={14} className="mr-1" />Preview
        </Button>
        <Button size="sm" onClick={send} disabled={busy || working}>
          <Send size={14} className="mr-1" />{version > 0 ? 'Re-send' : 'Send'}
        </Button>
        {sent && (
          <>
            <Button variant="outline" size="sm" onClick={copyLink} disabled={!loadCarrier.rateConToken}>
              <Copy size={14} className="mr-1" />Copy link
            </Button>
            <Button variant="outline" size="sm" onClick={() => onVoid({ loadCarrierId: loadCarrier.id })} disabled={busy}>
              <Ban size={14} className="mr-1" />Void
            </Button>
          </>
        )}
        {status === 'SIGNED' && loadCarrier.rateConKey && (
          <Button variant="outline" size="sm" onClick={openSigned}>Open signed PDF</Button>
        )}
      </div>

      {previewUrl && (
        <div className="space-y-1">
          <iframe title="Rate confirmation preview" src={previewUrl} className="h-96 w-full rounded-md border border-border" />
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
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  )
}
