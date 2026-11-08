import { applyDataTableSuffix } from '../_shared/dataTableEnv'

/** Every `<X>_TABLE_NAME` this Lambda reads and the model behind it; backend.ts passes DATA_TABLE_SUFFIX instead of the names. */
export const FINANCE_ACTIONS_TABLES = {
  INVOICE_TABLE_NAME: 'Invoice',
  AR_PAYMENT_TABLE_NAME: 'ArPayment',
  ORDER_TABLE_NAME: 'Order',
  SHIPMENT_TABLE_NAME: 'Shipment',
  LOAD_TABLE_NAME: 'Load',
  LOAD_CARRIER_TABLE_NAME: 'LoadCarrier',
  LOAD_FINANCIALS_TABLE_NAME: 'LoadFinancials',
  LOAD_CHARGE_TABLE_NAME: 'LoadCharge',
  CUSTOMER_TABLE_NAME: 'Customer',
  DIVISION_TABLE_NAME: 'Division',
  SETTINGS_TABLE_NAME: 'TmsSettings',
  AUDIT_LOG_TABLE_NAME: 'AuditLog',
  FACTORING_ITEM_TABLE_NAME: 'FactoringItem',
  CARRIER_BILL_TABLE_NAME: 'CarrierBill',
  AP_PAYMENT_TABLE_NAME: 'ApPayment',
  CARRIER_TABLE_NAME: 'Carrier',
  CARRIER_PAYMENT_METHOD_TABLE_NAME: 'CarrierPaymentMethod',
  CARRIER_CONTACT_TABLE_NAME: 'CarrierContact',
  SHIPMENT_DOCUMENT_TABLE_NAME: 'ShipmentDocument',
  SHIPMENT_NOTICE_TABLE_NAME: 'ShipmentNotice',
  COMMISSION_TABLE_NAME: 'Commission',
  COMMISSION_PAY_PERIOD_TABLE_NAME: 'CommissionPayPeriod',
  USER_PROFILE_TABLE_NAME: 'UserProfile',
} as const

applyDataTableSuffix(FINANCE_ACTIONS_TABLES)
