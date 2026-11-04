/**
 * Documents (AH-plan §4.11): Public (audience CUSTOMER / CARRIER / ALL) and Private (INTERNAL)
 * tabs over the shipment's active documents, plus the upload row. In create mode a picked
 * file is queued in memory and uploaded by the pipeline right after the first save.
 */
import { memo, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsIconButton, TmsSelect, TmsTabs } from '@/features/tms/kit'
import { getShipmentDocumentUrl } from '@/lib/apiClient'
import {
  ACCEPTED_CONTENT_TYPES, DOCUMENT_TYPE_LABELS, MAX_DOCUMENT_BYTES, SHIPMENT_DOCUMENT_TYPES,
} from '@/lib/shipmentDocuments'
import type { ShipmentDocumentAudience, ShipmentDocumentType } from '@/types/tms'
import { LABEL } from '../labels'
import { isLocked } from '../model'
import type { SliceSectionProps } from '../sectionRegistry'
import { fieldAttrs } from './fieldAttrs'

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

function FormDocumentsSectionImpl({ value, ctx }: SliceSectionProps<'docs'>) {
  const [tab, setTab] = useState<Tab>('public')
  const [type, setType] = useState<ShipmentDocumentType>('OTHER')
  const [file, setFile] = useState<File | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const saved = ctx.mode === 'edit' && ctx.bundle != null
  const audience: 'ALL' | 'INTERNAL' = tab === 'public' ? 'ALL' : 'INTERNAL'
  const disabled = ctx.busy || working || isLocked(ctx.locked, 'all')

  const active = (ctx.bundle?.documents ?? []).filter((d) => d.status === 'ACTIVE')
  const shown = active.filter((d) => (tab === 'public' ? PUBLIC_AUDIENCES.includes(d.audience) : d.audience === 'INTERNAL'))
  const queued = value.queued
    .map((q, index) => ({ q, index }))
    .filter(({ q }) => (tab === 'public' ? q.audience === 'ALL' : q.audience === 'INTERNAL'))

  const download = async (key: string) => {
    try {
      const url = await getShipmentDocumentUrl(key)
      const a = document.createElement('a')
      a.href = url
      a.target = '_blank'
      a.rel = 'noopener'
      a.click()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not download that document')
    }
  }

  const upload = async () => {
    if (!file) return
    const bad = fileProblem(file)
    if (bad) { setProblem(bad); return }
    setProblem(null)
    if (!saved) {
      ctx.actions.queueDocument(file, audience, type)
    } else {
      setWorking(true)
      try {
        await ctx.actions.uploadDocument(file, audience, type)
      } catch (err) {
        setProblem(err instanceof Error ? err.message : 'The upload failed')
        setWorking(false)
        return
      }
      setWorking(false)
    }
    setFile(null)
    if (input.current) input.current.value = ''
  }

  return (
    <div className="space-y-2" data-testid="section-documents-body">
      <TmsTabs
        tabs={[{ key: 'public', label: LABEL.documents.public.text }, { key: 'private', label: LABEL.documents.private.text }]}
        active={tab}
        onSelect={(k) => setTab(k as Tab)}
      />

      <table className="w-full text-left text-xs" data-testid="documents-table">
        <thead>
          <tr><th>Document</th><th>{LABEL.documents.fileType.text}</th><th /></tr>
        </thead>
        <tbody>
          {shown.length === 0 && queued.length === 0 && (
            <tr><td colSpan={3} className="tms-muted">No {tab} documents.</td></tr>
          )}
          {shown.map((d) => (
            <tr key={d.id} data-testid="documents-row">
              <td>{d.name}</td>
              <td>{DOCUMENT_TYPE_LABELS[d.type] ?? d.type}</td>
              <td>
                <TmsIconButton shape="plain" aria-label={`Download ${d.name}`} onClick={() => download(d.s3Key)}>
                  <Download size={14} />
                </TmsIconButton>
              </td>
            </tr>
          ))}
          {queued.map(({ q, index }) => (
            <tr key={`q-${index}`} data-testid="documents-queued-row">
              <td>{q.file.name} <span className="tms-muted">· will upload on save</span></td>
              <td>{DOCUMENT_TYPE_LABELS[q.type] ?? q.type}</td>
              <td>
                <TmsButton size="sm" variant="ghost" aria-label={`Remove ${q.file.name}`} onClick={() => ctx.actions.unqueueDocument(index)}>✕</TmsButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex flex-wrap items-end gap-2">
        <TmsField label={LABEL.documents.upload.text}>
          <input
            ref={input}
            type="file"
            {...fieldAttrs(LABEL.documents.upload)}
            accept={ACCEPTED_CONTENT_TYPES.join(',')}
            disabled={disabled}
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setProblem(null) }}
          />
        </TmsField>
        <TmsField label={LABEL.documents.fileType.text}>
          <TmsSelect
            {...fieldAttrs(LABEL.documents.fileType)}
            value={type}
            disabled={disabled}
            onChange={(e) => setType(e.target.value as ShipmentDocumentType)}
            options={SHIPMENT_DOCUMENT_TYPES.map((t) => ({ value: t, label: DOCUMENT_TYPE_LABELS[t] ?? t }))}
          />
        </TmsField>
        <TmsButton size="sm" data-testid="documents-upload" disabled={disabled || !file} onClick={upload}>
          {working ? 'Uploading…' : LABEL.documents.upload.text}
        </TmsButton>
      </div>
      {problem && <p className="text-xs" role="alert" data-testid="documents-problem" style={{ color: 'var(--tms-badge-red)' }}>{problem}</p>}
    </div>
  )
}

export const FormDocumentsSection = memo(FormDocumentsSectionImpl)
