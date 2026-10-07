import * as React from 'react'
import type { FactoringFields, Settlement, SettlementLine, SettlementTrip } from '../driverApi'
import { ShipmentRows } from './ShipmentRows'
import { weekLabel } from '@/features/driver-pay/week'

type TripWithFactoring = SettlementTrip & {
  factoring?: FactoringFields | null
  /** Set when this load is not on the check yet, e.g. its POD is still missing. */
  heldReason?: string | null
  heldLabel?: string | null
}

// Matches the formatter used by the staff DriverPayPage surface so drivers see
// identical numbers. See src/features/driver-pay/DriverPayPage.tsx.
function money(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

function lineTotal(lines: SettlementLine[]): number {
  return lines.reduce((sum, line) => sum + line.amount, 0)
}

interface StatementCardProps {
  settlement: Settlement
  /**
   * True when this is the staff preview on the owner-operator settlements rather than the
   * driver's own app. The paperwork controls become labels — they lead into the driver's
   * upload screen, which is not where a staff member belongs.
   */
  readOnly?: boolean
}

export function StatementCard({ settlement, readOnly = false }: StatementCardProps) {
  const totalDeductions = lineTotal(settlement.deductions)
  const totalCredits = lineTotal(settlement.credits)
  const totalDebits = lineTotal(settlement.debits)
  const checkPositive = settlement.checkAmount >= 0

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 border-b border-border p-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Pay week
          </p>
          <p className="mt-0.5 truncate text-base font-semibold text-card-foreground">
            {weekLabel(settlement.weekStart)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Check amount
          </p>
          <p
            className={`mt-0.5 text-xl font-bold tabular-nums ${
              checkPositive ? 'text-[var(--ds-green)]' : 'text-[var(--ds-red)]'
            }`}
          >
            {money(settlement.checkAmount)}
          </p>
        </div>
      </div>

      {/* Trips, as rows a driver can act on. The document cells are the actions. */}
      <div className="border-b border-border py-3">
        <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Shipments · {settlement.trips.length}
        </p>
        <ShipmentRows
          trips={settlement.trips as TripWithFactoring[]}
          readOnly={readOnly}
          grossFreight={settlement.grossPay}
          driverAmount={settlement.driverAmount}
          payPercent={settlement.payPercent}
          heldFreight={settlement.heldFreight}
        />
      </div>

      {/* Deductions */}
      <Section title="Deductions">
        {settlement.deductions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No deductions this week.</p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {settlement.deductions.map((line, i) => {
                const refund = line.amount < 0
                return (
                  <div key={`${line.label}-${i}`} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate text-sm text-card-foreground">
                      {line.label}
                    </span>
                    <span
                      className={`whitespace-nowrap text-sm font-semibold tabular-nums ${
                        refund ? 'text-[var(--ds-green)]' : 'text-[var(--ds-red)]'
                      }`}
                    >
                      {refund ? `+${money(-line.amount)}` : `(${money(line.amount)})`}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="mt-3 flex items-center justify-between gap-4 border-t border-border pt-2">
              <span className="text-sm font-semibold text-card-foreground">Total deductions</span>
              <span className="text-sm font-bold tabular-nums text-[var(--ds-red)]">
                ({money(totalDeductions)})
              </span>
            </div>
          </>
        )}
      </Section>

      {/* Credits */}
      <Section title="Credits">
        {settlement.credits.length === 0 ? (
          <p className="text-sm text-muted-foreground">No credits this week.</p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {settlement.credits.map((line, i) => (
                <div key={`${line.label}-${i}`} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm text-card-foreground">
                    {line.label}
                  </span>
                  <span className="whitespace-nowrap text-sm font-semibold tabular-nums text-[var(--ds-green)]">
                    +{money(line.amount)}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between gap-4 border-t border-border pt-2">
              <span className="text-sm font-semibold text-card-foreground">Total credits</span>
              <span className="text-sm font-bold tabular-nums text-[var(--ds-green)]">
                +{money(totalCredits)}
              </span>
            </div>
          </>
        )}
      </Section>

      {/* Debits */}
      {settlement.debits.length > 0 && (
        <Section title="Debits (after net)">
          <div className="flex flex-col gap-2">
            {settlement.debits.map((line, i) => (
              <div key={`${line.label}-${i}`} className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 truncate text-sm text-card-foreground">
                  {line.label}
                </span>
                <span className="whitespace-nowrap text-sm font-semibold tabular-nums text-[var(--ds-red)]">
                  −{money(line.amount)}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between gap-4 border-t border-border pt-2">
            <span className="text-sm font-semibold text-card-foreground">Total debits</span>
            <span className="text-sm font-bold tabular-nums text-[var(--ds-red)]">
              −{money(totalDebits)}
            </span>
          </div>
        </Section>
      )}

      {/* Final total */}
      <div className="flex items-center justify-between gap-4 bg-secondary/50 p-4">
        <span className="text-sm font-bold uppercase tracking-wider text-card-foreground">
          Check amount
        </span>
        <span
          className={`text-2xl font-bold tabular-nums ${
            checkPositive ? 'text-[var(--ds-green)]' : 'text-[var(--ds-red)]'
          }`}
        >
          {money(settlement.checkAmount)}
        </span>
      </div>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="border-b border-border p-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  )
}
