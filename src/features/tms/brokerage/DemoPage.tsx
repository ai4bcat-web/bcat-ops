/**
 * Step P11 — My Brokerage → Demo.
 *
 * The eleven demo steps in order, each with a live checklist tick and a button that
 * opens the seeded record on the right screen. Reset and Seed buttons restore the P1
 * seed through the same actions the demo itself uses.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, RotateCcw, Play } from 'lucide-react'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import { getDemoState, resetDemoData, seedDemoData } from '@/lib/apiClient'
import type { DemoState } from '@/lib/apiClient'
import { DEMO_STEPS, demoChecklist, type DemoStepDef } from '@/lib/demoFlow'

function stepTarget(
  step: DemoStepDef,
  recordId: string | undefined,
): { to: string; search?: string } | null {
  if (!recordId || !step.opensOn) return null
  const prefix = step.opensOn.split('.')[0]
  if (prefix === 'shipment') {
    const search = step.tab ? `?tab=${step.tab}` : undefined
    return { to: `/tms/shipments/${recordId}`, search }
  }
  if (prefix === 'customer') {
    return { to: '/tms/customers', search: `?customer=${recordId}` }
  }
  if (prefix === 'quote') {
    return { to: `/tms/rates/${recordId}` }
  }
  return null
}

function StepRow({
  step,
  done,
  evidence,
  recordId,
  onOpen,
}: {
  step: DemoStepDef
  done: boolean
  evidence: string
  recordId: string | undefined
  onOpen: (target: { to: string; search?: string }) => void
}) {
  const target = useMemo(() => stepTarget(step, recordId), [step, recordId])
  const missing = step.opensOn != null && recordId == null

  return (
    <div className="tms-demo-step">
      <div className="tms-demo-step-main">
        <div className="tms-demo-step-head">
          <span className={`tms-demo-tick${done ? '' : ' tms-demo-tick-off'}`} aria-hidden="true">
            <Check size={12} strokeWidth={3} />
          </span>
          <h3 className="tms-demo-step-title">{step.title}</h3>
        </div>
        <div className="tms-demo-step-see">{step.whatYouSee}</div>
        {missing ? (
          <div className="tms-demo-step-missing">Seeded record not found — run Seed demo data first.</div>
        ) : null}
        <div className="tms-demo-evidence">{evidence}</div>
      </div>
      <TmsButton
        size="sm"
        disabled={!target}
        onClick={() => target && onOpen(target)}
      >
        Open
      </TmsButton>
    </div>
  )
}

/** What the page shows when the demo-state read itself fails: everything unseeded. */
const FALLBACK_STATE: DemoState = {
  seedVersion: null,
  seededAt: null,
  devStack: false,
  records: [],
  facts: {
    shipmentCount: 0,
    staffCount: 0,
    assignedCount: 0,
    customersWithFlowDefaults: 0,
    quotesWithMarketRate: 0,
    buildingShipments: 0,
    activePostings: 0,
    carrierOffers: 0,
    shipmentsWithThread: 0,
    checkCallMessages: 0,
    podReviews: 0,
    readyForBilling: 0,
    releasedToBilling: 0,
    seedVersion: null,
  },
}

export function DemoPage() {
  const navigate = useNavigate()
  const { isOwner, isAdmin } = useAuth()
  const [state, setState] = useState<DemoState | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const canManage = (isOwner || isAdmin) && (state?.devStack ?? false)

  // Refresh after a seed/reset; the mount read below is the only effect-driven one.
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await getDemoState()
      setState(next)
    } catch {
      // Surface the failure in the UI instead of swallowing it.
      setState(FALLBACK_STATE)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let live = true
    getDemoState()
      .then((next) => { if (live) setState(next) })
      .catch(() => { if (live) setState(FALLBACK_STATE) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])

  const handleOpen = useCallback((target: { to: string; search?: string }) => {
    navigate(`${target.to}${target.search ?? ''}`)
  }, [navigate])

  const handleReset = useCallback(async () => {
    setConfirmOpen(false)
    setLoading(true)
    try {
      await resetDemoData()
      await load()
    } finally {
      setLoading(false)
    }
  }, [load])

  const handleSeed = useCallback(async () => {
    setLoading(true)
    try {
      await seedDemoData()
      await load()
    } finally {
      setLoading(false)
    }
  }, [load])

  const rows = useMemo(
    () => (state ? demoChecklist(state.facts) : []),
    [state],
  )

  const seeded = Boolean(state?.seedVersion)

  return (
    <div>
      <div className="tms-demo-head">
        <div>
          <h2 className="tms-demo-title">End-to-end demo</h2>
          <p className="tms-demo-step-see">
            {seeded
              ? `Seed ${state?.seedVersion} · ${state?.facts.shipmentCount ?? 0} shipments`
              : 'No demo data seeded yet.'}
          </p>
        </div>
        <div className="tms-demo-actions">
          {canManage && seeded ? (
            <TmsButton
              variant="destructive"
              size="sm"
              disabled={loading}
              onClick={() => setConfirmOpen(true)}
            >
              <RotateCcw size={14} style={{ marginRight: 6 }} />
              Reset demo data
            </TmsButton>
          ) : null}
          {canManage && !seeded ? (
            <TmsButton size="sm" disabled={loading} onClick={handleSeed}>
              <Play size={14} style={{ marginRight: 6 }} />
              Seed demo data
            </TmsButton>
          ) : null}
        </div>
      </div>

      {!canManage ? (
        <p className="tms-demo-reason">
          {!(isOwner || isAdmin)
            ? 'Reset and Seed are owner/ADMIN only.'
            : 'Demo data controls are hidden because this is not the dev stack.'}
        </p>
      ) : null}

      {state == null ? (
        <div className="tms-demo-empty">Loading demo state…</div>
      ) : (
        <div className="tms-demo-list">
          {DEMO_STEPS.map((step, i) => {
            const record = step.opensOn
              ? state.records.find((r) => r.kind === step.opensOn!.split('.')[0] && r.demoKey === step.opensOn)
              : undefined
            const checklist = rows[i]
            return (
              <StepRow
                key={step.key}
                step={step}
                done={checklist?.done ?? false}
                evidence={checklist?.evidence ?? ''}
                recordId={record?.recordId}
                onOpen={handleOpen}
              />
            )
          })}
        </div>
      )}

      <TmsDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Reset demo data?"
        description="This restores every seeded record to its original P1 state. Shipments are voided, never deleted, and re-seeded fresh."
        footer={
          <div className="tms-demo-actions">
            <TmsButton size="sm" variant="secondary" onClick={() => setConfirmOpen(false)}>
              Cancel
            </TmsButton>
            <TmsButton size="sm" variant="destructive" onClick={handleReset} disabled={loading}>
              Reset
            </TmsButton>
          </div>
        }
      />
    </div>
  )
}

export default DemoPage
