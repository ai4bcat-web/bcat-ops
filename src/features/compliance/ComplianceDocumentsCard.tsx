import { useMemo, useRef, useState } from 'react'
import { Eye, Download, Upload, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody,
} from '@/components/ui/sheet'
import { useComplianceDocuments } from '@/hooks/useComplianceDocuments'
import { useOnboardingTasks } from '@/hooks/useOnboardingTasks'
import { useAuth } from '@/hooks/useAuth'
import {
  uploadComplianceDocument, getComplianceDocUrl, writeComplianceAudit,
  isAcceptedDoc, ACCEPTED_DOC_EXT,
} from '@/lib/complianceClient'
import { expirationStatus } from '@/lib/complianceStatus'
import { getRequirement } from '@/lib/complianceRequirements'
import { DocStatusBadge, daysRemainingLabel, Card, DocumentPreview } from './components'
import type { ComplianceDocument, ComplianceEntityType, ComplianceDocument as Doc } from '@/types'

interface Props {
  entityType: ComplianceEntityType
  entityId: string
}

export function ComplianceDocumentsCard({ entityType, entityId }: Props) {
  const { user } = useAuth()
  const { documents, loading, addDocument, refresh } = useComplianceDocuments(entityType, entityId)
  const { tasks, changeStatus, refresh: refreshTasks } = useOnboardingTasks(entityType, entityId)

  const [preview, setPreview] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [presetKey, setPresetKey] = useState<string | undefined>(undefined)

  // Keep only the latest record per documentType (history preserved server-side).
  const latestByType = useMemo(() => {
    const m = new Map<string, ComplianceDocument>()
    for (const d of [...documents].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      m.set(d.documentType, d)
    }
    return m
  }, [documents])

  // Required document-bearing tasks with no valid doc on file → "missing", pinned red.
  const missingRequired = tasks.filter(
    (t) =>
      t.required &&
      t.requiresDocument &&
      t.status !== 'COMPLETE' &&
      t.status !== 'WAIVED' &&
      t.status !== 'NOT_APPLICABLE' &&
      latestByType.get(t.requirementKey)?.status !== 'VALID',
  )

  async function openDoc(doc: Doc, download = false) {
    if (!doc.s3Key) { toast.info('This item has no uploaded file'); return }
    if (download) {
      const url = await getComplianceDocUrl(doc.s3Key)
      window.open(url, '_blank', 'noopener')
    } else {
      setPreview(doc.s3Key)
    }
  }

  function startAdd(requirementKey?: string) {
    setPresetKey(requirementKey)
    setAddOpen(true)
  }

  const rows = [...latestByType.values()].sort((a, b) => a.documentType.localeCompare(b.documentType))

  return (
    <Card
      title="Documents"
      sub={loading ? 'Loading…' : `${rows.length} on file`}
      right={<Button size="sm" variant="outline" onClick={() => startAdd(undefined)}><Plus size={14} /> Add document</Button>}
      noPad
    >
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
              {['Document', 'Expiration', 'Status', 'Source', ''].map((h, i) => (
                <th key={h} style={{ padding: '8px 14px', textAlign: i === 4 ? 'right' : 'left', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Missing required — pinned top, red */}
            {missingRequired.map((t) => (
              <tr key={`missing-${t.id}`} style={{ borderBottom: '1px solid var(--ds-border)', background: 'rgba(220,38,38,0.04)' }}>
                <td style={{ padding: '9px 14px', fontWeight: 500, color: '#b91c1c' }}>{t.label}</td>
                <td style={{ padding: '9px 14px', color: 'var(--ds-t3)' }}>—</td>
                <td style={{ padding: '9px 14px' }}><Badge variant="destructive">Missing</Badge></td>
                <td style={{ padding: '9px 14px', color: 'var(--ds-t3)' }}>—</td>
                <td style={{ padding: '9px 14px', textAlign: 'right' }}>
                  <Button size="sm" variant="outline" onClick={() => startAdd(t.requirementKey)}><Upload size={13} /> Upload</Button>
                </td>
              </tr>
            ))}

            {rows.length === 0 && missingRequired.length === 0 && (
              <tr><td colSpan={5} style={{ padding: '24px 14px', textAlign: 'center', color: 'var(--ds-t3)' }}>No documents yet.</td></tr>
            )}

            {rows.map((d) => (
              <tr key={d.id} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                <td style={{ padding: '9px 14px' }}>
                  <div style={{ fontWeight: 500, color: 'var(--ds-t1)' }}>{d.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>{getRequirement(d.documentType)?.category ?? d.documentType}</div>
                </td>
                <td style={{ padding: '9px 14px', color: 'var(--ds-t2)' }}>
                  {d.expirationDate ? (
                    <>
                      {d.expirationDate}
                      <span style={{ marginLeft: 6, fontSize: 11.5, color: 'var(--ds-t3)' }}>({daysRemainingLabel(d.expirationDate)})</span>
                    </>
                  ) : 'No expiration'}
                </td>
                <td style={{ padding: '9px 14px' }}><DocStatusBadge status={d.status} /></td>
                <td style={{ padding: '9px 14px' }}>
                  <span style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>{d.uploadedBy === 'DRIVER_PORTAL' ? 'Portal' : 'Internal'}</span>
                </td>
                <td style={{ padding: '9px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {d.s3Key && <Button size="sm" variant="ghost" onClick={() => openDoc(d)} title="Preview"><Eye size={14} /></Button>}
                  {d.s3Key && <Button size="sm" variant="ghost" onClick={() => openDoc(d, true)} title="Download"><Download size={14} /></Button>}
                  <Button size="sm" variant="ghost" onClick={() => startAdd(d.documentType)} title="Replace"><RefreshCw size={14} /></Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Preview sheet */}
      <Sheet open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <SheetContent style={{ width: 'min(820px, 92vw)' }}>
          <SheetHeader><SheetTitle>Document preview</SheetTitle></SheetHeader>
          <SheetBody>{preview && <DocumentPreview s3Key={preview} />}</SheetBody>
        </SheetContent>
      </Sheet>

      {addOpen && (
        <AddDocumentDialog
          entityType={entityType}
          entityId={entityId}
          presetKey={presetKey}
          requirementOptions={tasks.filter((t) => t.requiresDocument).map((t) => ({ key: t.requirementKey, label: t.label, requiresExpiration: t.requiresExpiration }))}
          onClose={() => setAddOpen(false)}
          onDone={async (doc, requirementKey) => {
            const created = await addDocument(doc)
            const task = tasks.find((t) => t.requirementKey === requirementKey)
            if (task) await changeStatus(task.id, 'COMPLETE', { completedBy: user?.email, complianceDocumentId: created.id })
            await writeComplianceAudit({
              entityType, entityId, action: 'document_uploaded',
              user: user?.email ?? 'unknown',
              changes: { documentType: requirementKey, source: 'INTERNAL' },
            })
            await Promise.all([refresh(), refreshTasks()])
            setAddOpen(false)
            toast.success('Document added')
          }}
        />
      )}
    </Card>
  )
}

// ── Add / replace document dialog ──────────────────────────────────────────────

interface AddProps {
  entityType: ComplianceEntityType
  entityId: string
  presetKey?: string
  requirementOptions: { key: string; label: string; requiresExpiration: boolean }[]
  onClose: () => void
  onDone: (doc: Omit<ComplianceDocument, 'id' | 'createdAt' | 'updatedAt'>, requirementKey: string) => void | Promise<void>
}

function AddDocumentDialog({ entityType, entityId, presetKey, requirementOptions, onClose, onDone }: AddProps) {
  const { user } = useAuth()
  const fileRef = useRef<HTMLInputElement>(null)
  const [requirementKey, setRequirementKey] = useState(presetKey ?? requirementOptions[0]?.key ?? '')
  const [expiration, setExpiration] = useState('')
  const [busy, setBusy] = useState(false)

  const req = getRequirement(requirementKey)
  const needsExpiration = req?.requiresExpiration ?? false

  async function submit() {
    const file = fileRef.current?.files?.[0]
    if (!requirementKey) { toast.error('Pick a requirement'); return }
    if (!file) { toast.error('Choose a file'); return }
    if (!isAcceptedDoc(file)) { toast.error('Accepted: PDF/JPG/PNG/HEIC up to 15MB'); return }
    setBusy(true)
    try {
      const s3Key = await uploadComplianceDocument(entityType, entityId, requirementKey, file)
      const status = needsExpiration ? expirationStatus(expiration || null) : 'VALID'
      await onDone(
        {
          entityType,
          entityId,
          documentType: requirementKey,
          title: req?.label ?? requirementKey,
          s3Key,
          expirationDate: expiration || null,
          status,
          uploadedBy: 'INTERNAL',
          verifiedBy: user?.email ?? 'unknown',
          verifiedAt: new Date().toISOString(),
        },
        requirementKey,
      )
    } catch (err) {
      console.error('[add document] failed', err)
      toast.error('Upload failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add document</DialogTitle>
          <DialogDescription>Internal upload — recorded as verified. The previous version (if any) is preserved.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Requirement</Label>
            <select
              value={requirementKey}
              onChange={(e) => setRequirementKey(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-white px-3 text-sm"
            >
              {requirementOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">File</Label>
            <Input ref={fileRef} type="file" accept={ACCEPTED_DOC_EXT} className="h-9" />
          </div>
          {needsExpiration && (
            <div className="space-y-1.5">
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Expiration date</Label>
              <Input type="date" value={expiration} onChange={(e) => setExpiration(e.target.value)} className="h-9" />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? 'Uploading…' : 'Upload'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
