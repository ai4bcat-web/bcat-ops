/**
 * Generate a bill of lading, a load summary or a saved copy of the rate confirmation,
 * look at it, and keep it on the shipment.
 *
 * The PDF is built in the browser from the bundle already on screen — the same
 * `jsPDF` → base64 → Lambda route the rate confirmation uses (`RateConPanel`) — so
 * nothing is rendered server-side and the preview is byte-for-byte the file that gets
 * saved. Saving is explicit about what it costs: a second BOL is v2 and leaves v1
 * SUPERSEDED rather than overwriting it, because a dock may already be holding v1.
 *
 * A load summary carries both sides of the money, so the Lambda writes it with
 * audience INTERNAL and this dialog offers no way to change that.
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FileText, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { getTmsSettings, listCheckCallsByLoad, listDivisions, saveGeneratedDocument } from '@/lib/apiClient'
import { bolData, loadSummaryData } from '@/lib/documentData'
import { buildBolPdf, bolFilename } from '@/lib/bolPdf'
import { buildLoadSummaryPdf, loadSummaryFilename } from '@/lib/loadSummaryPdf'
import { buildRateConPdf, type RateConInput, type RateConStop } from '@/lib/carrierRateCon'
import { generatedFilename, nextVersion, DOCUMENT_TYPE_LABELS } from '@/lib/shipmentDocuments'
import { quickPayTiersOf, tierFor } from '@/lib/quickPay'
import type {
  ChargeCodeDef, CustomerRecord, Division, LoadCheckCallRecord, LocationRecord, RateConRequiredField,
  ShipmentBundle, TmsSettings,
} from '@/types/tms'

export type GeneratedKind = 'BOL' | 'LOAD_SUMMARY' | 'RATE_CON'

const TITLES: Record<GeneratedKind, string> = {
  BOL: 'Generate a bill of lading',
  LOAD_SUMMARY: 'Generate a load summary',
  RATE_CON: 'Save a copy of the rate confirmation',
}

/** Same default the rate con panel uses when settings have never been filled in. */
const DEFAULT_REQUIRED_FIELDS: RateConRequiredField[] = ['DRIVER_NAME', 'DRIVER_PHONE', 'TRUCK_NUMBER']

export function GeneratedDocumentDialog({
  kind, bundle, customer, locations, catalog, onClose, onSaved,
}: {
  kind: GeneratedKind
  bundle: ShipmentBundle
  customer: CustomerRecord | null
  locations: LocationRecord[]
  catalog: ChargeCodeDef[]
  onClose: () => void
  /** The row landed: the tab re-reads its documents. */
  onSaved: () => void
}) {
  const [divisions, setDivisions] = useState<Division[]>([])
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [checkCalls, setCheckCalls] = useState<LoadCheckCallRecord[]>([])
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [base64, setBase64] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Derived rather than its own flag: the effect below writes no state synchronously,
  // so "still building" is exactly "nothing built and nothing failed yet".
  const building = previewUrl === null && error === null

  const load = bundle.loads[0] ?? null
  const assignment = bundle.loadCarriers.find((c) => c.status === 'ACTIVE') ?? null
  const loadNumber = load?.loadNumber ?? load?.id ?? bundle.shipment.number

  // A BOL belongs to the shipment (its number is the BOL number); a load summary and a
  // rate con belong to one load, which is what versions them separately per leg.
  const loadId = kind === 'BOL' ? null : load?.id ?? null
  const version = useMemo(
    () => nextVersion(bundle.documents, kind, loadId),
    [bundle.documents, kind, loadId],
  )
  const filename = kind === 'BOL'
    ? bolFilename(bundle.shipment.number, version)
    : kind === 'LOAD_SUMMARY'
      ? loadSummaryFilename(loadNumber, version)
      : generatedFilename('RATE_CON', loadNumber, version)

  // No synchronous setState before the first await; a failed read keeps what we had.
  useEffect(() => {
    let live = true
    Promise.all([
      listDivisions().catch(() => [] as Division[]),
      getTmsSettings().catch(() => null),
      kind === 'LOAD_SUMMARY' && load?.id
        ? listCheckCallsByLoad(load.id).catch(() => [] as LoadCheckCallRecord[])
        : Promise.resolve([] as LoadCheckCallRecord[]),
    ]).then(([d, s, calls]) => {
      if (!live) return
      setDivisions(d)
      setSettings(s)
      setCheckCalls(calls)
    })
    return () => { live = false }
  }, [kind, load?.id])

  const division = divisions.find((d) => d.key === load?.divisionKey) ?? divisions[0] ?? null

  /*
   * The rate confirmation is assembled here rather than reused from `RateConPanel`,
   * whose builder is private to the panel that sends one. A saved copy has to print
   * the same figures the carrier signed, so the assembly is the same: the assignment's
   * own snapshot of the carrier, this assignment's CARRIER charge lines, and the terms
   * and required fields in force now.
   */
  const rateConInput = (): RateConInput => {
    if (!assignment) throw new Error('A rate confirmation needs the carrier that is currently on the load')
    const charges = bundle.charges
      .filter((c) => c.side === 'CARRIER' && (c.loadCarrierId == null || c.loadCarrierId === assignment.id))
      .map((c) => ({ label: c.label || c.code, amountCents: c.amountCents }))
    const totalCents = charges.reduce((sum, c) => sum + c.amountCents, 0)
    const tier = assignment.quickPayDays ? tierFor(assignment.quickPayDays, quickPayTiersOf(settings)) : null
    return {
      division,
      carrier: {
        name: assignment.carrierName ?? 'Carrier',
        mcNumber: assignment.carrierMc ?? null,
        dotNumber: null,
        phone: assignment.dispatcherPhone ?? null,
        email: assignment.dispatcherEmail ?? null,
      },
      loadCarrier: assignment,
      loadNumber,
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
        references: (s.refs ?? [])
          .filter((r) => r.visibility === 'CARRIER' || r.visibility === 'ALL')
          .map((r) => ({ label: r.label || r.code, value: r.value })),
        instructions: s.stopNotes ?? null,
      })),
      charges,
      totalCents,
      quickPay: tier && assignment.quickPayFeeCents != null
        ? {
          days: tier.days,
          feeBps: tier.feeBps,
          feeCents: assignment.quickPayFeeCents,
          netCents: (assignment.carrierRateCents ?? totalCents) - assignment.quickPayFeeCents,
        }
        : null,
      paymentTermsDays: assignment.paymentTermsDays ?? settings?.defaultCarrierTermsDays ?? null,
      terms: settings?.rateConTerms ?? '',
      requiredFields: (settings?.rateConRequiredFields as RateConRequiredField[] | null) ?? DEFAULT_REQUIRED_FIELDS,
    }
  }

  // Rebuilt whenever what it is built from changes, and the old object URL is released
  // with it — an iframe holding a revoked URL is a blank page, so the revoke happens on
  // the way out rather than the way in.
  useEffect(() => {
    let live = true
    let url: string | null = null

    const build = async () => {
      if (kind === 'BOL') {
        return buildBolPdf(bolData(bundle, customer, division, locations, {
          brokerPhone: settings?.trackingContact?.phone ?? null,
          terms: settings?.bolTerms ?? null,
        }))
      }
      if (kind === 'LOAD_SUMMARY') {
        return buildLoadSummaryPdf(loadSummaryData(bundle, customer, catalog, checkCalls))
      }
      return buildRateConPdf(rateConInput())
    }

    build()
      .then((doc) => {
        if (!live) return
        url = URL.createObjectURL(doc.output('blob'))
        setPreviewUrl(url)
        // Base64 with no data-URI prefix — what SAVE_GENERATED_DOCUMENT expects.
        setBase64(doc.output('datauristring').split('base64,')[1] ?? '')
        setError(null)
      })
      .catch((err: unknown) => {
        if (!live) return
        setBase64(null)
        setError(err instanceof Error ? err.message : 'The document could not be built')
      })

    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
    // The builders read the whole bundle; re-running on every field of it would rebuild
    // the PDF on each poll, so the inputs that actually change the page are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, bundle.documents, division, settings, checkCalls, customer, locations, catalog])

  const save = async () => {
    if (!base64) { setError('There is nothing built to save yet.'); return }
    setSaving(true)
    setError(null)
    try {
      await saveGeneratedDocument({
        shipmentId: bundle.shipment.id,
        type: kind,
        loadId,
        loadCarrierId: kind === 'RATE_CON' ? assignment?.id ?? null : null,
        pdfBase64: base64,
        filename,
      })
      toast.success(`${DOCUMENT_TYPE_LABELS[kind]} saved as v${version}`)
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The document could not be saved')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>{TITLES[kind]}</DialogTitle></DialogHeader>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="outline" className="text-[10px]">{DOCUMENT_TYPE_LABELS[kind]}</Badge>
          <span className="text-muted-foreground">{filename}</span>
          {kind === 'LOAD_SUMMARY' && (
            <Badge variant="outline" className="text-[10px]">Internal — never e-mailed out</Badge>
          )}
        </div>

        <div className="h-[55vh] overflow-hidden rounded-lg border border-border bg-muted/30">
          {building && (
            <p className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <FileText size={14} />Building the document…
            </p>
          )}
          {!building && previewUrl && (
            <iframe src={previewUrl} title={`${DOCUMENT_TYPE_LABELS[kind]} preview`} className="h-full w-full" />
          )}
          {!building && !previewUrl && (
            <p className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Nothing to preview.
            </p>
          )}
        </div>

        {error && (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}
          </p>
        )}

        <DialogFooter className="items-center">
          <p className="mr-auto text-xs text-muted-foreground">
            {version > 1
              ? `Save as v${version} — v${version - 1} becomes superseded`
              : 'Save as v1 — the first version of this document'}
          </p>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => { void save() }} disabled={saving || building || !base64}>
            <Save size={14} className="mr-1" />{saving ? 'Saving…' : `Save as v${version}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
