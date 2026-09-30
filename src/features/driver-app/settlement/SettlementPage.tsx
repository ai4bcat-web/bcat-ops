import { useEffect, useState } from 'react'
import { AlertCircle, Loader2, RefreshCcw, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  fetchSettlement,
  fetchSettlementWeeks,
  type Settlement,
  type SettlementWeek,
} from '../driverApi'
import { StatementCard } from './StatementCard'
import { weekLabel } from '@/features/driver-pay/week'

export function SettlementPage() {
  const [weeks, setWeeks] = useState<SettlementWeek[] | null>(null)
  const [selectedWeekStart, setSelectedWeekStart] = useState<string | null>(null)
  const [settlement, setSettlement] = useState<Settlement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [weeksRetryKey, setWeeksRetryKey] = useState(0)
  const [statementRetryKey, setStatementRetryKey] = useState(0)

  // If the user hasn't picked a week, default to the newest one returned by the API.
  const selected = selectedWeekStart ?? weeks?.[0]?.weekStart ?? null

  useEffect(() => {
    let stale = false
    fetchSettlementWeeks()
      .then((list) => {
        if (stale) return
        const sorted = [...list].sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1))
        setWeeks(sorted)
      })
      .catch((err) => {
        if (stale) return
        setError(err instanceof Error ? err.message : 'Could not load settlement weeks.')
      })
    return () => {
      stale = true
    }
  }, [weeksRetryKey])

  useEffect(() => {
    if (!selected) return
    let stale = false
    fetchSettlement(selected)
      .then((s) => {
        if (stale) return
        setSettlement(s)
        setError(null)
      })
      .catch((err) => {
        if (stale) return
        setError(err instanceof Error ? err.message : 'Could not load this statement.')
      })
    return () => {
      stale = true
    }
  }, [selected, statementRetryKey])

  const loadingWeeks = weeks === null && error === null
  const loadingStatement =
    selected != null && settlement?.weekStart !== selected && error === null

  const retryWeeks = () => {
    setError(null)
    setWeeks(null)
    setSettlement(null)
    setSelectedWeekStart(null)
    setWeeksRetryKey((k) => k + 1)
  }

  const retryStatement = () => {
    setError(null)
    setSettlement(null)
    setStatementRetryKey((k) => k + 1)
  }

  if (loadingWeeks) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-6 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
        <p>Loading settlements…</p>
      </div>
    )
  }

  if (error && weeks === null) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <AlertCircle className="h-10 w-10 text-destructive" aria-hidden="true" />
        <div>
          <p className="font-medium text-foreground">{error}</p>
          <p className="mt-1 text-sm text-muted-foreground">Tap below to try again.</p>
        </div>
        <Button onClick={() => void retryWeeks()} className="h-11 gap-2 px-6">
          <RefreshCcw className="h-4 w-4" aria-hidden="true" />
          Retry
        </Button>
      </div>
    )
  }

  if (weeks?.length === 0) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <Wallet className="h-12 w-12 text-muted-foreground/60" aria-hidden="true" />
        <div>
          <p className="text-lg font-semibold text-foreground">No settlement data yet</p>
          <p className="mt-1 max-w-xs text-sm text-muted-foreground">
            When your Amazon trips are processed, your weekly statements will show up here.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 py-5">
      <h1 className="mb-4 text-xl font-bold text-foreground">Settlement</h1>

      {weeks && weeks.length > 0 && (
        <div className="mb-4">
          <label htmlFor="week" className="mb-1.5 block text-sm font-medium text-muted-foreground">
            Pay week
          </label>
          <Select value={selected ?? ''} onValueChange={setSelectedWeekStart}>
            <SelectTrigger id="week" className="h-12 w-full text-base">
              <SelectValue placeholder="Choose a week" />
            </SelectTrigger>
            <SelectContent>
              {weeks.map((w) => (
                <SelectItem key={w.weekStart} value={w.weekStart} className="text-base">
                  {weekLabel(w.weekStart)} · {w.tripCount} trip{w.tripCount === 1 ? '' : 's'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-center">
          <p className="font-medium text-destructive">{error}</p>
          <Button
            onClick={() => void retryStatement()}
            variant="outline"
            className="mt-3 h-10 gap-2"
            aria-label="Retry"
          >
            <RefreshCcw className="h-4 w-4" aria-hidden="true" />
            Retry
          </Button>
        </div>
      )}

      {loadingStatement && (
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
          <p>Loading statement…</p>
        </div>
      )}

      {!loadingStatement && settlement && settlement.weekStart === selected && !error && (
        <StatementCard settlement={settlement} />
      )}
    </div>
  )
}
