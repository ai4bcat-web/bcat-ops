/**
 * Card 9: Documents (Step AR). Upload drop zone + picker, Public / Private tabs, the list with
 * type / name / uploaded by-when / preview, and an informational "Required for release"
 * checklist. Works before the shipment exists: files are queued in `values.docs.queued` (held in
 * memory for the session; the browser draft stores no file bytes, so a reload drops them) and
 * written as ShipmentDocument by `runUploadQueued` right after Create.
 *
 * Ryne 2026-11-14: the POD and the rate confirmation each get their own box (upload + every file of
 * that type), and everything else sits under "Other documents" with a type picker. A saved file's
 * type can be changed after upload (UPDATE_DOCUMENT, which re-reads the release gate) and a file can
 * be deleted (VOID_DOCUMENT: the row goes VOID, the bytes stay). A file dropped in the generic area
 * takes the type its name points at ("POD 14657.pdf", "RateConf_…"), and the picker can still change it.
 */
import { Field } from '../fieldGrid'
import { memo, useEffect, useRef, useState, type DragEvent } from 'react'
import { Check, Circle, Eye, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsIconButton, TmsSelect, TmsTabs } from '@/features/tms/kit'
import { DocumentPreview } from '@/features/documents/DocumentPreview'
import { attachIntakeFiles, getIntakeLoad, getShipmentDocumentUrl, updateDocument, voidDocument } from '@/lib/apiClient'
import { formatBoardDateTime } from '@/lib/date'
import {
  ACCEPTED_CONTENT_TYPES, DOCUMENT_TYPE_LABELS, MAX_DOCUMENT_BYTES, SHIPMENT_DOCUMENT_TYPES, SLOT_DOCUMENT_TYPES,
  isPointerDocument, suggestDocumentType,
} from '@/lib/shipmentDocuments'
import type { ShipmentDocumentAudience, ShipmentDocumentRecord, ShipmentDocumentType } from '@/types/tms'
import { LABEL } from '../labels'
import { isLocked } from '../model'
import { fieldAttrs } from '../sections/fieldAttrs'
import type { CardProps } from './cardRegistry'
import { GenerateRow } from './GenerateRow'
import { releaseDocItems } from './releaseDocs'
import { LoadRequiredDocs } from './LoadRequiredDocs'
import './trackDocsCards.css'

type Tab = 'public' | 'private'
const PUBLIC_AUDIENCES: readonly ShipmentDocumentAudience[] = ['CUSTOMER', 'CARRIER', 'ALL']

function fileProblem(file: File): string | null {
  if (!(ACCEPTED_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return `${file.name} is a ${file.type || 'file of unknown type'}. Documents must be a PDF, a PNG or a JPEG.`
  }
  if (file.size === 0) return `${file.name} is empty.`
  if (file.size > MAX_DOCUMENT_BYTES) return `${file.name} is over ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB.`
  return null
}

/** What the preview dialog is showing: a saved document (its signed link is fetched) or a queued file (a local link). */
interface Viewing { title: string; subtitle?: string; name: string; contentType: string; url: string | null; local: boolean }

/** Interface for the two calls a saved row makes; injected so the card can be tested without the API. */
export interface DocumentEditApi {
  retype: (documentId: string, type: ShipmentDocumentType) => Promise<unknown>
  remove: (documentId: string) => Promise<unknown>
}
const liveDocumentApi: DocumentEditApi = {
  retype: (documentId, type) => updateDocument({ documentId, type }),
  remove: (documentId) => voidDocument({ documentId, reason: 'Deleted from shipment documents' }),
}

/** A saved file's type picker and delete (with an inline confirm: the viewer blocks confirm()). */
function DocActions({ doc, disabled, api, onChanged, show = 'both' }: {
  doc: ShipmentDocumentRecord
  disabled: boolean
  api: DocumentEditApi
  onChanged: () => Promise<void> | void
  /** The table puts the picker in its Type column and delete beside preview. */
  show?: 'both' | 'type' | 'delete'
}) {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // Driver-app / legacy pointers are retyped where they live; a generated file's type describes what was rendered.
  const fixedType = isPointerDocument(doc) || doc.source === 'GENERATED'
  const off = disabled || busy || doc.status !== 'ACTIVE'
  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await work()
      toast.success(done)
      await onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save that change')
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }
  return (
    <span className="tms-card-docs-actions" data-testid={`card-documents-actions-${doc.id}`}>
      {fixedType || show === 'delete' ? null : (
        <TmsSelect
          aria-label={`Type of ${doc.name}`}
          data-testid={`card-documents-type-${doc.id}`}
          value={doc.type}
          disabled={off}
          onChange={(e) => {
            const next = e.target.value as ShipmentDocumentType
            if (next !== doc.type) void run(() => api.retype(doc.id, next), `Saved as ${DOCUMENT_TYPE_LABELS[next] ?? next}`)
          }}
          options={SHIPMENT_DOCUMENT_TYPES.map((t) => ({ value: t, label: DOCUMENT_TYPE_LABELS[t] ?? t }))}
        />
      )}
      {show === 'type' ? null : confirming ? (
        <>
          <TmsButton size="sm" variant="destructive" disabled={off} data-testid={`card-documents-delete-confirm-${doc.id}`}
            onClick={() => void run(() => api.remove(doc.id), `Deleted ${doc.name}`)}>Delete</TmsButton>
          <TmsButton size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Keep</TmsButton>
        </>
      ) : (
        <TmsIconButton shape="plain" aria-label={`Delete ${doc.name}`} title="Delete" disabled={off}
          data-testid={`card-documents-delete-${doc.id}`} onClick={() => setConfirming(true)}>
          <Trash2 size={14} />
        </TmsIconButton>
      )}
    </span>
  )
}

function DocumentsCardImpl({ values, ctx, documentApi = liveDocumentApi }: CardProps & { documentApi?: DocumentEditApi }) {
  const [tab, setTab] = useState<Tab>('public')
  const [type, setType] = useState<ShipmentDocumentType>('OTHER')
  const [problem, setProblem] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [over, setOver] = useState(false)
  const [showOld, setShowOld] = useState(false)
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const input = useRef<HTMLInputElement>(null)
  // The e-mail this shipment was built from may hold a rate confirmation PDF that never reached the shipment's Documents (it arrived
  // after the build, or the build went another way): offer to file it.
  const tiedIntakeId = ctx.bundle?.shipment.intakeLoadId ?? null
  const [intakePdfs, setIntakePdfs] = useState(0)
  useEffect(() => {
    if (!tiedIntakeId) return undefined
    let live = true
    getIntakeLoad(tiedIntakeId)
      .then((row) => { if (live) setIntakePdfs((row?.attachments ?? []).filter((a) => /^(application\/pdf|image\/)/.test(a.contentType)).length) })
      .catch(() => undefined)
    return () => { live = false }
  }, [tiedIntakeId])

  const saved = ctx.mode === 'edit' && ctx.bundle != null
  const audience: 'ALL' | 'INTERNAL' = tab === 'public' ? 'ALL' : 'INTERNAL'
  const disabled = ctx.busy || working || isLocked(ctx.locked, 'all')
  const queuedAll = values.docs.queued
  const all = ctx.bundle?.documents ?? []
  const hasOld = all.some((d) => d.status === 'SUPERSEDED')
  const active = all.filter((d) => d.status === 'ACTIVE' || (showOld && d.status === 'SUPERSEDED'))
  const shown = active.filter((d) => !SLOT_DOCUMENT_TYPES.includes(d.type) && (tab === 'public' ? PUBLIC_AUDIENCES.includes(d.audience) : d.audience === 'INTERNAL'))
  const queued = queuedAll
    .map((q, index) => ({ q, index }))
    .filter(({ q }) => !SLOT_DOCUMENT_TYPES.includes(q.type) && (tab === 'public' ? q.audience === 'ALL' : q.audience === 'INTERNAL'))

  // The two documents everybody looks for get their own slot: on file (with where it came from) or an upload button.
  // Every file of that type is listed in its box (any audience: a private rate con is still the rate con).
  const slotDocs = (docType: ShipmentDocumentType) => active.filter((d) => d.type === docType)
  const slotQueued = (docType: ShipmentDocumentType) => queuedAll.map((q, index) => ({ q, index })).filter(({ q }) => q.type === docType)
  const editDisabled = disabled || !saved
  const changed = () => ctx.refreshBundle()
  const slotOrigin = (d: { uploadedBy?: string | null; source?: string | null }): string => {
    const by = d.uploadedBy ?? ''
    if (by.startsWith('link:')) return 'e-signed by the carrier'
    if (by.toLowerCase().includes('driver')) return 'from the driver'
    if (d.source === 'GENERATED') return 'generated'
    return 'uploaded'
  }
  const slotInputs = useRef<Record<string, HTMLInputElement | null>>({})
  // The board's Missing chip opens /edit#docs-POD (or #docs-RATE_CON): scroll that box into view and focus its upload.
  useEffect(() => {
    const m = /^#docs-(POD|RATE_CON)$/.exec(typeof window === 'undefined' ? '' : window.location.hash)
    if (!m) return
    const box = document.getElementById(`docs-${m[1]}`)
    box?.scrollIntoView?.({ block: 'center' })
    box?.querySelector<HTMLButtonElement>(`[data-testid="card-documents-slot-${m[1]}-upload"]`)?.focus()
  }, [])

  const emailPdfMissing = !!tiedIntakeId && intakePdfs > 0 && !all.some((d) => d.id.startsWith(`intake-${tiedIntakeId}-`))
  const fileEmailPdf = async () => {
    if (!tiedIntakeId || !ctx.bundle) return
    setWorking(true)
    try {
      const r = await attachIntakeFiles({ intakeId: tiedIntakeId, shipmentId: ctx.bundle.shipment.id })
      toast.success(r.attached > 0 ? 'Added the e-mail\'s rate confirmation' : 'Nothing new to add')
      await ctx.refreshBundle()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add the e-mail\'s rate confirmation')
    } finally {
      setWorking(false)
    }
  }
  // Opening a shipment whose e-mail PDF is missing files it by itself (once); the button stays as the retry if that fails.
  const autoTried = useRef<string | null>(null)
  useEffect(() => {
    if (!emailPdfMissing || !tiedIntakeId || autoTried.current === tiedIntakeId || ctx.busy) return
    autoTried.current = tiedIntakeId
    void fileEmailPdf()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailPdfMissing, tiedIntakeId, ctx.busy])
  const checklist = releaseDocItems({ customer: ctx.customer, settings: ctx.settings, bundle: ctx.bundle, queued: queuedAll })

  /** Open a saved document in the page's own preview (not a new tab); its signed link arrives a moment later. */
  const preview = async (doc: { name: string; s3Key: string; contentType?: string | null; type: ShipmentDocumentType; version?: number | null; uploadedBy?: string | null }) => {
    const label = DOCUMENT_TYPE_LABELS[doc.type] ?? doc.type
    setViewing({ title: `${label} · ${doc.name}`, subtitle: [doc.version ? `v${doc.version}` : null, doc.uploadedBy].filter(Boolean).join(' · ') || undefined, name: doc.name, contentType: doc.contentType ?? 'application/pdf', url: null, local: false })
    try {
      const url = await getShipmentDocumentUrl(doc.s3Key)
      setViewing((open) => (open && open.name === doc.name && open.url === null ? { ...open, url } : open))
    } catch (err) {
      setViewing(null)
      toast.error(err instanceof Error ? err.message : 'Could not open that document')
    }
  }
  const previewQueued = (file: File, docType: ShipmentDocumentType) => {
    setViewing({ title: `${DOCUMENT_TYPE_LABELS[docType] ?? docType} · ${file.name}`, subtitle: 'Will upload when the shipment is created', name: file.name, contentType: file.type || 'application/pdf', url: URL.createObjectURL(file), local: true })
  }
  const closePreview = () => {
    if (viewing?.local && viewing.url) URL.revokeObjectURL(viewing.url)
    setViewing(null)
  }

  const take = async (files: FileList | File[] | null, asType?: ShipmentDocumentType, asAudience: 'ALL' | 'INTERNAL' = audience) => {
    const list = Array.from(files ?? [])
    if (list.length === 0) return
    setProblem(null)
    setWorking(true)
    try {
      for (const file of list) {
        const bad = fileProblem(file)
        if (bad) { setProblem(bad); continue }
        // A slot upload carries its type; the generic area uses the picked type unless the name says POD or rate con.
        const fileType = asType ?? (type === 'OTHER' ? suggestDocumentType(file.name) ?? type : type)
        if (!saved) ctx.actions.queueDocument(file, asAudience, fileType)
        else await ctx.actions.uploadDocument(file, asAudience, fileType)
      }
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'The upload failed')
    } finally {
      setWorking(false)
      if (input.current) input.current.value = ''
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    if (!disabled) void take(e.dataTransfer.files)
  }

  return (
    <div className="tms-card-body-stack" data-testid="card-documents-body">
      <GenerateRow ctx={ctx} />
      <div className="tms-card-docslots" data-testid="card-documents-slots">
        {([['POD', 'Proof of delivery (POD)', 'Fills in by itself when a driver uploads it in the app or the tracking agent files it.'], ['RATE_CON', 'Rate confirmation', 'Fills in by itself when the carrier e-signs it or it arrives from an intake e-mail.']] as const).map(([docType, label, hint]) => {
          const docs = slotDocs(docType)
          const queuedDocs = slotQueued(docType)
          const onFile = docs.some((d) => d.status === 'ACTIVE')
          return (
            <div key={docType} id={`docs-${docType}`} className="tms-card-docslot" data-testid={`card-documents-slot-${docType}`} data-on-file={onFile ? 'true' : 'false'}>
              <div className="tms-card-docslot-head">
                {onFile ? <Check size={14} aria-hidden /> : <Circle size={14} aria-hidden />}
                <strong>{label}</strong>
                <span className="tms-muted text-xs">{onFile ? 'On file' : queuedDocs.length > 0 ? 'Queued' : 'Missing'}</span>
              </div>
              {docs.length === 0 && queuedDocs.length === 0 ? <p className="tms-muted text-xs">{hint}</p> : null}
              {docs.length > 0 ? (
                <ul className="tms-card-docslot-list" data-testid={`card-documents-slot-${docType}-list`}>
                  {docs.map((doc) => (
                    <li key={doc.id} className="text-xs" data-testid="card-documents-slot-row">
                      <span>
                        <button type="button" className="tms-link" onClick={() => void preview(doc)}>{doc.name}</button>
                        <span className="tms-muted">{` · ${slotOrigin(doc)} · ${formatBoardDateTime(doc.uploadedAt)}`}</span>
                        {doc.status === 'SUPERSEDED' && <span className="tms-muted"> superseded</span>}
                      </span>
                      <DocActions doc={doc} disabled={editDisabled} api={documentApi} onChanged={changed} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {queuedDocs.map(({ q, index }) => (
                <div key={`q-${index}`} className="text-xs tms-card-docslot-queued" data-testid="card-documents-slot-queued">
                  <span className="tms-muted">{`${q.file.name} will upload on create.`}</span>
                  <TmsButton size="sm" variant="ghost" aria-label={`Remove ${q.file.name}`} onClick={() => ctx.actions.unqueueDocument(index)}>✕</TmsButton>
                </div>
              ))}
              <TmsButton
                size="sm"
                disabled={disabled}
                data-testid={`card-documents-slot-${docType}-upload`}
                onClick={() => slotInputs.current[docType]?.click()}
              >
                <Upload size={13} aria-hidden />{onFile ? 'Upload another' : 'Upload'}
              </TmsButton>
              <input
                ref={(el) => { slotInputs.current[docType] = el }}
                type="file"
                className="tms-card-visually-hidden"
                aria-label={`Upload ${label}`}
                accept={ACCEPTED_CONTENT_TYPES.join(',')}
                disabled={disabled}
                onChange={(e) => { void take(e.target.files, docType, 'ALL'); e.target.value = '' }}
              />
            </div>
          )
        })}
      </div>

      <div className="tms-card-req-title" data-testid="card-documents-other-title">Other documents</div>
      <TmsTabs
        tabs={[{ key: 'public', label: LABEL.documents.public.text }, { key: 'private', label: LABEL.documents.private.text }]}
        active={tab}
        onSelect={(k) => setTab(k as Tab)}
      />

      <div className="tms-card-docs-top">
        <div
          className="tms-card-dropzone"
          data-over={over || undefined}
          data-testid="card-documents-dropzone"
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <Upload size={16} aria-hidden />
          <span>Drop files here or</span>
          <TmsButton size="sm" disabled={disabled} onClick={() => input.current?.click()} data-testid="card-documents-pick">
            {working ? 'Uploading…' : 'Choose files'}
          </TmsButton>
          <input
            ref={input}
            type="file"
            multiple
            className="tms-card-visually-hidden"
            {...fieldAttrs(LABEL.documents.upload)}
            accept={ACCEPTED_CONTENT_TYPES.join(',')}
            disabled={disabled}
            onChange={(e) => void take(e.target.files)}
          />
        </div>
        <Field span={12} label={LABEL.documents.fileType.text}>
          <TmsSelect
            {...fieldAttrs(LABEL.documents.fileType)}
            value={type}
            disabled={disabled}
            onChange={(e) => setType(e.target.value as ShipmentDocumentType)}
            options={SHIPMENT_DOCUMENT_TYPES.map((t) => ({ value: t, label: DOCUMENT_TYPE_LABELS[t] ?? t }))}
          />
        </Field>
      </div>
      {problem && <p className="tms-card-docs-problem" role="alert" data-testid="card-documents-problem">{problem}</p>}
      {hasOld && (
        <label className="tms-card-docs-old text-xs">
          <input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} data-testid="card-documents-show-superseded" />
          <span>Show superseded</span>
        </label>
      )}
      {!saved && (
        <p className="tms-muted text-xs" data-testid="card-documents-draft-note">
          Files attached before Create are written to the shipment when you create it. They are held in this browser tab
          only: the saved draft keeps no file contents, so reloading the page drops them.
        </p>
      )}

      <table className="tms-card-docs-table" data-testid="card-documents-list">
        <thead>
          <tr><th>Name</th><th>Type</th><th>Uploaded</th><th /></tr>
        </thead>
        <tbody>
          {shown.length === 0 && queued.length === 0 && (
            <tr><td colSpan={4} className="tms-muted">No {tab} documents.</td></tr>
          )}
          {shown.map((d) => (
            <tr key={d.id} data-testid="card-documents-row">
              <td><button type="button" className="tms-link" onClick={() => void preview(d)}>{d.name}</button></td>
              <td>
                {isPointerDocument(d) || d.source === 'GENERATED' || d.status !== 'ACTIVE' || !saved
                  ? (DOCUMENT_TYPE_LABELS[d.type] ?? d.type)
                  : <DocActions doc={d} disabled={editDisabled} api={documentApi} onChanged={changed} show="type" />}
                {d.source === 'GENERATED' && <span className="tms-muted">{` v${d.version}`}</span>}
                {d.status === 'SUPERSEDED' && <span className="tms-muted" data-testid="card-documents-superseded-chip"> superseded</span>}
              </td>
              <td className="tms-muted">{[d.uploadedBy, formatBoardDateTime(d.uploadedAt)].filter(Boolean).join(' · ')}</td>
              <td className="tms-card-docs-actions">
                <TmsIconButton shape="plain" aria-label={`Preview ${d.name}`} title="Preview" onClick={() => void preview(d)}>
                  <Eye size={14} />
                </TmsIconButton>
                <DocActions doc={d} disabled={editDisabled} api={documentApi} onChanged={changed} show="delete" />
              </td>
            </tr>
          ))}
          {queued.map(({ q, index }) => (
            <tr key={`q-${index}`} data-testid="card-documents-queued-row">
              <td>{q.file.name}</td>
              <td>{DOCUMENT_TYPE_LABELS[q.type] ?? q.type}</td>
              <td className="tms-muted">will upload on create</td>
              <td className="tms-card-docs-actions">
                <TmsIconButton
                  shape="plain" aria-label={`Preview ${q.file.name}`} title="Preview"
                  onClick={() => previewQueued(q.file, q.type)}
                >
                  <Eye size={14} />
                </TmsIconButton>
                <TmsButton size="sm" variant="ghost" aria-label={`Remove ${q.file.name}`} onClick={() => ctx.actions.unqueueDocument(index)}>✕</TmsButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {emailPdfMissing ? (
        <div className="tms-card-req" data-testid="card-documents-email-pdf">
          <TmsButton size="sm" variant="primary" disabled={disabled} onClick={() => { void fileEmailPdf() }} data-testid="card-documents-add-email-pdf">
            Add the e-mail&apos;s rate confirmation
          </TmsButton>
          <span className="tms-muted text-xs"> The e-mail this load came from has a PDF that is not in Documents yet.</span>
        </div>
      ) : null}
      <LoadRequiredDocs
        bundle={saved ? ctx.bundle : null}
        customer={ctx.customer}
        settings={ctx.settings}
        disabled={disabled}
        refreshBundle={ctx.refreshBundle}
      />
      <div className="tms-card-req" data-testid="card-documents-checklist">
        <div className="tms-card-req-title">Required for release</div>
        <ul className="tms-card-docs-checklist">
          {checklist.map((c) => (
            <li
              key={c.type}
              data-testid={`card-documents-check-${c.type}`}
              data-met={c.present ? 'true' : 'false'}
              data-required={c.required ? 'true' : 'false'}
              data-queued={c.queued || undefined}
            >
              {c.present || c.queued ? <Check size={12} aria-hidden /> : <Circle size={12} aria-hidden />}
              <span>{DOCUMENT_TYPE_LABELS[c.type]}</span>
              {!c.required && <span className="tms-muted">optional</span>}
              {c.queued && <span className="tms-muted">queued</span>}
              {c.generatedVersion != null && c.present && <span className="tms-muted" data-testid="card-documents-check-generated">{`generated v${c.generatedVersion}`}</span>}
              {c.stale && (
                <span className="tms-card-docs-stale" data-testid="card-documents-bol-stale">
                  {`BOL v${c.generatedVersion} predates the last edit: regenerate`}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
      {viewing && (
        <DocumentPreview open onClose={closePreview} title={viewing.title} subtitle={viewing.subtitle} url={viewing.url} contentType={viewing.contentType} downloadName={viewing.name} />
      )}
    </div>
  )
}

export const DocumentsCard = memo(DocumentsCardImpl)
