import { useMemo, useState } from 'react'
import { findDuplicateCustomer, parseDuplicateCustomerError, type CustomerDuplicate, type ExistingCustomerLike } from '@/lib/customerCreateDuplicates'
import type { CustomerFormValue } from './useCustomerForm'

/**
 * Blocks a duplicate create. Checks as you type against the customers the page has loaded,
 * and shows the server's refusal when it finds one the page did not. Only an admin may create
 * a same-named but different company, with a reason; an MC or DOT match can never be overridden.
 */
export function useNewCustomerGuard({
  value,
  isNew,
  existing,
  isAdmin,
}: {
  value: CustomerFormValue
  isNew: boolean
  existing: readonly ExistingCustomerLike[]
  isAdmin: boolean
}) {
  const [serverError, setServerError] = useState<string | null>(null)
  const [overriding, setOverriding] = useState(false)
  const [reason, setReason] = useState('')

  const live = useMemo<CustomerDuplicate | null>(
    () => (isNew ? findDuplicateCustomer({ name: value.name, mcNumber: value.mcNumber, dotNumber: value.dotNumber }, existing) : null),
    [isNew, value.name, value.mcNumber, value.dotNumber, existing],
  )
  const fromServer = parseDuplicateCustomerError(serverError)
  const duplicate = live
    ? { id: live.id, name: live.name, mcNumber: live.mcNumber, reason: live.reason }
    : fromServer ? { id: fromServer.id, name: fromServer.name, mcNumber: null, reason: /same (MC|DOT)/.test(fromServer.text) ? 'MC' as const : 'NAME' as const } : null
  const canOverride = isAdmin && duplicate?.reason === 'NAME'
  const overrideReason = canOverride && overriding && reason.trim().length >= 5 ? reason.trim() : null
  const blocked = duplicate != null && overrideReason == null

  return {
    duplicate,
    blocked,
    canOverride,
    overriding,
    setOverriding,
    reason,
    setReason,
    overrideReason,
    /** Call with a save error: a duplicate refusal is kept and shown; anything else is returned to the caller. */
    takeError(e: unknown): boolean {
      const text = e instanceof Error ? e.message : String(e)
      if (parseDuplicateCustomerError(text)) { setServerError(text); return true }
      return false
    },
  }
}



export type NewCustomerGuard = ReturnType<typeof useNewCustomerGuard>
