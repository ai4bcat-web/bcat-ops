/**
 * A driver reports a problem with their truck — a light, a brake, a leak — and sees what
 * the shop has open on that unit. The report becomes an ordinary maintenance task on the
 * truck, the same row the office creates from the Maintenance page, so it lands where
 * the shop already looks rather than in a message somebody has to copy over.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { listMaintenanceTasks, reportMaintenanceTask, type DriverMaintenanceTask, type DriverTruck } from './driverApi'
import { useDriverTruck } from './useDriverProgram'
import { errorText } from '@/lib/errorText'

const PRIORITY: Array<{ id: 'high' | 'med' | 'low'; label: string; hint: string }> = [
  { id: 'high', label: 'Urgent', hint: 'Unsafe to drive, or will be soon' },
  { id: 'med', label: 'Soon', hint: 'Needs looking at this week' },
  { id: 'low', label: 'When convenient', hint: 'Next time it is in the shop' },
]

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function ReportIssue() {
  const { truck } = useDriverTruck()
  const [open, setOpen] = useState(false)
  const [tasks, setTasks] = useState<DriverMaintenanceTask[] | null>(null)
  const [taskTruck, setTaskTruck] = useState<DriverTruck | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let stale = false
    listMaintenanceTasks()
      .then((r) => { if (!stale) { setTasks(r.tasks); setTaskTruck(r.truck) } })
      .catch(() => { if (!stale) setTasks([]) })
    return () => { stale = true }
  }, [reloadKey, truck?.id])

  const openTasks = (tasks ?? []).filter((t) => t.status !== 'complete')
  const mine = (tasks ?? []).filter((t) => t.reportedByMe)

  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Wrench className="h-4 w-4 text-primary" aria-hidden="true" />
          Truck issues{taskTruck ? ` · ${taskTruck.unitNumber}` : ''}
          {openTasks.length > 0 && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-bold text-amber-200">{openTasks.length} open</span>
          )}
        </p>
        <Button size="sm" className="h-9 font-bold" onClick={() => setOpen(true)}>Report a problem</Button>
      </div>
      {tasks && mine.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {mine.slice(0, 5).map((t) => (
            <li key={t.id} className="flex items-start gap-2 text-sm">
              {t.status === 'complete'
                ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" />
                : <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${t.priority === 'high' ? 'text-red-300' : 'text-amber-300'}`} aria-hidden="true" />}
              <span className="min-w-0 flex-1">
                <span className={`block ${t.status === 'complete' ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{t.title}</span>
                <span className="block text-xs text-muted-foreground">
                  {t.status === 'complete' ? `Done${t.completedDate ? ` ${when(t.completedDate)}` : ''}` : `Reported ${when(t.createdAt)} · with the shop`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <ReportIssueDialog open={open} onClose={() => setOpen(false)} onReported={() => setReloadKey((k) => k + 1)} />
    </div>
  )
}

export function ReportIssueDialog({ open, onClose, onReported }: { open: boolean; onClose: () => void; onReported?: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="dark max-h-[90dvh] overflow-y-auto bg-background text-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle>What's wrong with the truck?</DialogTitle>
        </DialogHeader>
        {open && <ReportForm onClose={onClose} onReported={onReported} />}
      </DialogContent>
    </Dialog>
  )
}

function ReportForm({ onClose, onReported }: { onClose: () => void; onReported?: () => void }) {
  const { truck } = useDriverTruck()
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [priority, setPriority] = useState<'high' | 'med' | 'low'>('med')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    try {
      const res = await reportMaintenanceTask({ title: title.trim(), notes: notes.trim() || undefined, priority, truckId: truck?.id })
      toast.success(`Reported on truck ${res.task.truck.unitNumber} — the shop has it`)
      onReported?.()
      onClose()
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!truck && (
        <p className="rounded-lg border border-amber-400/50 bg-amber-500/15 p-3 text-sm text-amber-100">
          Pick your truck first so the shop knows which unit this is about.
        </p>
      )}
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-muted-foreground">The problem</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Driver-side low beam out"
          aria-label="The problem"
          className="h-12 w-full rounded-md border border-input bg-background px-3 text-base text-foreground"
        />
      </label>
      <div>
        <span className="mb-1 block text-sm font-medium text-muted-foreground">How urgent</span>
        <div className="flex flex-col gap-2">
          {PRIORITY.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPriority(p.id)}
              aria-pressed={priority === p.id}
              className={`rounded-lg border p-3 text-left ${priority === p.id ? 'border-primary bg-primary/10' : 'border-border bg-card'}`}
            >
              <span className="block text-sm font-semibold text-foreground">{p.label}</span>
              <span className="block text-xs text-muted-foreground">{p.hint}</span>
            </button>
          ))}
        </div>
      </div>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-muted-foreground">Details (optional)</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="When it started, what it does, anything the shop should know"
          aria-label="Details"
          className="min-h-[80px] w-full rounded-md border border-input bg-background p-3 text-sm text-foreground"
        />
      </label>
      <Button className="h-12 w-full text-base font-bold" disabled={busy || !title.trim() || !truck} onClick={() => void submit()}>
        {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : 'Send to the shop'}
      </Button>
    </div>
  )
}
