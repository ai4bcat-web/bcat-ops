/**
 * Generate a load summary or a saved copy of the rate confirmation,
 * look at it, and keep it on the shipment.
 *
 * The PDF is built in the browser from the bundle already on screen — the same
 * `jsPDF` → base64 → Lambda route the rate confirmation uses (`RateConPanel`) — so
 * nothing is rendered server-side and the preview is byte-for-byte the file that gets
 * saved. Saving is explicit about what it costs: a second copy is v2 and leaves v1
 * SUPERSEDED rather than overwriting it, because a dock may already be holding v1.
 *
 * A load summary carries both sides of the money, so the Lambda writes it with
 * audience INTERNAL and this dialog offers no way to change that.
 */
import { useEffect, useMemo, useState } from 'react'
import { FileText, Save } from 'lucide-react'
import { toast } from 'sonner'
import { TmsAlert, TmsBadge, TmsButton, TmsDialog } from '@/features/tms/kit'
import { getRateConRevision, listCheckCallsByLoad, listUserProfiles, saveGeneratedDocument } from '@/lib/apiClient'
import { loadSummaryData } from '@/lib/documentData'
import { buildLoadSummaryPdf, loadSummaryFilename } from '@/lib/loadSummaryPdf'
import { buildRateConPdf, joinRateConNotes, rateConPdfBase64, rateConRepOf, type RateConInput, type RateConStop } from '@/lib/carrierRateCon'
import { readExtras } from '../form/model'
import { rateConChargesFor } from '@/lib/carrierBill'
import { generatedFilename, nextVersion, DOCUMENT_TYPE_LABELS } from '@/lib/shipmentDocuments'
import type {
  ChargeCodeDef, CustomerRecord, LoadCheckCallRecord, LocationRecord,
  ShipmentBundle, UserProfileRecord,
} from '@/types/tms'

export type GeneratedKind = 'LOAD_SUMMARY' | 'RATE_CON'

const TITLES: Record<GeneratedKind, string> = {
  LOAD_SUMMARY: 'Generate a load summary',
  RATE_CON: 'Save a copy of the rate confirmation',
}


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
  const [profiles, setProfiles] = useState<UserProfileRecord[]>([])
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

  // A load summary and a rate con belong to one load, which is what versions them
  // separately per leg. (The bill of lading has its own dialog: `BolDialog`.)
  const loadId = load?.id ?? null
  const version = useMemo(
    () => nextVersion(bundle.documents, kind, loadId),
    [bundle.documents, kind, loadId],
  )
  const filename = kind === 'LOAD_SUMMARY'
    ? loadSummaryFilename(loadNumber, version)
    : generatedFilename('RATE_CON', loadNumber, version)

  // No synchronous setState before the first await; a failed read keeps what we had.
  useEffect(() => {
    let live = true
    Promise.all([
      listUserProfiles().catch(() => [] as UserProfileRecord[]),
      kind === 'LOAD_SUMMARY' && load?.id
        ? listCheckCallsByLoad(load.id).catch(() => [] as LoadCheckCallRecord[])
        : Promise.resolve([] as LoadCheckCallRecord[]),
    ]).then(([p, calls]) => {
      if (!live) return
      setProfiles(p)
      setCheckCalls(calls)
    })
    return () => { live = false }
  }, [kind, load?.id])

  /*
   * The rate confirmation is assembled here rather than reused from `RateConPanel`,
   * whose builder is private to the panel that sends one. A saved copy has to print
   * the same figures the carrier signed, so the assembly is the same: the assignment's
   * own snapshot of the carrier, and this assignment's CARRIER charge lines.
   */
  const rateConInput = (): RateConInput => {
    if (!assignment) throw new Error('A rate confirmation needs the carrier that is currently on the load')
    const charges = rateConChargesFor(bundle.charges, bundle.loadCarriers, assignment)
    const totalCents = charges.reduce((sum, c) => sum + c.amountCents, 0)
    return {
      carrier: {
        name: assignment.carrierName ?? 'Carrier',
        mcNumber: assignment.carrierMc ?? null,
        dotNumber: null,
        phone: assignment.dispatcherPhone ?? null,
      },
      loadCarrier: assignment,
      rep: rateConRepOf(profiles, assignment.carrierRepId, load?.carrierRepId),
      loadNumber,
      equipmentType: load?.equipmentType ?? null,
      commodity: load?.commodity ?? load?.freightDescription ?? null,
      weightLbs: load?.weight ?? null,
      miles: load?.miles ?? null,
      pieces: load?.pieces ?? null,
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
        instructions: [s.apptNote, s.stopNotes].filter(Boolean).join(' - ') || null,
        hours: s.contact?.hours ?? null,
      })),
      charges,
      totalCents,
      notes: joinRateConNotes(
        readExtras(bundle.orders[0])?.instructions?.special,
        readExtras(bundle.orders[0])?.instructions?.rateCon,
      ),
    }
  }

  // Rebuilt whenever what it is built from changes, and the old object URL is released
  // with it — an iframe holding a revoked URL is a blank page, so the revoke happens on
  // the way out rather than the way in.
  useEffect(() => {
    let live = true
    let url: string | null = null

    // Base64 with no data-URI prefix is what SAVE_GENERATED_DOCUMENT expects.
    const build = async (): Promise<{ blob: Blob; base64: string }> => {
      if (kind === 'LOAD_SUMMARY') {
        const doc = await buildLoadSummaryPdf(loadSummaryData(bundle, customer, catalog, checkCalls))
        return { blob: doc.output('blob'), base64: doc.output('datauristring').split('base64,')[1] ?? '' }
      }
      // A saved copy of revision 2+ carries the same REVISED banner and change list the carrier got.
      const input = rateConInput()
      const version = assignment?.rateConVersion ?? 0
      const sent = version >= 2 && assignment ? await getRateConRevision(assignment.id).catch(() => null) : null
      const revision = sent && sent.version >= 2
        ? { number: sent.version, at: assignment?.rateConSentAt ? new Date(assignment.rateConSentAt) : new Date(), changes: sent.snapshot?.changes ?? [] }
        : null
      const bytes = await buildRateConPdf({ ...input, revision })
      return { blob: new Blob([bytes as BlobPart], { type: 'application/pdf' }), base64: rateConPdfBase64(bytes) }
    }

    build()
      .then(({ blob, base64: encoded }) => {
        if (!live) return
        url = URL.createObjectURL(blob)
        setPreviewUrl(url)
        setBase64(encoded)
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
  }, [kind, bundle.documents, profiles, checkCalls, customer, locations, catalog])

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
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open && !saving) onClose() }}
      title={TITLES[kind]}
      className="tms-dialog-xl"
      footer={
        <>
          <p className="mr-auto text-xs tms-muted">
            {version > 1
              ? `Save as v${version} — v${version - 1} becomes superseded`
              : 'Save as v1 — the first version of this document'}
          </p>
          <TmsButton variant="ghost" onClick={onClose} disabled={saving}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={() => { void save() }} disabled={saving || building || !base64}>
            <Save size={14} className="mr-1" />{saving ? 'Saving…' : `Save as v${version}`}
          </TmsButton>
        </>
      }
    >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <TmsBadge tone="gray" className="text-[10px]">{DOCUMENT_TYPE_LABELS[kind]}</TmsBadge>
          <span className="tms-muted">{filename}</span>
          {kind === 'LOAD_SUMMARY' && (
            <TmsBadge tone="gray" className="text-[10px]">Internal — never e-mailed out</TmsBadge>
          )}
        </div>

        <div className="h-[55vh] overflow-hidden rounded-[var(--tms-radius)] border border-[color:var(--tms-border)] bg-[color:var(--tms-card)]">
          {building && (
            <p className="flex h-full items-center justify-center gap-2 text-sm tms-muted">
              <FileText size={14} />Building the document…
            </p>
          )}
          {!building && previewUrl && (
            <iframe src={previewUrl} title={`${DOCUMENT_TYPE_LABELS[kind]} preview`} className="h-full w-full" />
          )}
          {!building && !previewUrl && (
            <p className="flex h-full items-center justify-center text-sm tms-muted">
              Nothing to preview.
            </p>
          )}
        </div>

        {error && <TmsAlert tone="red">{error}</TmsAlert>}


    </TmsDialog>
  )
}
