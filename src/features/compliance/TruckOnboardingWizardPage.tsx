import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Rocket, Upload, Eye, Check, Ban } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store/useAppStore'
import { useOnboardingTasks } from '@/hooks/useOnboardingTasks'
import { useComplianceDocuments } from '@/hooks/useComplianceDocuments'
import { useStartOnboarding } from '@/hooks/useStartOnboarding'
import { useAuth } from '@/hooks/useAuth'
import {
  listTruckConfigs, upsertTruckConfig, type TruckConfig,
} from '@/lib/apiClient'
import {
  uploadComplianceDocument, getComplianceDocUrl, writeComplianceAudit,
  isAcceptedDoc, ACCEPTED_DOC_EXT,
} from '@/lib/complianceClient'
import { getRequirement, type TruckOwnershipType } from '@/lib/complianceRequirements'
import { expirationStatus, smartDefaultExpiration } from '@/lib/complianceStatus'
import { ComplianceBadge, ProgressBar, TaskStatusBadge, Card } from './components'
import type { OnboardingTask } from '@/types'

// requirementKey → TruckConfig field for inline equipment-value capture
const VALUE_FIELD: Record<string, keyof TruckConfig> = {
  fuel_card_assigned: 'assignedFuelCardNumber',
  phone_assigned: 'assignedPhone',
  tablet_assigned: 'assignedTablet',
  eld_installed: 'eldSerialNumber',
}

const OWNERSHIP_OPTIONS: { value: TruckOwnershipType; label: string }[] = [
  { value: 'COMPANY', label: 'Company-Owned' },
  { value: 'LEASED', label: 'Leased' },
  { value: 'OWNER_OPERATOR', label: 'Owner-Operator' },
]

export function TruckOnboardingWizardPage() {
  const { truckId = '' } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const equipment = useAppStore((s) => s.equipment.find((e) => e.id === truckId))
  const { startOnboarding, isStarting } = useStartOnboarding()
  const { tasks, loading, doneCount, requiredCount, allRequiredDone, refresh: refreshTasks, changeStatus } =
    useOnboardingTasks('TRUCK', truckId)
  const { documents, addDocument, refresh: refreshDocs } = useComplianceDocuments('TRUCK', truckId)

  const [config, setConfig] = useState<TruckConfig | null>(null)
  const [classification, setClassification] = useState<TruckOwnershipType>('COMPANY')

  const loadConfig = useCallback(async () => {
    const all = await listTruckConfigs()
    const c = all.find((x) => x.truckId === truckId) ?? null
    setConfig(c)
    if (c?.ownershipType) setClassification(c.ownershipType)
    else if (equipment?.ownership === 'leased' || equipment?.ownership === 'rented') setClassification('LEASED')
  }, [truckId, equipment?.ownership])

  useEffect(() => { loadConfig() }, [loadConfig])

  // Flip onboardingStatus COMPLETE when all required items are done.
  useEffect(() => {
    if (!equipment || tasks.length === 0) return
    const target = allRequiredDone ? 'COMPLETE' : 'IN_PROGRESS'
    if (config && config.onboardingStatus !== target) {
      upsertTruckConfig({ truckId, unitNumber: equipment.unitNumber, onboardingStatus: target })
        .then((c) => setConfig(c))
        .catch((e) => console.error('[truck onboarding status]', e))
    }
  }, [allRequiredDone, tasks.length, config, equipment, truckId])

  async function handleGenerate() {
    if (!equipment) return
    try {
      await startOnboarding({ entityType: 'TRUCK', entityId: truckId, classification })
      const c = await upsertTruckConfig({
        truckId, unitNumber: equipment.unitNumber, ownershipType: classification, onboardingStatus: 'IN_PROGRESS',
      })
      setConfig(c)
      await refreshTasks()
      toast.success('Checklist generated')
    } catch (e) {
      console.error('[truck generate]', e)
      toast.error('Could not generate checklist')
    }
  }

  if (!equipment) {
    return (
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '24px 32px' }}>
        <Button variant="ghost" onClick={() => navigate('/trucks')}><ArrowLeft size={15} /> Back</Button>
        <p style={{ marginTop: 16, color: 'var(--ds-t3)' }}>Truck not found.</p>
      </div>
    )
  }

  const byCategory = tasks.reduce<Record<string, OnboardingTask[]>>((acc, t) => {
    (acc[t.category] ??= []).push(t)
    return acc
  }, {})

  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Button variant="ghost" size="sm" onClick={() => navigate('/trucks')}><ArrowLeft size={15} /> Fleet</Button>

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--ds-t1)', margin: 0 }}>
              Unit {equipment.unitNumber} {equipment.nickname ? `· ${equipment.nickname}` : ''}
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <Badge variant="outline">{OWNERSHIP_OPTIONS.find((o) => o.value === classification)?.label}</Badge>
              <ComplianceBadge status={config?.complianceStatus} />
            </div>
          </div>
        </div>

        {tasks.length === 0 && !loading ? (
          <Card title="Start truck onboarding" sub="Classify the truck, then generate its DOT checklist.">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <select
                value={classification}
                onChange={(e) => setClassification(e.target.value as TruckOwnershipType)}
                className="h-9 rounded-md border border-input bg-white px-3 text-sm"
              >
                {OWNERSHIP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <Button onClick={handleGenerate} disabled={isStarting}><Rocket size={15} /> Generate checklist</Button>
            </div>
          </Card>
        ) : (
          <>
            <Card title="Onboarding progress" sub={`${doneCount} of ${requiredCount} required items complete`}>
              <ProgressBar value={doneCount} max={requiredCount} />
            </Card>

            {Object.entries(byCategory).map(([cat, items]) => (
              <Card key={cat} title={cat} noPad>
                <div>
                  {items.map((t) => (
                    <TruckTaskRow
                      key={t.id}
                      task={t}
                      truckId={truckId}
                      doc={documents.find((d) => d.documentType === t.requirementKey)}
                      onChangeStatus={changeStatus}
                      onUploaded={async (input, reqKey) => {
                        const created = await addDocument(input)
                        await changeStatus(t.id, 'COMPLETE', { completedBy: user?.email, complianceDocumentId: created.id })
                        await writeComplianceAudit({ entityType: 'TRUCK', entityId: truckId, action: 'document_uploaded', user: user?.email ?? 'unknown', changes: { documentType: reqKey, source: 'INTERNAL' } })
                        await Promise.all([refreshDocs(), refreshTasks()])
                      }}
                      onCaptureValue={async (field, value) => {
                        const c = await upsertTruckConfig({ truckId, unitNumber: equipment.unitNumber, [field]: value })
                        setConfig(c)
                        await changeStatus(t.id, 'COMPLETE', { completedBy: user?.email })
                      }}
                    />
                  ))}
                </div>
              </Card>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

// ── Single checklist row ────────────────────────────────────────────────────────

interface RowProps {
  task: OnboardingTask
  truckId: string
  doc?: import('@/types').ComplianceDocument
  onChangeStatus: (id: string, status: OnboardingTask['status'], opts?: { completedBy?: string }) => Promise<unknown>
  onUploaded: (input: Omit<import('@/types').ComplianceDocument, 'id' | 'createdAt' | 'updatedAt'>, requirementKey: string) => Promise<void>
  onCaptureValue: (field: keyof TruckConfig, value: string) => Promise<void>
}

function TruckTaskRow({ task, truckId, doc, onChangeStatus, onUploaded, onCaptureValue }: RowProps) {
  const { user } = useAuth()
  const req = getRequirement(task.requirementKey)
  const fileRef = useRef<HTMLInputElement>(null)
  const valueField = VALUE_FIELD[task.requirementKey]
  const [expiration, setExpiration] = useState(
    () => smartDefaultExpiration(req?.defaultExpirationRule, req?.defaultExpirationMonths) ?? '',
  )
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const isDone = task.status === 'COMPLETE' || task.status === 'WAIVED' || task.status === 'NOT_APPLICABLE'

  async function handleFile(file: File) {
    if (!isAcceptedDoc(file)) { toast.error('Accepted: PDF/JPG/PNG/HEIC up to 15MB'); return }
    setBusy(true)
    try {
      const s3Key = await uploadComplianceDocument('TRUCK', truckId, task.requirementKey, file)
      const status = task.requiresExpiration ? expirationStatus(expiration || null) : 'VALID'
      await onUploaded(
        {
          entityType: 'TRUCK', entityId: truckId, documentType: task.requirementKey,
          title: req?.label ?? task.label, s3Key, expirationDate: expiration || null,
          status, uploadedBy: 'INTERNAL', verifiedBy: user?.email ?? 'unknown', verifiedAt: new Date().toISOString(),
        },
        task.requirementKey,
      )
      toast.success('Uploaded')
    } catch (e) {
      console.error('[upload]', e); toast.error('Upload failed')
    } finally { setBusy(false) }
  }

  async function waive() {
    const reason = window.prompt('Reason for waiving this item?')
    if (reason == null) return
    await onChangeStatus(task.id, 'WAIVED', { completedBy: user?.email })
    await writeComplianceAudit({ entityType: 'TRUCK', entityId: truckId, action: 'document_uploaded', user: user?.email ?? 'unknown', changes: { waived: task.requirementKey, reason } })
  }

  async function viewDoc() {
    if (!doc?.s3Key) return
    window.open(await getComplianceDocUrl(doc.s3Key), '_blank', 'noopener')
  }

  return (
    <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--ds-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13.5, color: 'var(--ds-t1)' }}>{task.label}</span>
            {task.required && <span style={{ fontSize: 10, color: '#dc2626' }}>required</span>}
          </div>
          {req?.helpText && <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 2 }}>{req.helpText}</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <TaskStatusBadge status={task.status} />
          {!isDone && (
            <>
              {task.requiresExpiration && (
                <Input type="date" value={expiration} onChange={(e) => setExpiration(e.target.value)} className="h-8 w-[150px]" title="Expiration" />
              )}
              {task.requiresDocument && (
                <>
                  <input ref={fileRef} type="file" accept={ACCEPTED_DOC_EXT} style={{ display: 'none' }}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={13} /> Upload</Button>
                </>
              )}
              {valueField && (
                <>
                  <Input
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={task.requirementKey === 'fuel_card_assigned' ? 'Last 4' : 'Value'}
                    maxLength={task.requirementKey === 'fuel_card_assigned' ? 4 : undefined}
                    className="h-8 w-[110px]"
                  />
                  <Button size="sm" variant="outline" disabled={busy || !value.trim()} onClick={() => onCaptureValue(valueField, value.trim())}>
                    <Check size={13} /> Save
                  </Button>
                </>
              )}
              {!task.requiresDocument && !valueField && (
                <Button size="sm" variant="outline" onClick={() => onChangeStatus(task.id, 'COMPLETE', { completedBy: user?.email })}><Check size={13} /> Mark complete</Button>
              )}
              <Button size="sm" variant="ghost" onClick={waive}><Ban size={13} /> Waive</Button>
              {!task.required && (
                <Button size="sm" variant="ghost" onClick={() => onChangeStatus(task.id, 'NOT_APPLICABLE')}>N/A</Button>
              )}
            </>
          )}
          {doc?.s3Key && <Button size="sm" variant="ghost" onClick={viewDoc} title="View file"><Eye size={14} /></Button>}
        </div>
      </div>
    </div>
  )
}
