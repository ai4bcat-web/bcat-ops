/**
 * Front-end client for the manageOtr mutation.
 *
 * Mirrors podsClient: one mutation, an action discriminator, AWSJSON in and out.
 * Every OTR call is routed through the Lambda — the browser never holds OTR
 * credentials and never talks to OTR directly.
 */
import { generateClient } from 'aws-amplify/data'
import { graphqlErrorText } from '@/lib/apiClient'
import type { OtrReadiness, RateConExtract } from '@/lib/otrInvoice'

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
 * Store what a rate confirmation stated, and rebuild readiness from it.
 *
 * Readiness already prefers the rate con for the PO number and takes the ZIPs from it; this
 * is what finally gives it something to read. The broker MC is never sent — it decides who
 * gets billed and stays a human entry on the Customer record.
 */
export function saveRateConExtract(
  id: string,
  extract: RateConExtract,
): Promise<{ extract: RateConExtract; readiness: OtrReadiness }> {
  return otrAction('rateConExtract', { id, extract })
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

/** Take the row out of the OTR queue to be billed by hand. */
export function markManualInvoice(id: string, apEmail?: string): Promise<{ status: string }> {
  return otrAction('manualInvoice', { id, ...(apEmail ? { apEmail } : {}) })
}

/** Put a manually-invoiced row back in the OTR queue. */
export function returnToOtrQueue(id: string): Promise<{ status: string }> {
  return otrAction('returnToOtr', { id })
}

export function setApEmail(id: string, apEmail: string): Promise<{ apEmail: string | null }> {
  return otrAction('setApEmail', { id, apEmail })
}

/** Tick or clear one of the manual-invoice steps. */
export function setManualStep(
  id: string,
  step: string,
  done: boolean,
): Promise<{ status: string; progress: { done: number; total: number; complete: boolean } }> {
  return otrAction('manualStep', { id, step, done })
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

/**
 * Send the documents again for an invoice OTR already has.
 *
 * Submitting creates the invoice and attaches the paperwork after, and it refuses to run
 * twice — so a failed upload left a real invoice at OTR with nothing on it and no way to
 * finish short of creating a duplicate.
 */
export function uploadOtrDocs(
  id: string,
): Promise<{
  invoiceId: string
  uploaded: { pod?: string; rateConfirmation?: string }
  documentErrors: string[]
}> {
  return otrAction('uploadDocs', { id })
}

/** Pull OTR's current status onto one or more rows. */
export function syncOtrStatus(
  ids: string[],
): Promise<{ synced: Array<{ id: string; status?: string; error?: string }> }> {
  return otrAction('syncStatus', { ids })
}
