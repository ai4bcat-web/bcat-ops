/**
 * tmsFinanceActions — the AR router.
 *
 * Everything that posts money against a customer lives behind this one mutation, and
 * nothing else in the system writes `Order.arStatus = UNPAID | PAID`, an `Invoice` row
 * or an `ArPayment` row. It is deliberately NOT part of `tms-shipment-actions`: that
 * router admits anybody holding `page-loads`, which is the right gate for building and
 * moving freight and the wrong one for a ledger.
 *
 * One gate per accounting page (src/lib/accountingAccess.ts): holding the page's grant
 * opens every action on it, posting included (Ryne 2026-11-12). The old
 * `arPostingAdminOnly` / `apApprovalAdminOnly` / `apPostingAdminOnly` settings no longer
 * restrict anything.
 */
import './tableEnv'
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
import { releaseToBilling, sendInvoice, syncFactoringChange } from './release'
import {
  approveBill,
  previewBill,
  recordBill,
  saveApSettings,
  unapproveBill,
  voidBill,
  setBillDates,
  selectBillsForPayment,
  unselectBills,
} from './bills'
import {
  createApCredit,
  markRemittanceSent,
  recordApPayment,
  renderRemittancePdf,
  reverseApPayment,
  sendRemittance,
} from './apPayments'
import { repointInvoicedCustomer } from './repoint'
import { brokerageRepRollup } from './brokerageRep'
import { agingStatement } from './statements'
import { settleFactoredInvoices } from './settleFactored'
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
import { accountingAccessMessage, hasAccountingPage } from '../../../src/lib/accountingAccess'
import {
  ADMIN_GROUP,
  OWNER_EMAIL,
  getCallerEmail,
  getGroups,
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
  | 'SET_BILL_DATES'
  | 'SELECT_BILLS_FOR_PAYMENT'
  | 'UNSELECT_BILLS'
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
  | 'REPOINT_INVOICED_CUSTOMER'
  | 'RELEASE_TO_BILLING'
  | 'SEND_INVOICE'
  | 'SYNC_FACTORING_CHANGE'
  | 'AGING_STATEMENT'
  | 'SETTLE_FACTORED_INVOICES'
  | 'BROKERAGE_REP_ROLLUP'

/**
 * AP is a separate page from AR.
 *
 * Accounts payable is its own page (`page-carrierPay`): billing a customer and paying a
 * carrier are different jobs, so `page-invoicing` never opens these.
 */
const AP_ACTIONS: Record<string, true> = {
  PREVIEW_BILL: true,
  RECORD_BILL: true,
  APPROVE_BILL: true,
  UNAPPROVE_BILL: true,
  VOID_BILL: true,
  SET_BILL_DATES: true,
  SELECT_BILLS_FOR_PAYMENT: true,
  UNSELECT_BILLS: true,
  RECORD_AP_PAYMENT: true,
  CREATE_AP_CREDIT: true,
  REVERSE_AP_PAYMENT: true,
  SEND_REMITTANCE: true,
  RENDER_REMITTANCE_PDF: true,
  MARK_REMITTANCE_SENT: true,
  SAVE_AP_SETTINGS: true,
}

/** Settings are an admin act in every router here, posting rule or not. */
const ADMIN_ONLY_ACTIONS: Record<string, true> = {
  SAVE_AR_SETTINGS: true,
  SAVE_AP_SETTINGS: true,
  SAVE_COMMISSION_SETTINGS: true,
  REPOINT_INVOICED_CUSTOMER: true,
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

interface AppSyncEvent {
  arguments: {
    action: string
    input?: string | Record<string, unknown> | null
  }
  identity?: AppSyncIdentity | null
}

/**
 * The accounting page an action belongs to (Ryne 2026-11-12): holding that page's grant
 * opens the action, whatever it is. Release to billing is Load review's act; sending to the
 * factor and syncing a factoring change belong to Invoicing or Factoring; carrier bills to
 * Accounts payable; commissions to their own desk; everything else here is Invoicing.
 */
function accountingPagesFor(action: Action): readonly string[] {
  if (action === 'RELEASE_TO_BILLING') return ['loadReview', 'invoicing']
  if (action === 'SEND_TO_FACTOR' || action === 'SYNC_FACTORING_CHANGE' || action === 'SETTLE_FACTORED_INVOICES') return ['invoicing', 'factoring']
  if (COMMISSION_ACTIONS[action]) return ['commissions']
  if (AP_ACTIONS[action]) return ['carrierPay']
  return ['invoicing']
}

async function authorize(action: Action, identity?: AppSyncIdentity | null): Promise<Caller> {
  if (!identity) throw new Error('Unauthorized: missing identity')
  const email = await getCallerEmail(identity)
  if (!email) throw new Error('Unauthorized: could not resolve caller email')
  const groups = getGroups(identity)
  const isAdmin = email === OWNER_EMAIL || groups.includes(ADMIN_GROUP)

  // Settings and moving an invoiced shipment to another customer are not actions on a page.
  if (ADMIN_ONLY_ACTIONS[action] && !isAdmin) {
    throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
  }
  // Page access is every action on the page: no separate posting, approval or send layer.
  const pages = accountingPagesFor(action)
  if (!pages.some((key) => hasAccountingPage(groups, email, key))) {
    throw new Error(`Forbidden: ${accountingAccessMessage(pages[0])}`)
  }
  return { email, sub: identity.sub, groups, isAdmin }
}

export const handler = async (event: AppSyncEvent): Promise<Row> => {
  // The EventBridge schedule (no AppSync arguments): mark OTR-funded invoices paid.
  if (!event.arguments && (event as unknown as { source?: string }).source === 'aws.events') {
    return settleFactoredInvoices() as unknown as Row
  }
  const action = event.arguments.action as Action
  // Its own door, decided by brokerageAccessOf inside the action (owner/ADMIN/page-dashboard or a sales rep), never by the AR page rule.
  if (action === 'BROKERAGE_REP_ROLLUP') return brokerageRepRollup(event.identity, parseInput(event.arguments.input))
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
    case 'REPOINT_INVOICED_CUSTOMER':
      return repointInvoicedCustomer(input, caller) as unknown as Promise<Row>
    case 'RELEASE_TO_BILLING':
      return releaseToBilling(input, caller)
    case 'SEND_INVOICE':
      return sendInvoice(input, caller)
    case 'SETTLE_FACTORED_INVOICES':
      return settleFactoredInvoices(caller) as unknown as Promise<Row>
    case 'AGING_STATEMENT':
      return agingStatement(input, caller)
    case 'SYNC_FACTORING_CHANGE':
      return syncFactoringChange(input, caller)
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
    case 'SET_BILL_DATES':
      return setBillDates(input, caller)
    case 'SELECT_BILLS_FOR_PAYMENT':
      return selectBillsForPayment(input, caller)
    case 'UNSELECT_BILLS':
      return unselectBills(input, caller)
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
