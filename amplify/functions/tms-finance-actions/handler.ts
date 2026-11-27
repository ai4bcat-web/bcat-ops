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
import { clearChaseAchMark, exportChaseAch, previewChaseAch, saveChaseAchSettings } from './achExport'
import {
  batchEmail,
  batchGenerate,
  emailInvoice,
  generateInvoice,
  invoiceAttachmentPlans,
  previewInvoicePacket,
  markInvoiceSent,
  markInvoiced,
  setOtrOffset,
  previewInvoice,
  renderInvoicePdf,
  reviseInvoice,
  saveArSettings,
  voidInvoice,
  voidOtrDeletedInvoice,
} from './invoices'
import { acceptDifferences, createCredit, recordPayment, reversePayment, writeOffInvoice } from './payments'
import { previewFactor, previewFactorReady, releaseDeadOtrSubmission, sendToFactor } from './factor'
import { moveToManualInvoice } from './otrRejected'
import { setInvoiceMethod, syncCustomerMethod } from './invoiceMethod'
import { releaseToBilling, sendInvoice, syncFactoringChange } from './release'
import {
  approveBill,
  previewBill,
  recordBill,
  saveApSettings,
  unapproveBill,
  voidBill,
  deleteBill,
  returnBillToExpected,
  setBillDates,
  setBillQuickPay,
  selectBillsForPayment,
  unselectBills,
} from './bills'
import {
  createApCredit,
  markRemittanceSent,
  recordApPayment,
  recordApPaymentGroup,
  renderRemittancePdf,
  reverseApPayment,
  sendRemittance,
  setPayeeRemitEmail,
  setFactorRemitEmail,
  setPayToProfile,
  setCarrierPayTo,
} from './apPayments'
import { archiveApPaymentsThrough, unarchiveApPayments } from './archivePayments'
import { repointInvoicedCustomer } from './repoint'
import { changeInvoiceCustomer } from './changeCustomer'
import { brokerageRepRollup } from './brokerageRep'
import { agingStatement } from './statements'
import { pastDueReminder } from './pastDueReminder'
/** Auto-settling factored invoices from OTR's status is off; see the schedule branch in handler(). */
export const SETTLE_TURNED_OFF = {
  skipped: true,
  reason: 'Marking factored invoices paid from OTR is turned off. Record the payment on the invoice instead.',
} as const
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
import { clearFinanceReview, setDeliveredDate } from './financeReview'
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
  | 'CLEAR_FINANCE_REVIEW'
  | 'SET_DELIVERED_DATE'
  | 'PREVIEW_INVOICE'
  | 'GENERATE_INVOICE'
  | 'BATCH_GENERATE'
  | 'RENDER_INVOICE_PDF'
  | 'EMAIL_INVOICE'
  | 'BATCH_EMAIL'
  | 'MARK_SENT'
  | 'MARK_INVOICED'
  | 'SET_OTR_OFFSET'
  | 'VOID_INVOICE'
  | 'VOID_OTR_DELETED_INVOICE'
  | 'RELEASE_DEAD_OTR_SUBMISSION'
  | 'RECORD_PAYMENT'
  | 'CREATE_CREDIT'
  | 'WRITE_OFF'
  | 'ACCEPT_DIFFERENCES'
  | 'REVERSE_PAYMENT'
  | 'PREVIEW_FACTOR'
  | 'PREVIEW_FACTOR_READY'
  | 'MOVE_TO_MANUAL_INVOICE'
  | 'SET_INVOICE_METHOD'
  | 'SYNC_CUSTOMER_METHOD'
  | 'SEND_TO_FACTOR'
  | 'SAVE_AR_SETTINGS'
  | 'PREVIEW_BILL'
  | 'RECORD_BILL'
  | 'APPROVE_BILL'
  | 'UNAPPROVE_BILL'
  | 'VOID_BILL'
  | 'DELETE_BILL'
  | 'SET_BILL_DATES'
  | 'RETURN_BILL_TO_EXPECTED'
  | 'SET_BILL_QUICK_PAY'
  | 'SELECT_BILLS_FOR_PAYMENT'
  | 'UNSELECT_BILLS'
  | 'RECORD_AP_PAYMENT'
  | 'RECORD_AP_PAYMENT_GROUP'
  | 'CREATE_AP_CREDIT'
  | 'REVERSE_AP_PAYMENT'
  | 'SEND_REMITTANCE'
  | 'SET_REMIT_EMAIL'
  | 'SET_FACTOR_REMIT_EMAIL'
  | 'SET_PAYTO_PROFILE'
  | 'SET_CARRIER_PAYTO'
  | 'RENDER_REMITTANCE_PDF'
  | 'MARK_REMITTANCE_SENT'
  | 'SAVE_AP_SETTINGS'
  | 'ARCHIVE_AP_PAYMENTS_THROUGH'
  | 'UNARCHIVE_AP_PAYMENTS'
  | 'SAVE_CHASE_ACH_SETTINGS'
  | 'PREVIEW_CHASE_ACH'
  | 'EXPORT_CHASE_ACH'
  | 'CLEAR_CHASE_ACH_MARK'
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
  | 'PAST_DUE_REMINDER'
  | 'REVISE_INVOICE'
  | 'CHANGE_INVOICE_CUSTOMER'
  | 'SETTLE_FACTORED_INVOICES'
  | 'BROKERAGE_REP_ROLLUP'
  | 'INVOICE_ATTACHMENTS'
  | 'PREVIEW_INVOICE_PACKET'

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
  DELETE_BILL: true,
  SET_BILL_DATES: true,
  RETURN_BILL_TO_EXPECTED: true,
  SET_BILL_QUICK_PAY: true,
  SELECT_BILLS_FOR_PAYMENT: true,
  UNSELECT_BILLS: true,
  RECORD_AP_PAYMENT: true,
  RECORD_AP_PAYMENT_GROUP: true,
  CREATE_AP_CREDIT: true,
  REVERSE_AP_PAYMENT: true,
  SEND_REMITTANCE: true,
  SET_REMIT_EMAIL: true,
  SET_FACTOR_REMIT_EMAIL: true,
  SET_PAYTO_PROFILE: true,
  SET_CARRIER_PAYTO: true,
  RENDER_REMITTANCE_PDF: true,
  MARK_REMITTANCE_SENT: true,
  SAVE_AP_SETTINGS: true,
  ARCHIVE_AP_PAYMENTS_THROUGH: true,
  UNARCHIVE_AP_PAYMENTS: true,
  SAVE_CHASE_ACH_SETTINGS: true,
  PREVIEW_CHASE_ACH: true,
  EXPORT_CHASE_ACH: true,
  CLEAR_CHASE_ACH_MARK: true,
}

/** Settings are an admin act in every router here, posting rule or not. */
const ADMIN_ONLY_ACTIONS: Record<string, true> = {
  SAVE_AR_SETTINGS: true,
  SAVE_AP_SETTINGS: true,
  SAVE_COMMISSION_SETTINGS: true,
  REPOINT_INVOICED_CUSTOMER: true,
  // Hiding years of payment history is an admin act, never a page one.
  ARCHIVE_AP_PAYMENTS_THROUGH: true,
  UNARCHIVE_AP_PAYMENTS: true,
  // The Chase company settings (company ID, ODFI routing) stay with the owner. Previewing, exporting and clearing the
  // mark are AP actions like the rest of the page (Ryne 2026-11-19: Jenny may run the bank file).
  SAVE_CHASE_ACH_SETTINGS: true,
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
  if (action === 'CLEAR_FINANCE_REVIEW' || action === 'SET_DELIVERED_DATE') return ['invoicing', 'carrierPay']
  if (action === 'SEND_TO_FACTOR' || action === 'SYNC_FACTORING_CHANGE' || action === 'SETTLE_FACTORED_INVOICES' || action === 'MOVE_TO_MANUAL_INVOICE' || action === 'SET_INVOICE_METHOD' || action === 'SYNC_CUSTOMER_METHOD') return ['invoicing', 'factoring']
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
  // The EventBridge schedule (no AppSync arguments) used to mark OTR-approved invoices paid.
  // Turned off 2026-11-15: OTR "Approved" is not proof the money arrived, and Ryne is building
  // his own rule for marking invoices paid. settleFactored.ts is kept for that work but nothing
  // calls it; the schedule still fires and does nothing.
  if (!event.arguments && (event as unknown as { source?: string }).source === 'aws.events') {
    return { ...SETTLE_TURNED_OFF } as unknown as Row
  }
  const action = event.arguments.action as Action
  // Its own door, decided by brokerageAccessOf inside the action (owner/ADMIN/page-dashboard or a sales rep), never by the AR page rule.
  if (action === 'BROKERAGE_REP_ROLLUP') return brokerageRepRollup(event.identity, parseInput(event.arguments.input))
  const caller = await authorize(action, event.identity)
  const input = parseInput(event.arguments.input)

  switch (action) {
    case 'CLEAR_FINANCE_REVIEW':
      return clearFinanceReview(input, caller)
    case 'SET_DELIVERED_DATE':
      return setDeliveredDate(input, caller)
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
    case 'MARK_INVOICED':
      return markInvoiced(input, caller)
    case 'SET_OTR_OFFSET':
      return setOtrOffset(input, caller)
    case 'VOID_INVOICE':
      return voidInvoice(input, caller)
    case 'VOID_OTR_DELETED_INVOICE':
      return voidOtrDeletedInvoice(input, caller)
    case 'RELEASE_DEAD_OTR_SUBMISSION':
      return releaseDeadOtrSubmission(input, caller)
    case 'RECORD_PAYMENT':
      return recordPayment(input, caller) as unknown as Promise<Row>
    case 'CREATE_CREDIT':
      return createCredit(input, caller) as unknown as Promise<Row>
    case 'WRITE_OFF':
      return writeOffInvoice(input, caller) as unknown as Promise<Row>
    case 'ACCEPT_DIFFERENCES':
      return acceptDifferences(input, caller)
    case 'REVERSE_PAYMENT':
      return reversePayment(input, caller) as unknown as Promise<Row>
    case 'REPOINT_INVOICED_CUSTOMER':
      return repointInvoicedCustomer(input, caller) as unknown as Promise<Row>
    case 'RELEASE_TO_BILLING':
      return releaseToBilling(input, caller)
    case 'SEND_INVOICE':
      return sendInvoice(input, caller)
    case 'SETTLE_FACTORED_INVOICES':
      // Turned off with the schedule above; factored invoices stay open until paid by hand.
      throw new Error(SETTLE_TURNED_OFF.reason)
    case 'REVISE_INVOICE':
      return reviseInvoice(input, caller)
    case 'CHANGE_INVOICE_CUSTOMER':
      return changeInvoiceCustomer(input, caller)
    case 'AGING_STATEMENT':
      return agingStatement(input, caller)
    case 'PAST_DUE_REMINDER':
      return pastDueReminder(input, caller)
    case 'PREVIEW_INVOICE_PACKET':
      return previewInvoicePacket(input, caller)
    case 'INVOICE_ATTACHMENTS':
      return invoiceAttachmentPlans(input)
    case 'SYNC_FACTORING_CHANGE':
      return syncFactoringChange(input, caller)
    case 'PREVIEW_FACTOR':
      return previewFactor(input)
    case 'PREVIEW_FACTOR_READY':
      return previewFactorReady(input)
    case 'MOVE_TO_MANUAL_INVOICE':
      return moveToManualInvoice(input, caller)
    case 'SET_INVOICE_METHOD':
      return setInvoiceMethod(input, caller)
    case 'SYNC_CUSTOMER_METHOD':
      return syncCustomerMethod(input, caller)
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
    case 'DELETE_BILL':
      return deleteBill(input, caller)
    case 'SET_BILL_DATES':
      return setBillDates(input, caller)
    case 'RETURN_BILL_TO_EXPECTED':
      return returnBillToExpected(input, caller)
    case 'SET_BILL_QUICK_PAY':
      return setBillQuickPay(input, caller)
    case 'SELECT_BILLS_FOR_PAYMENT':
      return selectBillsForPayment(input, caller)
    case 'UNSELECT_BILLS':
      return unselectBills(input, caller)
    case 'RECORD_AP_PAYMENT':
      return recordApPayment(input, caller) as unknown as Promise<Row>
    case 'RECORD_AP_PAYMENT_GROUP':
      return recordApPaymentGroup(input, caller)
    case 'CREATE_AP_CREDIT':
      return createApCredit(input, caller) as unknown as Promise<Row>
    case 'REVERSE_AP_PAYMENT':
      return reverseApPayment(input, caller) as unknown as Promise<Row>
    case 'SEND_REMITTANCE':
      return sendRemittance(input, caller)
    case 'SET_REMIT_EMAIL':
      return setPayeeRemitEmail(input, caller)
    case 'SET_FACTOR_REMIT_EMAIL':
      return setFactorRemitEmail(input, caller)
    case 'SET_PAYTO_PROFILE':
      return setPayToProfile(input, caller)
    case 'SET_CARRIER_PAYTO':
      return setCarrierPayTo(input, caller)
    case 'RENDER_REMITTANCE_PDF':
      return renderRemittancePdf(input, caller)
    case 'MARK_REMITTANCE_SENT':
      return markRemittanceSent(input, caller)
    case 'SAVE_AP_SETTINGS':
      return saveApSettings(input, caller)
    case 'SAVE_CHASE_ACH_SETTINGS':
      return saveChaseAchSettings(input, caller)
    case 'PREVIEW_CHASE_ACH':
      return previewChaseAch(input)
    case 'EXPORT_CHASE_ACH':
      return exportChaseAch(input, caller)
    case 'CLEAR_CHASE_ACH_MARK':
      return clearChaseAchMark(input, caller)
    case 'ARCHIVE_AP_PAYMENTS_THROUGH':
      return archiveApPaymentsThrough(input, caller)
    case 'UNARCHIVE_AP_PAYMENTS':
      return unarchiveApPayments(input, caller)
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
