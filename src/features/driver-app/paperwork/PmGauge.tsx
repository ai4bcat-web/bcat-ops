/**
 * How far this driver's truck is from its next PM.
 *
 * A bar rather than the line of text it replaces, because "7,400 mi" means nothing on its
 * own — it is only informative against the 25,000-mile interval it is a fraction of. The
 * bar fills from the last PM to the next, so a glance says "most of the way there" without
 * reading a number at all.
 *
 * Colours match the fleet manager's dashboard on purpose: amber inside 2,000 miles, red
 * when overdue. A driver and the office looking at the same truck should see the same
 * colour, or the two of them are having different conversations about it.
 */
import { Wrench } from 'lucide-react'
import type { DriverPm } from '../driverApi'
import { PM_INTERVAL_MI } from '@/lib/pmDue'

const nf = new Intl.NumberFormat('en-US')

/**
 * How much of the interval has been used, 0–1.
 *
 * Clamped at both ends: an overdue truck fills the bar rather than overflowing it, and a
 * truck whose odometer reads below its last PM (a replaced ECM, a bad reading) shows empty
 * rather than a negative bar.
 */
function fraction(pm: DriverPm): number | null {
  if (pm.remaining == null || pm.nextDueAt == null) return null
  const used = PM_INTERVAL_MI - pm.remaining
  return Math.max(0, Math.min(1, used / PM_INTERVAL_MI))
}

export function PmGauge({ pm }: { pm: DriverPm }) {
  const pct = fraction(pm)

  const tone =
    pm.state === 'OVERDUE'
      ? { bar: 'bg-red-500', text: 'text-red-300', ring: 'border-red-500/30 bg-red-500/10' }
      : pm.state === 'DUE_SOON'
        ? { bar: 'bg-amber-500', text: 'text-amber-300', ring: 'border-amber-500/30 bg-amber-500/10' }
        : { bar: 'bg-emerald-500', text: 'text-foreground', ring: 'border-border bg-muted/40' }

  return (
    <div className={`mb-4 rounded-xl border p-3 ${tone.ring}`}>
      <div className="flex items-start gap-2">
        <Wrench className={`mt-0.5 h-4 w-4 shrink-0 ${tone.text}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${tone.text}`}>
            {pm.state === 'OVERDUE'
              ? `PM overdue by ${nf.format(Math.abs(pm.remaining ?? 0))} mi`
              : pm.remaining != null
                ? `${nf.format(pm.remaining)} mi to next PM`
                : pm.label}
          </p>

          {/*
            Only drawn when there is a real position to draw. An UNKNOWN truck — no last PM
            recorded, or no odometer from Motive — gets the sentence and no bar, because an
            empty bar reads as "nearly new" rather than "we do not know".
          */}
          {pct != null && (
            <div
              className="mt-2 h-2 w-full overflow-hidden rounded-full bg-black/10"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={PM_INTERVAL_MI}
              aria-valuenow={Math.round(pct * PM_INTERVAL_MI)}
              aria-label="Miles used since last PM"
            >
              <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${pct * 100}%` }} />
            </div>
          )}

          <p className="mt-1.5 text-xs text-muted-foreground">
            {[
              pm.truckNumber ? `Truck ${pm.truckNumber}` : null,
              pm.currentOdometer != null ? `${nf.format(pm.currentOdometer)} mi` : null,
              pm.nextDueAt != null ? `due at ${nf.format(pm.nextDueAt)}` : null,
              pm.lastPmDate ? `last PM ${pm.lastPmDate}` : null,
            ].filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>
    </div>
  )
}
