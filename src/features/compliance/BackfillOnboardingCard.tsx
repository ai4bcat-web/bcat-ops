import { useState } from 'react'
import { Layers, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { useAppStore } from '@/store/useAppStore'
import { listTruckConfigs, upsertTruckConfig } from '@/lib/apiClient'
import { generateChecklist } from '@/lib/complianceClient'
import type { TruckOwnershipType } from '@/lib/complianceRequirements'
import type { Ownership } from '@/types/equipment'
import { Card } from './components'

const OWNERSHIP_MAP: Record<Ownership, TruckOwnershipType> = {
  owned: 'COMPANY', financed: 'COMPANY', leased: 'LEASED', rented: 'LEASED',
}

interface Result {
  driversProcessed: number
  driversSkipped: number
  trucksProcessed: number
  tasksCreated: number
}

/**
 * Owner-only: generate compliance checklists (internal only — no portal invites)
 * for existing drivers and trucks that don't have one yet. Idempotent and re-runnable.
 */
export function BackfillOnboardingCard() {
  const drivers = useAppStore((s) => s.drivers)
  const equipment = useAppStore((s) => s.equipment)
  const updateDriver = useAppStore((s) => s.updateDriver)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<Result | null>(null)

  const classifiedDrivers = drivers.filter((d) => d.driverType === 'COMPANY' || d.driverType === 'OWNER_OPERATOR')
  const unclassifiedDrivers = drivers.filter((d) => !d.driverType)
  const trucks = equipment.filter((e) => e.type === 'truck')

  async function run() {
    setConfirmOpen(false)
    setRunning(true)
    const res: Result = { driversProcessed: 0, driversSkipped: unclassifiedDrivers.length, trucksProcessed: 0, tasksCreated: 0 }
    try {
      const configs = await listTruckConfigs()
      const configByTruck = new Map(configs.map((c) => [c.truckId, c]))

      for (const d of classifiedDrivers) {
        try {
          const { created } = await generateChecklist({ entityType: 'DRIVER', entityId: d.id, classification: d.driverType! })
          res.tasksCreated += created
          res.driversProcessed++
          if (d.onboardingStatus !== 'COMPLETE') await updateDriver(d.id, { onboardingStatus: 'IN_PROGRESS' })
        } catch (e) { console.error('[backfill driver]', d.id, e) }
      }

      for (const t of trucks) {
        try {
          const classification = OWNERSHIP_MAP[t.ownership] ?? 'COMPANY'
          const { created } = await generateChecklist({ entityType: 'TRUCK', entityId: t.id, classification })
          res.tasksCreated += created
          res.trucksProcessed++
          const existing = configByTruck.get(t.id)
          if (existing?.onboardingStatus !== 'COMPLETE') {
            await upsertTruckConfig({ truckId: t.id, unitNumber: t.unitNumber, ownershipType: classification, onboardingStatus: 'IN_PROGRESS' })
          }
        } catch (e) { console.error('[backfill truck]', t.id, e) }
      }

      setResult(res)
      toast.success(`Backfill complete — ${res.tasksCreated} checklist items created`)
    } catch (e) {
      console.error('[backfill]', e)
      toast.error('Backfill failed — see console')
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card title="Backfill onboarding checklists" sub="One-time: generate checklists for your current fleet (internal only — no invites)">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--ds-t2)' }}>
          Ready to process <strong>{classifiedDrivers.length}</strong> classified driver(s) and <strong>{trucks.length}</strong> truck(s).
          {unclassifiedDrivers.length > 0 && (
            <> <span style={{ color: '#b45309' }}>{unclassifiedDrivers.length} unclassified driver(s) will be skipped</span> — set their type first.</>
          )}
        </div>

        {result && (
          <div style={{ fontSize: 13, color: 'var(--ds-t1)', background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 8, padding: '10px 12px' }}>
            Processed {result.driversProcessed} drivers, {result.trucksProcessed} trucks · {result.tasksCreated} new items · {result.driversSkipped} drivers skipped (unclassified).
          </div>
        )}

        <div>
          <Button onClick={() => setConfirmOpen(true)} disabled={running}>
            {running ? <Loader2 className="animate-spin" size={15} /> : <Layers size={15} />}
            {running ? 'Generating…' : 'Generate checklists'}
          </Button>
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate checklists for the current fleet?</DialogTitle>
            <DialogDescription>
              This creates internal compliance checklists for {classifiedDrivers.length} driver(s) and {trucks.length} truck(s).
              No portal invites are sent. It's safe to re-run — existing items are skipped.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button onClick={run}>Run backfill</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
