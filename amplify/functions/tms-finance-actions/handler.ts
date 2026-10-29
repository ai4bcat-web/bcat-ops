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
  approveBill,
  previewBill,
  recordBill,
  saveApSettings,
  unapproveBill,
  voidBill,
} from './bills'
import {
  createApCredit,
  markRemittanceSent,
  recordApPayment,
  renderRemittancePdf,
  reverseApPayment,
  sendRemittance,
} from './apPayments'
import {
  acceptCommissionCounter,
  approveCommission,
  approvePayPeriod,
  cancelCommission,
  counterCommission,
  openPayPeriod,
  overrideCommission,
  payPayPeriod,
  previewCommissions,
  renderCommissionStatement,
  runCommissions,
  saveCommissionSettings,
  submitPayPeriod,
} from './commissions'
import {
  ADMIN_GROUP,
  CARRIER_PAY_PAGE_GROUP,
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
  | 'PREVIEW_BILL'
  | 'RECORD_BILL'
  | 'APPROVE_BILL'
  | 'UNAPPROVE_BILL'
  | 'VOID_BILL'
  | 'RECORD_AP_PAYMENT'
  | 'CREATE_AP_CREDIT'
  | 'REVERSE_AP_PAYMENT'
  | 'SEND_REMITTANCE'
  | 'RENDER_REMITTANCE_PDF'
  | 'MARK_REMITTANCE_SENT'
  | 'SAVE_AP_SETTINGS'
  | 'RUN_COMMISSIONS'
  | 'PREVIEW_COMMISSIONS'
  | 'APPROVE_COMMISSION'
  | 'COUNTER_COMMISSION'
  | 'ACCEPT_COMMISSION_COUNTER'
  | 'OVERRIDE_COMMISSION'
  | 'CANCEL_COMMISSION'
  | 'OPEN_PAY_PERIOD'
  | 'SUBMIT_PAY_PERIOD'
  | 'APPROVE_PAY_PERIOD'
  | 'PAY_PAY_PERIOD'
  | 'RENDER_COMMISSION_STATEMENT'
  | 'SAVE_COMMISSION_SETTINGS'

/** The actions that move money and are owner/ADMIN while `arPostingAdminOnly` holds. */
const POSTING_ACTIONS: Record<string, true> = {
  VOID_INVOICE: true,
  RECORD_PAYMENT: true,
  CREATE_CREDIT: true,
  WRITE_OFF: true,
  REVERSE_PAYMENT: true,
}

/**
 * AP is a separate permission from AR, and separately switchable.
 *
 * `page-invoicing` alone is refused on every one of these: billing a customer and
 * paying a carrier are different jobs with different consequences, and MVMNT treats
 * AP approval as its own capability.
 */
const AP_ACTIONS: Record<string, true> = {
  PREVIEW_BILL: true,
  RECORD_BILL: true,
  APPROVE_BILL: true,
  UNAPPROVE_BILL: true,
  VOID_BILL: true,
  RECORD_AP_PAYMENT: true,
  CREATE_AP_CREDIT: true,
  REVERSE_AP_PAYMENT: true,
  SEND_REMITTANCE: true,
  RENDER_REMITTANCE_PDF: true,
  MARK_REMITTANCE_SENT: true,
  SAVE_AP_SETTINGS: true,
}

/** Approving a bill is its own capability, behind `apApprovalAdminOnly`. */
const AP_APPROVAL_ACTIONS: Record<string, true> = {
  APPROVE_BILL: true,
  UNAPPROVE_BILL: true,
}

/** Money leaving the bank, behind `apPostingAdminOnly`. */
const AP_POSTING_ACTIONS: Record<string, true> = {
  VOID_BILL: true,
  RECORD_AP_PAYMENT: true,
  CREATE_AP_CREDIT: true,
  REVERSE_AP_PAYMENT: true,
}

/** Settings are an admin act in every router here, posting rule or not. */
const ADMIN_ONLY_ACTIONS: Record<string, true> = {
  SAVE_AR_SETTINGS: true,
  SAVE_AP_SETTINGS: true,
  SAVE_COMMISSION_SETTINGS: true,
}

/**
 * Commissions are their own desk (Step I).
 *
 * `page-commissions` opens the ledger and a rep's own negotiation; the approval
 * ladder inside it is decided per row by `commissionState`, not by this table,
 * because "may I approve this" depends on whose row it is. A manager is admitted
 * here by `role-MANAGER` as well, since the role's page set grants the key.
 */
const COMMISSION_ACTIONS: Record<string, true> = {
  RUN_COMMISSIONS: true,
  PREVIEW_COMMISSIONS: true,
  APPROVE_COMMISSION: true,
  COUNTER_COMMISSION: true,
  ACCEPT_COMMISSION_COUNTER: true,
  OVERRIDE_COMMISSION: true,
  CANCEL_COMMISSION: true,
  OPEN_PAY_PERIOD: true,
  SUBMIT_PAY_PERIOD: true,
  APPROVE_PAY_PERIOD: true,
  PAY_PAY_PERIOD: true,
  RENDER_COMMISSION_STATEMENT: true,
  SAVE_COMMISSION_SETTINGS: true,
}

const COMMISSIONS_PAGE_GROUP = 'page-commissions'

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

  // The commission desk is its own door, decided before the AR/AP page rule:
  // a rep who may see their own commission is not thereby an invoicing user,
  // and an invoicing user is not thereby on the commission ladder.
  if (COMMISSION_ACTIONS[action]) {
    if (!isAdmin && !groups.includes(COMMISSIONS_PAGE_GROUP)) {
      throw new Error(`Forbidden: ${action} requires owner, ADMIN, or ${COMMISSIONS_PAGE_GROUP}`)
    }
    if (ADMIN_ONLY_ACTIONS[action] && !isAdmin) {
      throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
    }
    return { email, sub: identity.sub, groups, isAdmin }
  }

  const isAp = AP_ACTIONS[action] === true
  const pageGroup = isAp ? CARRIER_PAY_PAGE_GROUP : INVOICING_PAGE_GROUP
  if (!isAdmin && !groups.includes(pageGroup)) {
    throw new Error(`Forbidden: ${action} requires owner, ADMIN, or ${pageGroup}`)
  }
  if (ADMIN_ONLY_ACTIONS[action] && !isAdmin) {
    throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
  }
  if (!isAdmin && (POSTING_ACTIONS[action] || AP_APPROVAL_ACTIONS[action] || AP_POSTING_ACTIONS[action])) {
    const settings = await getSettings()
    const flag = AP_APPROVAL_ACTIONS[action]
      ? settings.apApprovalAdminOnly
      : AP_POSTING_ACTIONS[action]
        ? settings.apPostingAdminOnly
        : settings.arPostingAdminOnly
    if (flag !== false) {
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
    case 'PREVIEW_BILL':
      return previewBill(input, caller)
    case 'RECORD_BILL':
      return recordBill(input, caller)
    case 'APPROVE_BILL':
      return approveBill(input, caller)
    case 'UNAPPROVE_BILL':
      return unapproveBill(input, caller)
    case 'VOID_BILL':
      return voidBill(input, caller)
    case 'RECORD_AP_PAYMENT':
      return recordApPayment(input, caller) as unknown as Promise<Row>
    case 'CREATE_AP_CREDIT':
      return createApCredit(input, caller) as unknown as Promise<Row>
    case 'REVERSE_AP_PAYMENT':
      return reverseApPayment(input, caller) as unknown as Promise<Row>
    case 'SEND_REMITTANCE':
      return sendRemittance(input, caller)
    case 'RENDER_REMITTANCE_PDF':
      return renderRemittancePdf(input, caller)
    case 'MARK_REMITTANCE_SENT':
      return markRemittanceSent(input, caller)
    case 'SAVE_AP_SETTINGS':
      return saveApSettings(input, caller)
    case 'RUN_COMMISSIONS':
      return runCommissions(input, caller)
    case 'PREVIEW_COMMISSIONS':
      return previewCommissions(input)
    case 'APPROVE_COMMISSION':
      return approveCommission(input, caller)
    case 'COUNTER_COMMISSION':
      return counterCommission(input, caller)
    case 'ACCEPT_COMMISSION_COUNTER':
      return acceptCommissionCounter(input, caller)
    case 'OVERRIDE_COMMISSION':
      return overrideCommission(input, caller)
    case 'CANCEL_COMMISSION':
      return cancelCommission(input, caller)
    case 'OPEN_PAY_PERIOD':
      return openPayPeriod(input, caller)
    case 'SUBMIT_PAY_PERIOD':
      return submitPayPeriod(input, caller)
    case 'APPROVE_PAY_PERIOD':
      return approvePayPeriod(input, caller)
    case 'PAY_PAY_PERIOD':
      return payPayPeriod(input, caller)
    case 'RENDER_COMMISSION_STATEMENT':
      return renderCommissionStatement(input, caller)
    case 'SAVE_COMMISSION_SETTINGS':
      return saveCommissionSettings(input, caller)
    default:
      throw new Error(`Unknown action: ${String(action)}`)
  }
}
