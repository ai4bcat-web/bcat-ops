import { useCallback, useEffect, useState } from 'react'
import { crmAction, graphqlErrorText } from '@/lib/apiClient'
import type { CrmAccountRecord, CrmAccountView, CrmActivityKind, CrmActivityRecord } from '@/lib/crm/types'

export interface AddActivityInput {
  kind: Extract<CrmActivityKind, 'NOTE' | 'CALL' | 'TEXT'>
  summary: string
  at?: string
  contactEmail?: string
}

export interface AddTaskInput {
  summary: string
  dueAt: string
  assigneeId?: string
}

/**
 * One customer's CRM view (§5.4 `CRM_GET_ACCOUNT`) plus the writes the card makes. Every
 * write re-reads the account, so the strip, timeline and tasks never disagree with the
 * server's `touch()` bookkeeping.
 */
export function useCrmAccount(customerId: string) {
  const [view, setView] = useState<CrmAccountView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Promise chain, not async/await: every state write sits in a callback (react-hooks/set-state-in-effect).
  const refresh = useCallback(() => crmAction<CrmAccountView>('CRM_GET_ACCOUNT', { customerId })
    .then((v) => { setView(v); setError(null) })
    .catch((e: unknown) => { setError(graphqlErrorText(e) || 'Could not load CRM') })
    .finally(() => setLoading(false)), [customerId])

  useEffect(() => { void refresh() }, [refresh])

  const write = useCallback(async <T,>(action: Parameters<typeof crmAction>[0], input: unknown): Promise<T> => {
    const out = await crmAction<T>(action, input)
    await refresh()
    return out
  }, [refresh])

  return {
    view,
    loading,
    error,
    refresh,
    addActivity: (input: AddActivityInput) => write<{ activity: CrmActivityRecord }>('CRM_ADD_ACTIVITY', { customerId, ...input }),
    addTask: (input: AddTaskInput) => write<{ activity: CrmActivityRecord }>('CRM_ADD_TASK', { customerId, ...input }),
    completeTask: (id: string) => write<{ activity: CrmActivityRecord }>('CRM_COMPLETE_TASK', { id }),
    setNextStep: (nextStep: string, nextStepDueAt?: string) =>
      write<{ account: CrmAccountRecord }>('CRM_SET_NEXT_STEP', { customerId, nextStep, nextStepDueAt }),
    addContact: (input: { email: string; name?: string; title?: string; phone?: string }) =>
      write<unknown>('CRM_UPSERT_CONTACT', { customerId, ...input }),
    releaseDomain: (domain: string) => write<unknown>('CRM_CLAIM_DOMAIN', { domain, customerId, release: true }),
  }
}
