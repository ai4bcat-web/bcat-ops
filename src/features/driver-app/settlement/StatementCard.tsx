import * as React from 'react'
import { FileText } from 'lucide-react'
import type { Settlement, SettlementLine } from '../driverApi'
import { weekLabel } from '@/features/driver-pay/week'

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
}

export function StatementCard({ settlement }: StatementCardProps) {
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

      {/* Trips */}
      <div className="border-b border-border p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Trips · {settlement.trips.length}
        </p>

        {settlement.trips.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center text-muted-foreground">
            <FileText className="h-8 w-8 opacity-40" aria-hidden="true" />
            <p>No trips this week</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {settlement.trips.map((trip) => {
              const route = [trip.origin, trip.destination].filter(Boolean).join(' → ') || undefined
              return (
                <div
                  key={trip.id}
                  className="flex flex-col gap-1 rounded-lg border border-border/60 bg-background/50 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-card-foreground">
                      {trip.loadId ?? '—'}
                    </span>
                    <span className="whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(`${trip.date}T12:00:00Z`).toLocaleDateString('en-US', {
                        month: 'numeric',
                        day: 'numeric',
                        timeZone: 'UTC',
                      })}
                    </span>
                  </div>
                  {route && <p className="truncate text-xs text-muted-foreground">{route}</p>}
                  <div className="mt-1 flex items-center justify-between gap-2 text-sm">
                    <div className="flex min-w-0 gap-3 text-muted-foreground">
                      <span>
                        {trip.miles != null ? `${trip.miles.toLocaleString()} mi` : '—'}
                      </span>
                      <span>{trip.rate != null ? money(trip.rate) : '—'}</span>
                    </div>
                    <span className="whitespace-nowrap font-semibold tabular-nums text-card-foreground">
                      {money(trip.amount)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Gross */}
      <div className="flex items-center justify-between gap-4 border-b border-border p-4">
        <span className="text-sm font-semibold text-card-foreground">Gross pay</span>
        <span className="text-base font-bold tabular-nums text-card-foreground">
          {money(settlement.grossPay)}
        </span>
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
