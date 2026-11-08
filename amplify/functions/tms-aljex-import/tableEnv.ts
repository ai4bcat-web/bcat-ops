import { applyDataTableSuffix } from '../_shared/dataTableEnv'

/** Every `<X>_TABLE_NAME` this Lambda reads and the model behind it; backend.ts passes DATA_TABLE_SUFFIX instead of the names. */
export const ALJEX_IMPORT_TABLES = {
  ALJEX_IMPORT_JOB_TABLE_NAME: 'AljexImportJob',
  ALJEX_MAPPING_PROFILE_TABLE_NAME: 'AljexMappingProfile',
  LEGACY_ALJEX_ROW_TABLE_NAME: 'LegacyAljexRow',
  SHIPMENT_TABLE_NAME: 'Shipment',
  ORDER_TABLE_NAME: 'Order',
  LOAD_TABLE_NAME: 'Load',
  LOAD_CARRIER_TABLE_NAME: 'LoadCarrier',
  LOAD_FINANCIALS_TABLE_NAME: 'LoadFinancials',
  LOAD_CHARGE_TABLE_NAME: 'LoadCharge',
  CUSTOMER_TABLE_NAME: 'Customer',
  LOCATION_TABLE_NAME: 'Location',
  CARRIER_TABLE_NAME: 'Carrier',
  INVOICE_TABLE_NAME: 'Invoice',
  AR_PAYMENT_TABLE_NAME: 'ArPayment',
  CARRIER_BILL_TABLE_NAME: 'CarrierBill',
  AP_PAYMENT_TABLE_NAME: 'ApPayment',
  PRO_CLAIM_TABLE_NAME: 'ProClaim',
  SETTINGS_TABLE_NAME: 'TmsSettings',
  AUDIT_LOG_TABLE_NAME: 'AuditLog',
  FACTORING_ITEM_TABLE_NAME: 'FactoringItem',
  DRIVER_TABLE_NAME: 'Driver',
  USER_PROFILE_TABLE_NAME: 'UserProfile',
  OWNERSHIP_DIVISION_TABLE_NAME: 'OwnershipDivision',
  OWNERSHIP_RULE_TABLE_NAME: 'OwnershipRule',
  DIVISION_TABLE_NAME: 'Division',
  MCP_INTEGRATION_TABLE_NAME: 'Integration',
} as const

applyDataTableSuffix(ALJEX_IMPORT_TABLES)
