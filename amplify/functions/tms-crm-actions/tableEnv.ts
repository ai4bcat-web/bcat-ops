import { applyDataTableSuffix } from '../_shared/dataTableEnv'

/** Every `<X>_TABLE_NAME` this Lambda reads and the model behind it; backend.ts passes DATA_TABLE_SUFFIX instead of the names. */
export const CRM_ACTIONS_TABLES = {
  CRM_CONTACT_TABLE_NAME: 'CrmContact',
  CRM_DOMAIN_TABLE_NAME: 'CrmDomain',
  CRM_ACTIVITY_TABLE_NAME: 'CrmActivity',
  CRM_ACCOUNT_TABLE_NAME: 'CrmAccount',
  CUSTOMER_TABLE_NAME: 'Customer',
  QUOTE_TABLE_NAME: 'Quote',
  SHIPMENT_TABLE_NAME: 'Shipment',
  ORDER_TABLE_NAME: 'Order',
  USER_PROFILE_TABLE_NAME: 'UserProfile',
  AUDIT_LOG_TABLE_NAME: 'AuditLog',
  INVOICE_TABLE_NAME: 'Invoice',
  LANE_RATE_SAMPLE_TABLE_NAME: 'LaneRateSample',
  TMS_SETTINGS_TABLE_NAME: 'TmsSettings',
  OWNERSHIP_DIVISION_TABLE_NAME: 'OwnershipDivision',
  DASHBOARD_ROLLUP_TABLE_NAME: 'DashboardRollup',
} as const

applyDataTableSuffix(CRM_ACTIONS_TABLES)
