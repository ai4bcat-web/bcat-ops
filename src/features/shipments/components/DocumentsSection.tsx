/**
 * The Documents tab of a shipment: every file the shipment has, what is still missing
 * before it can be billed, and the four ways a file gets here — staff upload, the
 * carrier's upload link, a PDF generated in the browser, and a pointer at something
 * the driver app already holds.
 *
 * Three rules shape the layout.
 *
 * 1. **The gate is derived, never typed in.** The required-documents strip reads
 *    `useShipmentDocuments`, which runs `evaluateDocGate` — the same pure function the
 *    Lambda runs before it lets an order go Ready to invoice. The tab and the server
 *    therefore cannot disagree about what is missing.
 * 2. **The rate confirmation is one thing in two places.** Its lifecycle lives on
 *    `LoadCarrier` (`rateConStatus`, `rateConKey`, `rateConDocumentId`), so the line in
 *    the Carrier block is derived from the assignment rather than from a document row —
 *    a sent-but-unsigned rate con has no row at all.
 * 3. **Nothing is ever overwritten.** Regenerating mints v2 and leaves v1 SUPERSEDED,
 *    voiding stops a row counting without deleting the file, and a pointer row cannot
 *    be renamed because its bytes belong to another store.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  AlertTriangle, Archive, Ban, Check, ChevronDown, Copy, Download, Eye, FileSignature, FileText, Link2,
  Mail, Pencil, Plus, RotateCw, Send, Smartphone, StopCircle, Upload, Wand2, X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DocumentPreview } from '@/features/documents/DocumentPreview'
import { LoadDriverDocs } from '@/features/loads/LoadDriverDocs'
import {
  attachDriverDoc, getRateConfirmUrl, getShipmentDocumentUrl, getTmsSettings, listDivisions,
  listTrackingLinksByShipment, readyToInvoice, revokeUploadLink, sendUploadLink, updateDocument, voidDocument,
} from '@/lib/apiClient'
import { attachDocs, getDriverDocUrl, type DriverSubmissionRecord } from '@/lib/driverSubmissionsClient'
import { downloadPodAsPdf } from '@/lib/podDownload'
import {
  countsAsPresent, documentSection, DOCUMENT_TYPE_LABELS, isPointerDocument, SHIPMENT_DOCUMENT_TYPES,
} from '@/lib/shipmentDocuments'
import { formatDateTime } from '@/lib/date'
import { useShipmentDocuments } from '@/hooks/useShipmentDocuments'
import { useLoadDriverDocs, type LoadDriverDoc } from '@/hooks/useLoadDriverDocs'
import { UploadDocumentDialog } from './UploadDocumentDialog'
import { GeneratedDocumentDialog, type GeneratedKind } from './GeneratedDocumentDialog'
import { EmailDocumentsDialog } from './EmailDocumentsDialog'
import type {
  ChargeCodeDef, CustomerRecord, DocGateResult, LoadCarrierRecord, LocationRecord, ShipmentBundle,
  ShipmentDocumentAudience, ShipmentDocumentRecord, ShipmentDocumentSource, ShipmentDocumentType, TmsSettings,
  TrackingLinkRecord,
} from '@/types/tms'

const SOURCE_ICONS: Record<ShipmentDocumentSource, typeof FileText> = {
  UPLOAD: Upload,
  CARRIER_PORTAL: Link2,
  GENERATED: Wand2,
  DRIVER_APP: Smartphone,
  LEGACY: Archive,
}

const SOURCE_LABELS: Record<ShipmentDocumentSource, string> = {
  UPLOAD: 'uploaded by staff',
  CARRIER_PORTAL: 'sent by the carrier',
  GENERATED: 'generated here',
  DRIVER_APP: 'from the driver app',
  LEGACY: 'carried over from the old system',
}

const AUDIENCES: readonly ShipmentDocumentAudience[] = ['CUSTOMER', 'CARRIER', 'ALL', 'INTERNAL']

/** What a driver-app document becomes when it is listed on the shipment. */
const ATTACH_AS: Record<'POD' | 'RATECON' | 'MISC', 'POD' | 'PHOTO' | 'OTHER'> = {
  POD: 'POD',
  RATECON: 'OTHER',
  MISC: 'PHOTO',
}

type DocDialog =
  | { kind: 'upload' }
  | { kind: 'generate'; which: GeneratedKind }
  | { kind: 'email' }
  | { kind: 'retype'; doc: ShipmentDocumentRecord }
  | { kind: 'void'; doc: ShipmentDocumentRecord }
  | null

export interface DocumentsSectionProps {
  bundle: ShipmentBundle
  customer: CustomerRecord | null
  locations: LocationRecord[]
  catalog: ChargeCodeDef[]
  currentUser: string
  isAdmin: boolean
  /** Re-read the shipment: a document write re-caches the order's `docsMissing`. */
  onReload: () => Promise<void>
}

export function DocumentsSection({
  bundle, customer, locations, catalog, currentUser, isAdmin, onReload,
}: DocumentsSectionProps) {
  const shipment = bundle.shipment
  const order = bundle.orders[0] ?? null
  const load = bundle.loads[0] ?? null

  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [brokerName, setBrokerName] = useState('BCAT Logistics')
  const [links, setLinks] = useState<TrackingLinkRecord[]>([])
  const [dialog, setDialog] = useState<DocDialog>(null)
  const [preview, setPreview] = useState<{ doc: ShipmentDocumentRecord; url: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const docs = useShipmentDocuments(shipment.id, { bundle, customer, settings })

  const divisionKey = load?.divisionKey ?? null

  // No synchronous setState before the first await; a failed read keeps what we had.
  useEffect(() => {
    let live = true
    Promise.all([getTmsSettings().catch(() => null), listDivisions().catch(() => [])])
      .then(([s, divisions]) => {
        if (!live) return
        setSettings(s)
        const own = divisionKey ? divisions.find((d) => d.key === divisionKey) : divisions[0]
        if (own?.name) setBrokerName(own.name)
      })
    return () => { live = false }
  }, [divisionKey])

  const reloadLinks = useCallback(() => (
    listTrackingLinksByShipment(shipment.id)
      .then((rows) => setLinks(rows))
      .catch(() => { /* the cards simply stay as they were */ })
  ), [shipment.id])

  useEffect(() => { void reloadLinks() }, [reloadLinks])

  /** Every write here can move the gate, so the rows, the links and the order all re-read. */
  const refreshAll = useCallback(async () => {
    await docs.refresh()
    await reloadLinks()
    await onReload()
  }, [docs, reloadLinks, onReload])

  const openPreview = async (doc: ShipmentDocumentRecord) => {
    setPreview({ doc, url: null })
    try {
      // A driver-app pointer's bytes live in the driver store, which is what the POD
      // pages presign; everything else is this shipment's own prefix.
      const url = doc.source === 'DRIVER_APP'
        ? await getDriverDocUrl(doc.s3Key)
        : await getShipmentDocumentUrl(doc.s3Key)
      setPreview((open) => (open && open.doc.id === doc.id ? { doc, url } : open))
    } catch (err) {
      setPreview(null)
      toast.error(err instanceof Error ? err.message : 'Could not open that document')
    }
  }

  const download = async (doc: ShipmentDocumentRecord) => {
    try {
      const url = doc.source === 'DRIVER_APP'
        ? await getDriverDocUrl(doc.s3Key)
        : await getShipmentDocumentUrl(doc.s3Key)
      await downloadPodAsPdf(url, doc.name)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not download that document')
    }
  }

  const customerDocs = docs.documents.filter((d) => documentSection(d) === 'CUSTOMER')
  const shipmentDocs = docs.documents.filter((d) => documentSection(d) === 'SHIPMENT')
  // ACTIVE first: a bounced assignment's paperwork is history, and history collapses.
  const assignments = [...bundle.loadCarriers].sort((a, b) => (
    (a.status === 'ACTIVE' ? 0 : 1) - (b.status === 'ACTIVE' ? 0 : 1)
    || (a.sequence ?? 0) - (b.sequence ?? 0)
  ))

  // Voiding is admin-only unless the org has explicitly opened it up; the Lambda
  // enforces the same rule, so hiding the button only keeps the menu honest.
  const mayVoid = isAdmin || settings?.documentDeleteAdminOnly === false

  const rowActions = {
    onPreview: (doc: ShipmentDocumentRecord) => { void openPreview(doc) },
    onDownload: (doc: ShipmentDocumentRecord) => { void download(doc) },
    onRetype: (doc: ShipmentDocumentRecord) => setDialog({ kind: 'retype', doc }),
    onVoid: mayVoid ? (doc: ShipmentDocumentRecord) => setDialog({ kind: 'void', doc }) : undefined,
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {docs.pendingCount > 0 && (
          <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-700">
            {docs.pendingCount} upload{docs.pendingCount === 1 ? '' : 's'} to review
          </Badge>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setDialog({ kind: 'upload' })}>
            <Plus size={14} className="mr-1" />Upload
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Wand2 size={14} className="mr-1" />Generate <ChevronDown size={14} className="ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setDialog({ kind: 'generate', which: 'BOL' })}>
                <FileText size={14} className="mr-2" />Bill of lading
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog({ kind: 'generate', which: 'LOAD_SUMMARY' })}>
                <FileText size={14} className="mr-2" />Load summary
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog({ kind: 'generate', which: 'RATE_CON' })}>
                <FileSignature size={14} className="mr-2" />Rate confirmation
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" onClick={() => setDialog({ kind: 'email' })}>
            <Mail size={14} className="mr-1" />Send docs
          </Button>
        </div>
      </div>

      {docs.error && (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-2 text-xs">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />{docs.error}
        </p>
      )}
      {error && (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}
        </p>
      )}

      {order && (
        <RequiredStrip
          gate={docs.orderGates[order.id]}
          documents={docs.documents}
          arStatus={order.arStatus ?? null}
          isAdmin={isAdmin}
          onReady={async (override, note) => {
            setError(null)
            try {
              await readyToInvoice({
                orderId: order.id,
                expectedUpdatedAt: order.updatedAt,
                override: override || undefined,
                overrideNote: override ? note : undefined,
              })
              await refreshAll()
              toast.success('Ready to invoice')
            } catch (err) {
              // The Lambda's message lists the documents that are missing, which is
              // exactly what the user needs to read.
              setError(err instanceof Error ? err.message : 'The order could not be moved to Ready to invoice')
            }
          }}
        />
      )}

      <Section title="Customer" count={customerDocs.length}>
        {customerDocs.map((doc) => (
          <DocumentRow key={doc.id} doc={doc} {...rowActions} />
        ))}
      </Section>

      <div className="space-y-3" data-testid="documents-carrier">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Carrier</p>
        {assignments.length === 0 && (
          <p className="text-sm text-muted-foreground">Nobody is on this load yet.</p>
        )}
        {assignments.map((assignment) => (
          <CarrierBlock
            key={assignment.id}
            assignment={assignment}
            documents={docs.documents.filter((d) => d.loadCarrierId === assignment.id)}
            gate={docs.carrierGates[assignment.id]}
            link={links.find((l) => (
              l.kind === 'CARRIER_UPLOAD' && l.loadCarrierId === assignment.id && l.status === 'ACTIVE'
            )) ?? null}
            deliveredAt={bundle.loads.find((l) => l.id === assignment.loadId)?.deliveredAt ?? null}
            rowActions={rowActions}
            onChanged={refreshAll}
          />
        ))}
      </div>

      <Section title="Shipment" count={shipmentDocs.length}>
        {shipmentDocs.map((doc) => (
          <DocumentRow key={doc.id} doc={doc} {...rowActions} />
        ))}
      </Section>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">From the driver app</p>
        <LoadDriverDocs loadId={load?.id} proNumber={load?.aljexId} kind="RATECON" />
        <LoadDriverDocs loadId={load?.id} proNumber={load?.aljexId} kind="POD" />
        <LoadDriverDocs loadId={load?.id} proNumber={load?.aljexId} kind="MISC" />
        {load && (
          <DriverDocAttachments
            shipmentId={shipment.id}
            loadId={load.id}
            proNumber={load.aljexId}
            documents={docs.documents}
            onAttached={refreshAll}
          />
        )}
      </div>

      {dialog?.kind === 'upload' && (
        <UploadDocumentDialog
          bundle={bundle}
          onClose={() => setDialog(null)}
          onSaved={() => { void refreshAll() }}
        />
      )}
      {dialog?.kind === 'generate' && (
        <GeneratedDocumentDialog
          kind={dialog.which}
          bundle={bundle}
          customer={customer}
          locations={locations}
          catalog={catalog}
          onClose={() => setDialog(null)}
          onSaved={() => { void refreshAll() }}
        />
      )}
      {dialog?.kind === 'email' && (
        <EmailDocumentsDialog
          bundle={bundle}
          customer={customer}
          documents={docs.documents}
          brokerName={brokerName}
          senderName={currentUser}
          onClose={() => setDialog(null)}
          onSent={() => { void refreshAll() }}
        />
      )}
      {dialog?.kind === 'retype' && (
        <RetypeDialog
          doc={dialog.doc}
          onClose={() => setDialog(null)}
          onSaved={() => { void refreshAll() }}
        />
      )}
      {dialog?.kind === 'void' && (
        <VoidDialog
          doc={dialog.doc}
          onClose={() => setDialog(null)}
          onVoided={() => { void refreshAll() }}
        />
      )}

      {preview && (
        <DocumentPreview
          open
          onClose={() => setPreview(null)}
          title={`${DOCUMENT_TYPE_LABELS[preview.doc.type]} · ${preview.doc.name}`}
          subtitle={`v${preview.doc.version} · ${SOURCE_LABELS[preview.doc.source]} · ${preview.doc.uploadedBy}`}
          url={preview.url}
          contentType={preview.doc.contentType}
          downloadName={preview.doc.name}
        />
      )}
    </div>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div className="space-y-2" data-testid={`documents-${title.toLowerCase()}`}>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title} <span className="font-normal normal-case tracking-normal">({count})</span>
      </p>
      {count === 0 ? <p className="text-sm text-muted-foreground">Nothing here yet.</p> : children}
    </div>
  )
}

/**
 * What the order still owes before it can be billed, and the button that says so.
 *
 * A free-text entry nobody could map to a type is shown as what it is: an instruction
 * that cannot be checked automatically. It never blocks, because refusing to invoice
 * over a string nobody can evaluate would be worse than the risk it describes.
 */
function RequiredStrip({ gate, documents, arStatus, isAdmin, onReady }: {
  gate: DocGateResult | undefined
  documents: ShipmentDocumentRecord[]
  arStatus: string | null
  isAdmin: boolean
  onReady: (override: boolean, note: string) => Promise<void>
}) {
  const [overriding, setOverriding] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  if (!gate) return null

  const run = async (override: boolean) => {
    setBusy(true)
    try {
      await onReady(override, note.trim())
      setOverriding(false)
      setNote('')
    } finally {
      setBusy(false)
    }
  }

  const satisfiedBy = (type: ShipmentDocumentType) =>
    documents.find((d) => d.type === type && countsAsPresent(d))?.name ?? null

  return (
    <div className="space-y-2 rounded-lg border border-border p-3" data-testid="required-documents">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Required documents</p>
        {arStatus && <Badge variant="outline" className="text-[10px]">AR {arStatus.replace(/_/g, ' ').toLowerCase()}</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {isAdmin && !gate.ready && (
            <Button variant="outline" size="sm" onClick={() => setOverriding((on) => !on)} disabled={busy}>
              Override with note
            </Button>
          )}
          <Button
            size="sm"
            disabled={!gate.ready || busy}
            title={gate.ready ? undefined : `Missing: ${gate.missing.map((t) => DOCUMENT_TYPE_LABELS[t]).join(', ')}`}
            onClick={() => { void run(false) }}
          >
            {busy ? 'Working…' : 'Ready to invoice'}
          </Button>
        </div>
      </div>

      {gate.required.length === 0 && (
        <p className="text-sm text-muted-foreground">
          This customer asks for no documents before invoicing.
        </p>
      )}
      <ul className="space-y-1">
        {gate.required.map((type) => {
          const present = gate.present.includes(type)
          const name = present ? satisfiedBy(type) : null
          return (
            <li key={type} className="flex items-center gap-2 text-sm">
              {present
                ? <Check size={14} className="shrink-0 text-emerald-600" />
                : <X size={14} className="shrink-0 text-destructive" />}
              <span className={present ? '' : 'font-medium'}>{DOCUMENT_TYPE_LABELS[type]}</span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {present ? name ?? 'on file' : 'missing'}
              </span>
            </li>
          )
        })}
      </ul>

      {gate.unrecognised.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {gate.unrecognised.map((text) => (
            <Badge key={text} variant="outline" className="text-[10px]" title="Cannot be checked automatically">
              {text} — cannot be checked automatically
            </Badge>
          ))}
        </div>
      )}

      {!gate.ready && (
        <p className="text-xs text-muted-foreground">
          {gate.missing.length} still missing: {gate.missing.map((t) => DOCUMENT_TYPE_LABELS[t]).join(', ')}
        </p>
      )}

      {overriding && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Why bill without it</Label>
          <Textarea
            aria-label="Override note"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="text-sm"
          />
          <Button size="sm" disabled={busy || note.trim().length === 0} onClick={() => { void run(true) }}>
            {busy ? 'Working…' : 'Bill it anyway'}
          </Button>
        </div>
      )}
    </div>
  )
}

interface RowActions {
  onPreview: (doc: ShipmentDocumentRecord) => void
  onDownload: (doc: ShipmentDocumentRecord) => void
  onRetype: (doc: ShipmentDocumentRecord) => void
  onVoid?: (doc: ShipmentDocumentRecord) => void
}

function DocumentRow({ doc, onPreview, onDownload, onRetype, onVoid }: { doc: ShipmentDocumentRecord } & RowActions) {
  const SourceIcon = SOURCE_ICONS[doc.source]
  const pending = doc.reviewStatus === 'PENDING'
  const rejected = doc.reviewStatus === 'REJECTED'
  const spent = doc.status === 'SUPERSEDED' || doc.status === 'VOID'

  const tone = pending
    ? 'border-amber-500/40 bg-amber-500/5'
    : rejected
      ? 'border-destructive/40 bg-destructive/5'
      : spent
        ? 'border-border bg-muted/30 text-muted-foreground'
        : 'border-border'

  return (
    <div className={`flex flex-wrap items-center gap-2 rounded-lg border p-2 text-sm ${tone}`}>
      <Badge variant="outline" className="text-[10px]">{DOCUMENT_TYPE_LABELS[doc.type]}</Badge>
      <span className={`min-w-0 flex-1 truncate ${spent ? 'line-through' : ''}`}>{doc.name}</span>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">v{doc.version}</span>
      <SourceIcon size={13} className="text-muted-foreground" aria-label={SOURCE_LABELS[doc.source]} />
      <Badge variant="outline" className="text-[10px]">{doc.audience.toLowerCase()}</Badge>
      <span className="text-[11px] text-muted-foreground">
        {doc.uploadedBy} · {formatDateTime(doc.uploadedAt)}
        {pending ? ' · waiting on review' : ''}
        {rejected ? ` · rejected${doc.reviewNote ? ` — ${doc.reviewNote}` : ''}` : ''}
        {doc.status === 'SUPERSEDED' ? ' · superseded' : ''}
        {doc.status === 'VOID' ? ` · void${doc.voidReason ? ` — ${doc.voidReason}` : ''}` : ''}
      </span>
      <div className="flex flex-wrap gap-1">
        <Button variant="outline" size="sm" className="h-7" onClick={() => onPreview(doc)}>
          <Eye size={13} className="mr-1" />Preview
        </Button>
        <Button variant="outline" size="sm" className="h-7" onClick={() => onDownload(doc)}>
          <Download size={13} className="mr-1" />Download
        </Button>
        <Button
          variant="outline" size="sm" className="h-7"
          disabled={isPointerDocument(doc) || doc.status !== 'ACTIVE'}
          title={isPointerDocument(doc) ? 'This row points at a file in another store; rename it there.' : undefined}
          onClick={() => onRetype(doc)}
        >
          <Pencil size={13} className="mr-1" />Retype
        </Button>
        {onVoid && doc.status === 'ACTIVE' && (
          <Button variant="outline" size="sm" className="h-7" onClick={() => onVoid(doc)}>
            <Ban size={13} className="mr-1" />Void
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * One assignment's paperwork. The rate confirmation line comes off the assignment, not
 * off a document row: a rate con that was sent and never signed has a status and no
 * file, and a signed one has its own key on `LoadCarrier`.
 */
function CarrierBlock({ assignment, documents, gate, link, deliveredAt, rowActions, onChanged }: {
  assignment: LoadCarrierRecord
  documents: ShipmentDocumentRecord[]
  gate: DocGateResult | undefined
  link: TrackingLinkRecord | null
  deliveredAt: string | null
  rowActions: RowActions
  onChanged: () => Promise<void>
}) {
  const active = assignment.status === 'ACTIVE'
  const [open, setOpen] = useState(active)

  const name = assignment.kind === 'OWN_ASSET'
    ? assignment.driverName ?? 'Own asset'
    : assignment.carrierName ?? 'Carrier'

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <button
        type="button"
        onClick={() => setOpen((on) => !on)}
        className="flex w-full flex-wrap items-center gap-2 text-left"
      >
        <span className="text-sm font-medium">{name}</span>
        <Badge variant="outline" className="text-[10px]">{assignment.status.toLowerCase()}</Badge>
        {assignment.kind === 'OWN_ASSET' && <Badge variant="outline" className="text-[10px]">own asset</Badge>}
        <span className="text-xs text-muted-foreground">
          {documents.length} document{documents.length === 1 ? '' : 's'}
          {gate && gate.missing.length > 0 ? ` · ${gate.missing.length} outstanding` : ''}
        </span>
        <ChevronDown size={14} className={`ml-auto text-muted-foreground ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <RateConLine assignment={assignment} />
          {documents.map((doc) => (
            <DocumentRow key={doc.id} doc={doc} {...rowActions} />
          ))}
          {documents.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing from this carrier yet.</p>
          )}
          {gate && gate.missing.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Still wanted: {gate.missing.map((t) => DOCUMENT_TYPE_LABELS[t]).join(', ')}
            </p>
          )}
          {active && assignment.kind !== 'OWN_ASSET' && (
            <UploadLinkCard
              assignment={assignment}
              link={link}
              deliveredAt={deliveredAt}
              onChanged={onChanged}
            />
          )}
        </>
      )}
    </div>
  )
}

/** The rate confirmation as `LoadCarrier` records it, with its signed copy when there is one. */
function RateConLine({ assignment }: { assignment: LoadCarrierRecord }) {
  const status = assignment.rateConStatus ?? 'NOT_SENT'
  const key = assignment.rateConKey ?? null

  const open = async () => {
    if (!key) return
    try {
      window.open(await getRateConfirmUrl(key), '_blank', 'noopener')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open the rate confirmation')
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-sm">
      <Badge variant="outline" className="text-[10px]">Rate confirmation</Badge>
      <span className="min-w-0 flex-1 truncate">
        {status.replace(/_/g, ' ').toLowerCase()}
        {assignment.rateConVersion ? ` · v${assignment.rateConVersion}` : ''}
        {assignment.rateConSignedAt ? ` · signed ${formatDateTime(assignment.rateConSignedAt)}` : ''}
      </span>
      {assignment.rateConDocumentId && (
        <Badge variant="outline" className="text-[10px]">saved on the shipment</Badge>
      )}
      <Button variant="outline" size="sm" className="h-7" disabled={!key} onClick={() => { void open() }}>
        <Eye size={13} className="mr-1" />{key ? 'Open' : 'No file yet'}
      </Button>
    </div>
  )
}

/**
 * The carrier's upload link: one stable token per assignment, mailed as often as
 * needed. `NOT_SENT` is the normal answer on a stack where SES is denied, and the card
 * says so and hands over the link rather than claiming an e-mail went out.
 */
function UploadLinkCard({ assignment, link, deliveredAt, onChanged }: {
  assignment: LoadCarrierRecord
  link: TrackingLinkRecord | null
  deliveredAt: string | null
  onChanged: () => Promise<void>
}) {
  const [to, setTo] = useState(assignment.dispatcherEmail ?? '')
  const [url, setUrl] = useState<string | null>(null)
  const [notSent, setNotSent] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The portal is a public page keyed by the token, so the link is the token.
  const liveUrl = url ?? (link ? `${window.location.origin}/track/u/${link.id}` : null)

  const send = async (via: 'EMAIL' | 'COPY', regenerate = false) => {
    setBusy(true)
    setError(null)
    setNotSent(null)
    try {
      const answer = await sendUploadLink({
        loadCarrierId: assignment.id,
        to: via === 'EMAIL' ? to.split(',').map((e) => e.trim()).filter(Boolean) : undefined,
        via,
        // Before delivery the Lambda refuses unless we say we mean it.
        early: !deliveredAt || undefined,
        regenerate: regenerate || undefined,
      })
      setUrl(answer.url)
      if (answer.emailStatus === 'SENT') toast.success(`Upload link sent to ${answer.link.sentTo ?? to}`)
      else setNotSent(answer.emailError ?? 'Nothing was e-mailed — the link below is live.')
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The upload link could not be sent')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async () => {
    if (!link) return
    setBusy(true)
    setError(null)
    try {
      await revokeUploadLink({ trackingLinkId: link.id })
      setUrl(null)
      toast.success('Upload link revoked')
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The link could not be revoked')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-2" data-testid="carrier-upload-link">
      <div className="flex flex-wrap items-center gap-2">
        <Link2 size={14} className="text-muted-foreground" />
        <p className="text-sm font-medium">Carrier upload link</p>
        {link ? (
          <Badge variant="outline" className="text-[10px]">{link.status.toLowerCase()}</Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]">not sent</Badge>
        )}
      </div>
      {link && (
        <p className="text-xs text-muted-foreground">
          {link.sentTo ? `Sent to ${link.sentTo}` : 'Not e-mailed yet'}
          {' · '}opened {link.openCount ?? 0}×
          {' · '}{link.uploadCount ?? 0} upload{(link.uploadCount ?? 0) === 1 ? '' : 's'}
          {' · '}expires {formatDateTime(link.expiresAt)}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Dispatcher e-mail</Label>
          <Input
            aria-label="Upload link recipient"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-9 text-sm"
          />
        </div>
        <Button size="sm" disabled={busy || !to.trim()} onClick={() => { void send('EMAIL') }}>
          <Send size={13} className="mr-1" />{busy ? 'Working…' : 'Send'}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { void send('COPY') }}>
          <Copy size={13} className="mr-1" />Copy
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { void send('EMAIL', true) }}>
          <RotateCw size={13} className="mr-1" />Regenerate
        </Button>
        {link && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void revoke() }}>
            <StopCircle size={13} className="mr-1" />Revoke
          </Button>
        )}
      </div>

      {notSent && (
        <p className="flex items-start gap-2 text-xs">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
          {notSent} Send it by hand with the Copy button.
        </p>
      )}
      {liveUrl && (
        <div className="flex items-center gap-2">
          <Input aria-label="Upload link URL" readOnly value={liveUrl} className="h-9 text-xs" />
          <Button
            type="button" variant="outline" size="sm"
            onClick={() => { void navigator.clipboard?.writeText(liveUrl); toast.success('Link copied') }}
          >
            <Copy size={14} className="mr-1" />Copy
          </Button>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/**
 * Attach what the driver sent to the shipment's own index.
 *
 * The bytes are never copied: the row points at the driver store's key. A merged
 * document is synthesised by `useLoadDriverDocs` from the submission's pages and
 * carries a composite id, so the real `DriverSubmissionDoc` id is looked up at the
 * moment of attaching — the Lambda resolves the merged PDF from whichever page it is
 * given.
 */
function DriverDocAttachments({ shipmentId, loadId, proNumber, documents, onAttached }: {
  shipmentId: string
  loadId: string
  proNumber: string | null | undefined
  documents: ShipmentDocumentRecord[]
  onAttached: () => Promise<void>
}) {
  const { pods, ratecons, misc } = useLoadDriverDocs(loadId, proNumber)
  const [busy, setBusy] = useState<string | null>(null)

  const rows: { doc: LoadDriverDoc; kind: 'POD' | 'RATECON' | 'MISC' }[] = [
    ...pods.map((doc) => ({ doc, kind: 'POD' as const })),
    ...ratecons.map((doc) => ({ doc, kind: 'RATECON' as const })),
    ...misc.map((doc) => ({ doc, kind: 'MISC' as const })),
  ]
  if (rows.length === 0) return null

  const attach = async (doc: LoadDriverDoc, kind: 'POD' | 'RATECON' | 'MISC') => {
    setBusy(doc.id)
    try {
      let submissionDocId = doc.id
      if (doc.pageNumber === null) {
        // A merged row: find the newest real page of the same kind on that submission.
        const [withDocs] = await attachDocs([{ id: doc.submissionId } as DriverSubmissionRecord], 1000)
        const page = (withDocs?.docs ?? [])
          .filter((d) => d.kind === doc.kind)
          .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))[0]
        if (!page) throw new Error('Could not find the page behind that document')
        submissionDocId = page.id
      }
      await attachDriverDoc({ shipmentId, loadId, submissionDocId, type: ATTACH_AS[kind] })
      await onAttached()
      toast.success('Listed on the shipment')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not attach that document')
    } finally {
      setBusy(null)
    }
  }

  return (
    <ul className="space-y-1">
      {rows.map(({ doc, kind }) => {
        // A pointer row carries the driver store's key, so the key is what says whether
        // this file is already listed — whichever copy the merge settled on.
        const attached = documents.some((d) => d.source === 'DRIVER_APP' && d.s3Key === doc.s3Key)
        return (
          <li key={doc.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-sm">
            <Smartphone size={13} className="text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{doc.fileName?.trim() || `${doc.kind} page ${doc.pageNumber ?? 1}`}</span>
            <span className="text-[11px] text-muted-foreground">{doc.driverName}</span>
            {attached ? (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Check size={13} className="text-emerald-600" />on the shipment
              </span>
            ) : (
              <Button
                variant="outline" size="sm" className="h-7"
                disabled={busy !== null}
                onClick={() => { void attach(doc, kind) }}
              >
                <Plus size={13} className="mr-1" />{busy === doc.id ? 'Attaching…' : 'Attach to shipment'}
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** Rename or retype a row whose bytes this system owns. */
function RetypeDialog({ doc, onClose, onSaved }: {
  doc: ShipmentDocumentRecord
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(doc.name)
  const [type, setType] = useState<ShipmentDocumentType>(doc.type)
  const [audience, setAudience] = useState<ShipmentDocumentAudience>(doc.audience)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await updateDocument({ documentId: doc.id, name: name.trim(), type, audience })
      toast.success('Document updated')
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The document could not be updated')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Rename or retype</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Name</Label>
            <Input aria-label="Document name" value={name} onChange={(e) => setName(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Type</Label>
            <select
              aria-label="Document type"
              value={type}
              onChange={(e) => setType(e.target.value as ShipmentDocumentType)}
              disabled={busy}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {SHIPMENT_DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>{DOCUMENT_TYPE_LABELS[t]}</option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Who may receive it</Label>
            <select
              aria-label="Document audience"
              value={audience}
              onChange={(e) => setAudience(e.target.value as ShipmentDocumentAudience)}
              disabled={busy}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {AUDIENCES.map((a) => (
                <option key={a} value={a}>{a.toLowerCase()}</option>
              ))}
            </select>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => { void save() }} disabled={busy || name.trim().length === 0}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Voiding keeps the file and stops the row counting; the reason is the record of why. */
function VoidDialog({ doc, onClose, onVoided }: {
  doc: ShipmentDocumentRecord
  onClose: () => void
  onVoided: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      await voidDocument({ documentId: doc.id, reason: reason.trim() })
      toast.success('Document voided')
      onVoided()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The document could not be voided')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Void {doc.name}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          The file stays where it is. The row stops counting towards anything and shows as void.
        </p>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Reason</Label>
          <Textarea
            aria-label="Void reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="text-sm"
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => { void run() }} disabled={busy || reason.trim().length === 0}>
            {busy ? 'Voiding…' : 'Void it'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
