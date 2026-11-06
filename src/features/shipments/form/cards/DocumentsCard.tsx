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
import { Check, Circle, Download, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsIconButton, TmsSelect, TmsTabs } from '@/features/tms/kit'
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

function openUrl(url: string) {
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener'
  a.click()
}

function DocumentsCardImpl({ values, ctx }: CardProps) {
  const [tab, setTab] = useState<Tab>('public')
  const [type, setType] = useState<ShipmentDocumentType>('OTHER')
  const [problem, setProblem] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const saved = ctx.mode === 'edit' && ctx.bundle != null
  const audience: 'ALL' | 'INTERNAL' = tab === 'public' ? 'ALL' : 'INTERNAL'
  const disabled = ctx.busy || working || isLocked(ctx.locked, 'all')
  const queuedAll = values.docs.queued

  const active = (ctx.bundle?.documents ?? []).filter((d) => d.status === 'ACTIVE')
  const shown = active.filter((d) => (tab === 'public' ? PUBLIC_AUDIENCES.includes(d.audience) : d.audience === 'INTERNAL'))
  const queued = queuedAll
    .map((q, index) => ({ q, index }))
    .filter(({ q }) => (tab === 'public' ? q.audience === 'ALL' : q.audience === 'INTERNAL'))

  const checklist = releaseDocItems({ customer: ctx.customer, settings: ctx.settings, bundle: ctx.bundle, queued: queuedAll })

  const preview = async (key: string) => {
    try { openUrl(await getShipmentDocumentUrl(key)) } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open that document')
    }
  }

  const take = async (files: FileList | File[] | null) => {
    const list = Array.from(files ?? [])
    if (list.length === 0) return
    setProblem(null)
    setWorking(true)
    try {
      for (const file of list) {
        const bad = fileProblem(file)
        if (bad) { setProblem(bad); continue }
        if (!saved) ctx.actions.queueDocument(file, audience, type)
        else await ctx.actions.uploadDocument(file, audience, type)
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
              <td>{d.name}</td>
              <td>{DOCUMENT_TYPE_LABELS[d.type] ?? d.type}</td>
              <td className="tms-muted">{[d.uploadedBy, formatBoardDateTime(d.uploadedAt)].filter(Boolean).join(' · ')}</td>
              <td>
                <TmsIconButton shape="plain" aria-label={`Preview ${d.name}`} onClick={() => void preview(d.s3Key)}>
                  <Download size={14} />
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
                  shape="plain" aria-label={`Preview ${q.file.name}`}
                  onClick={() => openUrl(URL.createObjectURL(q.file))}
                >
                  <Download size={14} />
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
              data-queued={c.queued || undefined}
            >
              {c.present || c.queued ? <Check size={12} aria-hidden /> : <Circle size={12} aria-hidden />}
              <span>{DOCUMENT_TYPE_LABELS[c.type]}</span>
              {c.queued && <span className="tms-muted">queued</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export const DocumentsCard = memo(DocumentsCardImpl)
