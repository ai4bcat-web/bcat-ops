/**
 * Front-end client for the manageOtr mutation.
 *
 * Mirrors podsClient: one mutation, an action discriminator, AWSJSON in and out.
 * Every OTR call is routed through the Lambda — the browser never holds OTR
 * credentials and never talks to OTR directly.
 */
import { generateClient } from 'aws-amplify/data'
import { graphqlErrorText } from '@/lib/apiClient'
import type { OtrReadiness } from '@/lib/otrInvoice'

const client = generateClient()

/** AWSJSON can arrive parsed, stringified, or double-encoded. Peel to the value. */
function unwrapJson(raw: unknown): unknown {
  let v = raw
  for (let i = 0; i < 4 && typeof v === 'string'; i++) {
    try {
      v = JSON.parse(v)
    } catch {
      break
    }
  }
  return v
}

/** The handler answers { ok, data } or { ok: false, error }. Surface the error text. */
async function otrAction<T>(action: string, input: unknown): Promise<T> {
  let r: { data: { manageOtr: unknown } }
  try {
    r = (await client.graphql({
      query: `mutation ManageOtr($action: String!, $input: AWSJSON) { manageOtr(action: $action, input: $input) }`,
      variables: { action, input: input != null ? JSON.stringify(input) : null },
    })) as { data: { manageOtr: unknown } }
  } catch (err) {
    throw new Error(graphqlErrorText(err) || `${action} failed`, { cause: err })
  }

  const v = unwrapJson(r.data.manageOtr) as { ok?: boolean; data?: T; error?: string } | null
  if (v == null) throw new Error(`${action} returned no result`)
  if (v.ok === false) throw new Error(v.error || `${action} failed`)
  return v.data as T
}

/** Match the row's PRO to a Load and persist the link. */
export function resolveLoad(id: string): Promise<{ loadId: string; customer?: string }> {
  return otrAction('resolve', { id })
}

/** Rebuild readiness: what's filled, where it came from, what's missing. */
export function assembleInvoice(id: string): Promise<OtrReadiness> {
  return otrAction('assemble', { id })
}

/**
 * Record a broker MC on the customer, creating the directory record when the
 * broker isn't in it yet. Entered once per broker, not once per load.
 */
export function setBrokerMc(
  id: string,
  mcNumber: string,
): Promise<{ customerId: string; mcNumber: string; readiness: OtrReadiness }> {
  return otrAction('setMc', { id, mcNumber })
}

/** Ask OTR whether the broker is approved. Never submits. */
export function checkBroker(
  id: string,
): Promise<{ decision: string; message: string; mcNumber: string }> {
  return otrAction('brokerCheck', { id })
}

/** Create the invoice at OTR and attach the POD and rate confirmation. */
export function submitToOtr(id: string): Promise<{
  invoiceId: number
  brokerName: string
  isDuplicate: boolean
  uploaded: { pod?: string; rateConfirmation?: string }
  documentErrors: string[]
}> {
  return otrAction('submit', { id })
}

/** Pull OTR's current status onto one or more rows. */
export function syncOtrStatus(
  ids: string[],
): Promise<{ synced: Array<{ id: string; status?: string; error?: string }> }> {
  return otrAction('syncStatus', { ids })
}
