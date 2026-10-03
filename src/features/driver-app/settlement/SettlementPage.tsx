import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, Loader2, RefreshCcw, Wallet, FilePlus2 } from 'lucide-react'
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
import { UnattachedPods } from '../UnattachedPods'
import { sundayOf, weekLabel } from '@/features/driver-pay/week'

export function SettlementPage() {
  const navigate = useNavigate()
  const [weeks, setWeeks] = useState<SettlementWeek[] | null>(null)
  const [selectedWeekStart, setSelectedWeekStart] = useState<string | null>(null)
  const [settlement, setSettlement] = useState<Settlement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [weeksRetryKey, setWeeksRetryKey] = useState(0)
  const [statementRetryKey, setStatementRetryKey] = useState(0)

  const currentWeekStart = sundayOf()

  /*
   * The picker must always offer THIS week, even before any trip has been
   * processed for it. Without this, a driver opening the app on a Sunday or
   * Monday landed on last week's statement with nothing saying so, and read a
   * finished check as their current pay.
   */
  const weekOptions = useMemo(() => {
    if (!weeks || weeks.length === 0) return weeks
    if (weeks.some((w) => w.weekStart === currentWeekStart)) return weeks
    return [{ weekStart: currentWeekStart, gross: 0, net: 0, tripCount: 0 }, ...weeks]
  }, [weeks, currentWeekStart])

  // Default to the current week by name, not merely to the newest row returned.
  const selected =
    selectedWeekStart ??
    weekOptions?.find((w) => w.weekStart === currentWeekStart)?.weekStart ??
    weekOptions?.[0]?.weekStart ??
    null
  const viewingPastWeek = selected != null && selected !== currentWeekStart

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
            When your trips are processed, your weekly statements will show up here.
          </p>
        </div>
        {/* Having no statement yet is the most likely reason a driver is holding paperwork
            for a load nobody has built. They must not be stuck here. */}
        <Button
          className="h-14 w-full max-w-xs gap-2 text-base font-semibold"
          onClick={() => navigate('/driver/scan?kind=pod')}
        >
          <FilePlus2 className="h-5 w-5" />
          Send a POD anyway
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 py-5">
      <h1 className="mb-4 text-xl font-bold text-foreground">Settlement</h1>

      {weekOptions && weekOptions.length > 0 && (
        <div className="mb-4">
          <label htmlFor="week" className="mb-1.5 block text-sm font-medium text-muted-foreground">
            Pay week
          </label>
          <Select value={selected ?? ''} onValueChange={setSelectedWeekStart}>
            <SelectTrigger id="week" className="h-12 w-full text-base">
              <SelectValue placeholder="Choose a week" />
            </SelectTrigger>
            <SelectContent>
              {weekOptions.map((w) => (
                <SelectItem key={w.weekStart} value={w.weekStart} className="text-base">
                  {weekLabel(w.weekStart)}
                  {w.weekStart === currentWeekStart ? ' · This week' : ''} ·{' '}
                  {w.tripCount} trip{w.tripCount === 1 ? '' : 's'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* A past statement is already paid, so say so plainly — a driver must never
              mistake last week's settled check for what they are earning now. */}
          {viewingPastWeek && (
            <div className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-muted/60 px-3 py-2">
              <p className="text-sm text-muted-foreground">Viewing a past pay week</p>
              <Button
                variant="outline"
                className="h-9 shrink-0 px-3 text-sm"
                onClick={() => setSelectedWeekStart(currentWeekStart)}
              >
                This week
              </Button>
            </div>
          )}
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

      {/* Paperwork with nowhere to go yet, and the way to send more of it. Both live here
          because this is the only page a driver has: a POD for a load the office has not
          built cannot be sent from a row that does not exist. */}
      <div className="mt-5 flex flex-col gap-3">
        <UnattachedPods />

        <div className="rounded-xl border border-dashed border-border p-4">
          <h2 className="text-sm font-semibold text-foreground">
            Paperwork for a load that is not listed?
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Send it now and pick its load later, or let the office match it. Nothing waits on
            the load being built first.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <Button
              className="h-12 w-full justify-start gap-2 text-base"
              onClick={() => navigate('/driver/scan?kind=pod')}
            >
              <FilePlus2 className="h-4 w-4" />
              Send a POD
            </Button>
            <Button
              variant="outline"
              className="h-12 w-full justify-start gap-2 text-base"
              onClick={() => navigate('/driver/scan?kind=ratecon')}
            >
              <FilePlus2 className="h-4 w-4" />
              Send a rate confirmation
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
