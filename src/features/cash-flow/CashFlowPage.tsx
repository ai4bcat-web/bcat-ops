import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useCashFlow } from '@/hooks/useCashFlow'
import { totalCashCents, totalPayablesCents, suggestedPayablesSpread } from '@/lib/cashFlow'
import { CashFlowInputsCard } from './CashFlowInputsCard'
import { CashFlowRunway } from './CashFlowRunway'
import { CashFlowWeeklyLog } from './CashFlowWeeklyLog'

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
      <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ds-t3)', margin: 0, whiteSpace: 'nowrap' }}>
        {children}
      </h2>
      <div style={{ flex: 1, height: 1, background: 'var(--ds-border)' }} />
    </div>
  )
}

function Banner({ tone, children }: { tone: 'warn' | 'error'; children: React.ReactNode }) {
  const color = tone === 'error' ? '#b91c1c' : '#b45309'
  return (
    <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '11px 14px', borderRadius: 10,
      border: `1px solid ${color}33`, background: `${color}0f` }}>
      <AlertTriangle size={15} style={{ color, flexShrink: 0, marginTop: 1 }} />
      <div style={{ fontSize: 12.5, color, lineHeight: 1.55 }}>{children}</div>
    </div>
  )
}

/**
 * Cash Flow — how much runway BCAT + IVAN have, from figures entered weekly.
 *
 * Deliberately disconnected from the rest of BCAT Ops: it reads no loads, invoices,
 * expenses or ledgers. Every figure is typed in each week and stored in this page's own
 * two tables (CashFlowInputs, CashFlowWeekLog). That isolation is the point — it mirrors
 * an Excel model the operator maintains by hand, so live data would change its meaning.
 */
export function CashFlowPage() {
  const isMobile = useIsMobile()
  const cf = useCashFlow()

  const save = async () => {
    try {
      await cf.save()
      toast.success('Inputs saved')
    } catch {
      toast.error("Couldn't save the inputs")
    }
  }

  const logWeek = async () => {
    try {
      await cf.logThisWeek()
      toast.success(`Logged the week of ${cf.inputs.weekOf.slice(0, 10)}`)
    } catch (err) {
      toast.error(`Couldn't log this week: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  const removeWeek = async (id: string) => {
    try {
      await cf.removeWeek(id)
      toast.success('Week removed')
    } catch {
      toast.error("Couldn't remove that week")
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: isMobile ? '16px 12px' : '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>
            Cash Flow
          </h1>
          <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>
            How much runway BCAT and IVAN have — entered by hand, separate from the rest of Ops
          </p>
        </div>

        {cf.backendMissing && (
          <Banner tone="warn">
            The Cash Flow tables aren't in the deployed backend yet, so nothing on this page will
            save. Everything below still calculates from the starter figures — deploy the Amplify
            backend (the two new <code>CashFlow*</code> models) to turn on saving.
          </Banner>
        )}
        {cf.error && <Banner tone="error">{cf.error}</Banner>}

        <SectionHeading>Weekly inputs</SectionHeading>
        <CashFlowInputsCard
          inputs={cf.inputs}
          totalCash={totalCashCents(cf.inputs)}
          totalPayables={totalPayablesCents(cf.inputs)}
          dirty={cf.dirty}
          saving={cf.saving}
          disabled={cf.backendMissing || cf.loading}
          onField={cf.setField}
          onSave={() => void save()}
        />

        <SectionHeading>Runway</SectionHeading>
        <CashFlowRunway runway={cf.runway}
          suggestedSpread={suggestedPayablesSpread(cf.inputs)}
          currentSpread={cf.inputs.payablesSpreadMonths || 1} />

        <SectionHeading>History</SectionHeading>
        <CashFlowWeeklyLog
          weeks={cf.weeks}
          disabled={cf.backendMissing || cf.loading}
          onLog={logWeek}
          onDelete={removeWeek}
        />
      </div>
    </div>
  )
}
