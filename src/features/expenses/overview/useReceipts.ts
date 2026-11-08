import { useEffect, useState } from 'react'
import { listDriverPayCredits, listDriverPayDeductions, listTimeClockEntries } from '@/lib/apiClient'
import type { DriverPayCredit, DriverPayDeduction } from '@/lib/apiClient'
import { errorText } from '@/lib/errorText'
import { useVendorPayables } from '@/hooks/useVendorPayables'
import type { TimeClockEntry } from '@/types'
import type { VendorPayable } from '@/types/vendorAp'

export interface ReceiptSources {
  deductions: DriverPayDeduction[]
  credits: DriverPayCredit[]
  payables: VendorPayable[]
  getAttachmentUrl: (key: string) => Promise<string>
  loading: boolean
  /** Named read failures; a failed source is reported, never silently empty. */
  errors: string[]
}

/**
 * The receipt inputs `useFleetProfitability` does not already hand over: driver-pay charges
 * (read once) and vendor payables (the Vendor AP hook, which also resolves attachment URLs).
 */
export function useReceiptSources(): ReceiptSources {
  const payables = useVendorPayables()
  const [pay, setPay] = useState<{ deductions: DriverPayDeduction[]; credits: DriverPayCredit[] } | null>(null)
  const [payError, setPayError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    Promise.all([listDriverPayDeductions(), listDriverPayCredits()])
      .then(([deductions, credits]) => { if (live) setPay({ deductions, credits }) })
      .catch((err: unknown) => { if (live) setPayError(errorText(err)) })
    return () => { live = false }
  }, [])

  const errors: string[] = []
  if (payError) errors.push(`Driver-pay charges: ${payError}`)
  if (payables.error) errors.push(`Vendor payables: ${payables.error}`)

  return {
    deductions: pay?.deductions ?? [],
    credits: pay?.credits ?? [],
    payables: payables.items,
    getAttachmentUrl: payables.getAttachmentUrl,
    loading: (pay === null && payError === null) || payables.loading,
    errors,
  }
}

export interface TimeClockState {
  entries: TimeClockEntry[]
  loading: boolean
  error: string | null
}

/** Time-clock rows for one date window (the current pay period). */
export function useTimeClockEntries(from: string, to: string): TimeClockState {
  const window = `${from}|${to}`
  const [done, setDone] = useState<{ window: string; entries: TimeClockEntry[]; error: string | null } | null>(null)

  useEffect(() => {
    let live = true
    listTimeClockEntries({ from, to })
      .then((entries) => { if (live) setDone({ window, entries, error: null }) })
      .catch((err: unknown) => { if (live) setDone({ window, entries: [], error: errorText(err) }) })
    return () => { live = false }
  }, [from, to, window])

  const current = done && done.window === window ? done : null
  return { entries: current?.entries ?? [], loading: current === null, error: current?.error ?? null }
}
