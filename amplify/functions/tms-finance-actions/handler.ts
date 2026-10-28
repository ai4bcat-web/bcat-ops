/**
 * tmsFinanceActions — the AR router.
 *
 * Everything that posts money against a customer lives behind this one mutation, and
 * nothing else in the system writes `Order.arStatus = UNPAID | PAID`, an `Invoice` row
 * or an `ArPayment` row. It is deliberately NOT part of `tms-shipment-actions`: that
 * router admits anybody holding `page-loads`, which is the right gate for building and
 * moving freight and the wrong one for a ledger.
 *
 * Two gates, not one. Reading and issuing is `page-invoicing` work; **posting** — void,
 * payment, credit, write-off, reversal — is owner/ADMIN while `TmsSettings
 * .arPostingAdminOnly` is true, which it is by default. The setting is read per call
 * rather than cached, because the point of it is that it can be turned off.
 */
import { parseInput, type Caller } from '../_shared/actionInputs'
import {
  batchEmail,
  batchGenerate,
  emailInvoice,
  generateInvoice,
  markInvoiceSent,
  previewInvoice,
  renderInvoicePdf,
  saveArSettings,
  voidInvoice,
} from './invoices'
import { createCredit, recordPayment, reversePayment, writeOffInvoice } from './payments'
import { previewFactor, sendToFactor } from './factor'
import {
  ADMIN_GROUP,
  INVOICING_PAGE_GROUP,
  OWNER_EMAIL,
  getCallerEmail,
  getGroups,
  getSettings,
  type AppSyncIdentity,
  type Row,
} from './store'

type Action =
  | 'PREVIEW_INVOICE'
  | 'GENERATE_INVOICE'
  | 'BATCH_GENERATE'
  | 'RENDER_INVOICE_PDF'
  | 'EMAIL_INVOICE'
  | 'BATCH_EMAIL'
  | 'MARK_SENT'
  | 'VOID_INVOICE'
  | 'RECORD_PAYMENT'
  | 'CREATE_CREDIT'
  | 'WRITE_OFF'
  | 'REVERSE_PAYMENT'
  | 'PREVIEW_FACTOR'
  | 'SEND_TO_FACTOR'
  | 'SAVE_AR_SETTINGS'

/** The actions that move money and are owner/ADMIN while `arPostingAdminOnly` holds. */
const POSTING_ACTIONS: Record<string, true> = {
  VOID_INVOICE: true,
  RECORD_PAYMENT: true,
  CREATE_CREDIT: true,
  WRITE_OFF: true,
  REVERSE_PAYMENT: true,
}

/** Settings are an admin act in every router here, posting rule or not. */
const ADMIN_ONLY_ACTIONS: Record<string, true> = {
  SAVE_AR_SETTINGS: true,
}

interface AppSyncEvent {
  arguments: {
    action: string
    input?: string | Record<string, unknown> | null
  }
  identity?: AppSyncIdentity | null
}

async function authorize(action: Action, identity?: AppSyncIdentity | null): Promise<Caller> {
  if (!identity) throw new Error('Unauthorized: missing identity')
  const email = await getCallerEmail(identity)
  if (!email) throw new Error('Unauthorized: could not resolve caller email')
  const groups = getGroups(identity)
  const isAdmin = email === OWNER_EMAIL || groups.includes(ADMIN_GROUP)

  if (!isAdmin && !groups.includes(INVOICING_PAGE_GROUP)) {
    throw new Error(`Forbidden: ${action} requires owner, ADMIN, or ${INVOICING_PAGE_GROUP}`)
  }
  if (ADMIN_ONLY_ACTIONS[action] && !isAdmin) {
    throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
  }
  if (POSTING_ACTIONS[action] && !isAdmin) {
    const settings = await getSettings()
    if (settings.arPostingAdminOnly !== false) {
      throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
    }
  }
  return { email, sub: identity.sub, groups, isAdmin }
}

export const handler = async (event: AppSyncEvent): Promise<Row> => {
  const action = event.arguments.action as Action
  const caller = await authorize(action, event.identity)
  const input = parseInput(event.arguments.input)

  switch (action) {
    case 'PREVIEW_INVOICE':
      return previewInvoice(input, caller)
    case 'GENERATE_INVOICE':
      return generateInvoice(input, caller)
    case 'BATCH_GENERATE':
      return batchGenerate(input, caller)
    case 'RENDER_INVOICE_PDF':
      return renderInvoicePdf(input, caller)
    case 'EMAIL_INVOICE':
      return emailInvoice(input, caller)
    case 'BATCH_EMAIL':
      return batchEmail(input, caller)
    case 'MARK_SENT':
      return markInvoiceSent(input, caller)
    case 'VOID_INVOICE':
      return voidInvoice(input, caller)
    case 'RECORD_PAYMENT':
      return recordPayment(input, caller) as unknown as Promise<Row>
    case 'CREATE_CREDIT':
      return createCredit(input, caller) as unknown as Promise<Row>
    case 'WRITE_OFF':
      return writeOffInvoice(input, caller) as unknown as Promise<Row>
    case 'REVERSE_PAYMENT':
      return reversePayment(input, caller) as unknown as Promise<Row>
    case 'PREVIEW_FACTOR':
      return previewFactor(input)
    case 'SEND_TO_FACTOR':
      return sendToFactor(input, caller)
    case 'SAVE_AR_SETTINGS':
      return saveArSettings(input, caller)
    default:
      throw new Error(`Unknown action: ${String(action)}`)
  }
}
