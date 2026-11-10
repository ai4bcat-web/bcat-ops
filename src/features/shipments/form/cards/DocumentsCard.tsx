/**
 * Card 9: Documents (Step AR). Upload drop zone + picker, Public / Private tabs, the list with
 * type / name / uploaded by-when / preview, and an informational "Required for release"
 * checklist. Works before the shipment exists: files are queued in `values.docs.queued` (held in
 * memory for the session; the browser draft stores no file bytes, so a reload drops them) and
 * written as ShipmentDocument by `runUploadQueued` right after Create. Delete is available for
 * queued files (the drafted ones); saved documents are preview-only here.
 */
import { Field } from '../fieldGrid'
import { memo, useRef, useState, type DragEvent } from 'react'
import { Check, Circle, Eye, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsIconButton, TmsSelect, TmsTabs } from '@/features/tms/kit'
import { DocumentPreview } from '@/features/documents/DocumentPreview'
import { getShipmentDocumentUrl } from '@/lib/apiClient'
import { formatBoardDateTime } from '@/lib/date'
import {
  ACCEPTED_CONTENT_TYPES, DOCUMENT_TYPE_LABELS, MAX_DOCUMENT_BYTES, SHIPMENT_DOCUMENT_TYPES,
} from '@/lib/shipmentDocuments'
import type { ShipmentDocumentAudience, ShipmentDocumentType } from '@/types/tms'
import { LABEL } from '../labels'
import { isLocked } from '../model'
import { fieldAttrs } from '../sections/fieldAttrs'
import type { CardProps } from './cardRegistry'
import { GenerateRow } from './GenerateRow'
import { releaseDocItems } from './releaseDocs'
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

function DocumentsCardImpl({ values, ctx }: CardProps) {
  const [tab, setTab] = useState<Tab>('public')
  const [type, setType] = useState<ShipmentDocumentType>('OTHER')
  const [problem, setProblem] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [over, setOver] = useState(false)
  const [showOld, setShowOld] = useState(false)
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const saved = ctx.mode === 'edit' && ctx.bundle != null
  const audience: 'ALL' | 'INTERNAL' = tab === 'public' ? 'ALL' : 'INTERNAL'
  const disabled = ctx.busy || working || isLocked(ctx.locked, 'all')
  const queuedAll = values.docs.queued
  const all = ctx.bundle?.documents ?? []
  const hasOld = all.some((d) => d.status === 'SUPERSEDED')
  const active = all.filter((d) => d.status === 'ACTIVE' || (showOld && d.status === 'SUPERSEDED'))
  const shown = active.filter((d) => (tab === 'public' ? PUBLIC_AUDIENCES.includes(d.audience) : d.audience === 'INTERNAL'))
  const queued = queuedAll
    .map((q, index) => ({ q, index }))
    .filter(({ q }) => (tab === 'public' ? q.audience === 'ALL' : q.audience === 'INTERNAL'))

  // The two documents everybody looks for get their own slot: on file (with where it came from) or an upload button.
  const slotDoc = (docType: ShipmentDocumentType) => all.find((d) => d.type === docType && d.status === 'ACTIVE' && PUBLIC_AUDIENCES.includes(d.audience))
  const slotQueued = (docType: ShipmentDocumentType) => queuedAll.find((q) => q.type === docType)
  const slotOrigin = (d: { uploadedBy?: string | null; source?: string | null }): string => {
    const by = d.uploadedBy ?? ''
    if (by.startsWith('link:')) return 'e-signed by the carrier'
    if (by.toLowerCase().includes('driver')) return 'from the driver'
    if (d.source === 'GENERATED') return 'generated'
    return 'uploaded'
  }
  const slotInputs = useRef<Record<string, HTMLInputElement | null>>({})

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

  const take = async (files: FileList | File[] | null, asType: ShipmentDocumentType = type, asAudience: 'ALL' | 'INTERNAL' = audience) => {
    const list = Array.from(files ?? [])
    if (list.length === 0) return
    setProblem(null)
    setWorking(true)
    try {
      for (const file of list) {
        const bad = fileProblem(file)
        if (bad) { setProblem(bad); continue }
        if (!saved) ctx.actions.queueDocument(file, asAudience, asType)
        else await ctx.actions.uploadDocument(file, asAudience, asType)
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
          const doc = slotDoc(docType)
          const queuedDoc = slotQueued(docType)
          return (
            <div key={docType} className="tms-card-docslot" data-testid={`card-documents-slot-${docType}`} data-on-file={doc ? 'true' : 'false'}>
              <div className="tms-card-docslot-head">
                {doc ? <Check size={14} aria-hidden /> : <Circle size={14} aria-hidden />}
                <strong>{label}</strong>
                <span className="tms-muted text-xs">{doc ? 'On file' : queuedDoc ? 'Queued' : 'Missing'}</span>
              </div>
              {doc ? (
                <div className="text-xs">
                  <button type="button" className="tms-link" onClick={() => void preview(doc)}>{doc.name}</button>
                  <span className="tms-muted">{` · ${slotOrigin(doc)} · ${formatBoardDateTime(doc.uploadedAt)}`}</span>
                </div>
              ) : (
                <p className="tms-muted text-xs">{queuedDoc ? `${queuedDoc.file.name} will upload on create.` : hint}</p>
              )}
              <TmsButton
                size="sm"
                disabled={disabled}
                data-testid={`card-documents-slot-${docType}-upload`}
                onClick={() => slotInputs.current[docType]?.click()}
              >
                <Upload size={13} aria-hidden />{doc ? 'Replace' : 'Upload'}
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
                {DOCUMENT_TYPE_LABELS[d.type] ?? d.type}
                {d.source === 'GENERATED' && <span className="tms-muted">{` v${d.version}`}</span>}
                {d.status === 'SUPERSEDED' && <span className="tms-muted" data-testid="card-documents-superseded-chip"> superseded</span>}
              </td>
              <td className="tms-muted">{[d.uploadedBy, formatBoardDateTime(d.uploadedAt)].filter(Boolean).join(' · ')}</td>
              <td>
                <TmsIconButton shape="plain" aria-label={`Preview ${d.name}`} title="Preview" onClick={() => void preview(d)}>
                  <Eye size={14} />
                </TmsIconButton>
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
