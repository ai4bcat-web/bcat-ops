/**
 * A running clock across the top of the Ivan app while a shift is open.
 *
 * It sits in the shell rather than on the Hours tab, because the thing it answers — "am I
 * still on the clock, and for how long" — is what a driver wants to know while they are
 * doing something else. On the Hours tab alone it would only be visible to someone who had
 * already gone to check.
 *
 * It also makes a forgotten clock-out visible. An open shift is worth nothing until it
 * closes, so a driver who never clocks out is paid nothing for that day; a counter reading
 * 14:22:09 is the thing that gets noticed.
 */
import { useNavigate } from 'react-router-dom'
import { Clock } from 'lucide-react'
import { useOpenShift, elapsedLabel } from './useOpenShift'

export function OnTheClockBar({ enabled }: { enabled: boolean }) {
  const { shift, seconds } = useOpenShift(enabled)
  const navigate = useNavigate()

  if (!enabled || !shift) return null

  return (
    <button
      type="button"
      onClick={() => navigate('/driver/timeclock')}
      aria-label={`On the clock for ${elapsedLabel(seconds)}. Open your hours.`}
      className="flex shrink-0 items-center justify-center gap-2 border-b border-emerald-500/30 bg-emerald-500/15 px-4 py-2 text-emerald-300"
    >
      {/* A pulse, so a glance at a pocketed phone says "running" without reading it. */}
      <span className="relative flex h-2 w-2" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
      </span>
      <Clock className="h-4 w-4" aria-hidden="true" />
      <span className="text-sm font-semibold">On the clock</span>
      <span className="font-mono text-sm font-bold tabular-nums">{elapsedLabel(seconds)}</span>
    </button>
  )
}
