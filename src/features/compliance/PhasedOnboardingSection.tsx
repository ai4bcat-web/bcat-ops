import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown, ChevronRight, Lock, Upload, Check, MinusCircle, AlertTriangle, Truck, Circle,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { useOnboardingTasks } from '@/hooks/useOnboardingTasks'
import { useAuth } from '@/hooks/useAuth'
import {
  uploadComplianceDocument, createComplianceDocument, writeComplianceAudit,
  generateTruckTasksFromTemplate, setTaskStatus, isAcceptedDoc, ACCEPTED_DOC_EXT,
} from '@/lib/complianceClient'
import { getOnboardingTemplate } from '@/lib/onboardingTemplates'
import { getRequirement } from '@/lib/complianceRequirements'
import {
  buildPhaseViews, currentPhaseNumber, phaseComplete, isTaskDone, overdueTasks,
  STALLED_PHASE_THRESHOLD_DAYS, type PhaseView,
} from '@/lib/onboardingPhases'
import { TaskStatusBadge, ProgressBar, daysRemainingLabel, Card } from './components'
import type { Driver, OnboardingTask } from '@/types'

interface Props {
  driver: Driver
}

/**
 * Phased (Amazon) onboarding view for staff. Shows all 4 phases (office is NOT gated),
 * each split into Driver vs Office columns, with per-task status, assignee, due date, and
 * upload/attach. Truck-owned tasks (Phase 2) are generated on the driver's assigned
 * truck once Phase 1 completes, and shown inline here.
 */
export function PhasedOnboardingSection({ driver }: Props) {
  const template = getOnboardingTemplate(driver.onboardingTemplateId ?? '') ?? null
  const truckId = driver.assignedTruckId ?? null

  const driverHook = useOnboardingTasks('DRIVER', driver.id)
  const truckHook = useOnboardingTasks('TRUCK', truckId)

  // Phase open/closed: default-open the current phase; `manualOpen` records explicit toggles.
  const [manualOpen, setManualOpen] = useState<Record<number, boolean>>({})
  const [uploadTask, setUploadTask] = useState<OnboardingTask | null>(null)
  const genRef = useRef(false)

  const combined = useMemo(
    () => [...driverHook.tasks, ...truckHook.tasks],
    [driverHook.tasks, truckHook.tasks],
  )
  const current = currentPhaseNumber(combined)
  // Truck-owned tasks generate once the driver finishes Phase 1 (application/DQ), so the
  // office can register/plate the assigned truck DURING Phase 2 — the DOT inspection and
  // truck setup both live in Phase 2 now and must not wait on each other.
  const phase1Complete = phaseComplete(driverHook.tasks, 1)
  const needsTruck = phase1Complete && !truckId

  const views = useMemo(
    () => buildPhaseViews({ template, driverTasks: driverHook.tasks, truckTasks: truckHook.tasks, forDriverPortal: false }),
    [template, driverHook.tasks, truckHook.tasks],
  )

  // Escalation flags (reuses the same dueDate/stalled-threshold logic as EscalationRulesCard).
  const overdue = useMemo(() => overdueTasks(combined), [combined])
  const stalledPhases = views.filter((v) => v.stalled)

  const isOpen = (p: number) => manualOpen[p] ?? (p === current)

  // ── Truck link: once Phase 1 completes, generate truck-owned tasks on the assigned truck.
  useEffect(() => {
    if (!template || !truckId || !phase1Complete || genRef.current) return
    if (truckHook.loading) return
    // Only generate if the truck has no template tasks yet.
    if (truckHook.tasks.some((t) => t.templateId === template.id)) return
    genRef.current = true
    generateTruckTasksFromTemplate({ truckId, driverType: driver.driverType ?? 'COMPANY', template })
      .then(({ created }) => {
        if (created > 0) {
          toast.success(`Generated ${created} truck task${created === 1 ? '' : 's'} for the assigned truck`)
          void truckHook.refresh()
        }
      })
      .catch((e) => { console.error('[truck-link] failed', e); genRef.current = false })
  }, [template, truckId, phase1Complete, truckHook.loading, truckHook.tasks, truckHook, driver.driverType])

  function togglePhase(p: number) {
    setManualOpen((prev) => ({ ...prev, [p]: !(prev[p] ?? (p === current)) }))
  }

  if (!template) return null

  return (
    <Card
      title={`${template.label} onboarding`}
      sub={`Phase ${current} of ${template.phases.length} in progress · office can complete any phase`}
      noPad
    >
      <div style={{ padding: '10px 0' }}>
        {(overdue.length > 0 || stalledPhases.length > 0) && (
          <div style={{ margin: '0 16px 10px', display: 'flex', gap: 10, alignItems: 'flex-start', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: 8, padding: '10px 12px' }}>
            <AlertTriangle size={16} style={{ color: '#b45309', flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 12.5, color: '#92400e' }}>
              <strong>Escalation.</strong>{' '}
              {overdue.length > 0 && (
                <>{overdue.length} task{overdue.length === 1 ? '' : 's'} past due ({overdue.map((t) => t.label).join(', ')}). </>
              )}
              {stalledPhases.length > 0 && (
                <>Phase {stalledPhases.map((v) => v.phase).join(', ')} stalled &gt; {STALLED_PHASE_THRESHOLD_DAYS} days with no activity.</>
              )}
            </div>
          </div>
        )}

        {needsTruck && (
          <div style={{ margin: '0 16px 10px', display: 'flex', gap: 10, alignItems: 'flex-start', background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.25)', borderRadius: 8, padding: '10px 12px' }}>
            <Truck size={16} style={{ color: '#b91c1c', flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 12.5, color: '#b91c1c' }}>
              <strong>Truck tasks blocked.</strong> Phase 1 is complete, but no truck is assigned to this driver.
              Assign a truck (Drivers → this driver → assign truck) to generate the Phase 2 truck checklist.
            </div>
          </div>
        )}

        {views.map((v) => (
          <PhaseBlock
            key={v.phase}
            view={v}
            open={isOpen(v.phase)}
            isCurrent={v.phase === current}
            onToggle={() => togglePhase(v.phase)}
            onUpload={setUploadTask}
            driverHook={driverHook}
            truckHook={truckHook}
          />
        ))}
      </div>

      {uploadTask && (
        <StaffUploadDialog
          task={uploadTask}
          onClose={() => setUploadTask(null)}
          onDone={async () => {
            setUploadTask(null)
            await (uploadTask.entityType === 'TRUCK' ? truckHook.refresh() : driverHook.refresh())
          }}
        />
      )}
    </Card>
  )
}

// ── One phase (collapsible, split Driver | Office) ───────────────────────────────

interface PhaseBlockProps {
  view: PhaseView
  open: boolean
  isCurrent: boolean
  onToggle: () => void
  onUpload: (t: OnboardingTask) => void
  driverHook: ReturnType<typeof useOnboardingTasks>
  truckHook: ReturnType<typeof useOnboardingTasks>
}

function PhaseBlock({ view, open, isCurrent, onToggle, onUpload, driverHook, truckHook }: PhaseBlockProps) {
  const hookFor = (t: OnboardingTask) => (t.entityType === 'TRUCK' ? truckHook : driverHook)

  return (
    <div style={{ borderBottom: '1px solid var(--ds-border)' }}>
      <button
        onClick={onToggle}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', background: isCurrent ? 'rgba(30,168,243,0.05)' : 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
      >
        {open ? <ChevronDown size={16} style={{ color: 'var(--ds-t3)' }} /> : <ChevronRight size={16} style={{ color: 'var(--ds-t3)' }} />}
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ds-t3)', minWidth: 54 }}>Phase {view.phase}</span>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ds-t1)', flex: 1 }}>{view.title}</span>
        {view.complete && <Badge variant="green">Complete</Badge>}
        {!view.complete && isCurrent && <Badge variant="orange">In progress</Badge>}
        {!view.complete && !isCurrent && (
          <span title="Not visible to the driver yet" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--ds-t3)' }}>
            <Lock size={12} /> Driver-locked
          </span>
        )}
        {view.stalled && <Badge variant="destructive">Stalled</Badge>}
        {view.overdue.length > 0 && <Badge variant="destructive">{view.overdue.length} overdue</Badge>}
        <span style={{ width: 120 }}><ProgressBar value={view.doneCount} max={view.requiredCount} /></span>
      </button>

      {open && (
        <div style={{ padding: '4px 16px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <TaskColumn title="Driver" tasks={view.driverTasks} onUpload={onUpload} hookFor={hookFor} showDriverHint />
          <TaskColumn title="Office" tasks={view.officeTasks} onUpload={onUpload} hookFor={hookFor} />
        </div>
      )}
    </div>
  )
}

// ── A column of tasks (Driver or Office) ─────────────────────────────────────────

interface TaskColumnProps {
  title: string
  tasks: OnboardingTask[]
  onUpload: (t: OnboardingTask) => void
  hookFor: (t: OnboardingTask) => ReturnType<typeof useOnboardingTasks>
  showDriverHint?: boolean
}

function TaskColumn({ title, tasks, onUpload, hookFor, showDriverHint }: TaskColumnProps) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
        {title} <span style={{ fontWeight: 500 }}>· {tasks.length}</span>
      </div>
      {tasks.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--ds-t3)', padding: '6px 0' }}>No tasks.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {tasks.map((t) => <TaskRow key={t.id} task={t} onUpload={onUpload} hook={hookFor(t)} />)}
        </div>
      )}
      {showDriverHint && tasks.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--ds-t3)', marginTop: 6 }}>
          Driver uploads via their portal, or may email documents to hr@bcatcorp.com — staff can also upload on their behalf below.
        </div>
      )}
    </div>
  )
}

function TaskRow({ task, onUpload, hook }: { task: OnboardingTask; onUpload: (t: OnboardingTask) => void; hook: ReturnType<typeof useOnboardingTasks> }) {
  const { user } = useAuth()
  const [assignee, setAssignee] = useState(task.assignee ?? '')
  const done = isTaskDone(task)
  const overdue = !!task.dueDate && !done && task.dueDate < new Date().toISOString().slice(0, 10)
  const help = getRequirement(task.requirementKey)?.helpText

  async function setStatus(status: OnboardingTask['status']) {
    try {
      await hook.changeStatus(task.id, status, { completedBy: user?.email ?? undefined })
    } catch (e) { console.error(e); toast.error('Could not update task') }
  }

  async function saveAssignee() {
    if ((task.assignee ?? '') === assignee.trim()) return
    try { await hook.patchTask(task.id, { assignee: assignee.trim() || null }) }
    catch (e) { console.error(e); toast.error('Could not save assignee') }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--ds-border)' }}>
      <span style={{ flexShrink: 0 }}>
        {done ? <Check size={14} style={{ color: '#16a34a' }} /> : <Circle size={13} style={{ color: 'var(--ds-t3)' }} />}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: 'var(--ds-t1)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span title={help}>{task.label}</span>
          {task.entityType === 'TRUCK' && <Badge variant="secondary"><Truck size={10} style={{ marginRight: 2 }} /> Truck</Badge>}
          {!task.required && <span style={{ fontSize: 10, color: 'var(--ds-t3)' }}>optional</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
          <TaskStatusBadge status={task.status} />
          {task.dueDate && (
            <span style={{ fontSize: 11.5, color: overdue ? '#dc2626' : 'var(--ds-t3)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              {overdue && <AlertTriangle size={11} />} due {task.dueDate} ({daysRemainingLabel(task.dueDate)})
            </span>
          )}
          <input
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            onBlur={saveAssignee}
            placeholder="assign…"
            style={{ fontSize: 11.5, border: '1px solid var(--ds-border)', borderRadius: 5, padding: '1px 6px', width: 96, background: 'var(--ds-surface)', color: 'var(--ds-t2)' }}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        {task.requiresDocument ? (
          <Button size="sm" variant="outline" onClick={() => onUpload(task)} title="Upload / attach document">
            <Upload size={13} /> {done ? 'Replace' : 'Upload'}
          </Button>
        ) : (
          !done && <Button size="sm" variant="outline" onClick={() => setStatus('COMPLETE')} title="Mark complete"><Check size={13} /> Complete</Button>
        )}
        {!done && <Button size="sm" variant="ghost" onClick={() => setStatus('WAIVED')} title="Waive / N/A"><MinusCircle size={13} /></Button>}
      </div>
    </div>
  )
}

// ── Staff upload-on-behalf dialog ────────────────────────────────────────────────
// Creates a ComplianceDocument in PENDING_REVIEW and points the task at it, so the
// upload flows through the existing Review Queue exactly like a portal upload.

function StaffUploadDialog({ task, onClose, onDone }: { task: OnboardingTask; onClose: () => void; onDone: () => void | Promise<void> }) {
  const { user } = useAuth()
  const fileRef = useRef<HTMLInputElement>(null)
  const [expiration, setExpiration] = useState('')
  const [busy, setBusy] = useState(false)
  const req = getRequirement(task.requirementKey)
  const needsExpiration = req?.requiresExpiration ?? task.requiresExpiration

  async function submit() {
    const file = fileRef.current?.files?.[0]
    if (!file) { toast.error('Choose a file'); return }
    if (!isAcceptedDoc(file)) { toast.error('Accepted: PDF/JPG/PNG/HEIC up to 15MB'); return }
    if (needsExpiration && !expiration) { toast.error('Enter the expiration date'); return }
    setBusy(true)
    try {
      const s3Key = await uploadComplianceDocument(task.entityType, task.entityId, task.requirementKey, file)
      const doc = await createComplianceDocument({
        entityType: task.entityType,
        entityId: task.entityId,
        documentType: task.requirementKey,
        title: task.label,
        s3Key,
        expirationDate: expiration || null,
        status: 'PENDING_REVIEW',       // lands in the Review Queue
        uploadedBy: 'INTERNAL',
      })
      // Point the task at the document and move it into review.
      await setTaskStatus(task.id, 'PENDING_REVIEW', { completedBy: user?.email, complianceDocumentId: doc.id })
      await writeComplianceAudit({
        entityType: task.entityType, entityId: task.entityId, action: 'document_uploaded',
        user: user?.email ?? 'unknown',
        changes: { documentType: task.requirementKey, source: 'INTERNAL', onBehalf: true },
      })
      toast.success('Uploaded — sent to the review queue')
      await onDone()
    } catch (e) {
      console.error('[staff upload] failed', e)
      toast.error('Upload failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload on behalf — {task.label}</DialogTitle>
          <DialogDescription>
            {task.entityType === 'TRUCK' ? 'Truck document. ' : 'Driver document. '}
            Uploaded as staff and sent to the compliance review queue for approval.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
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
