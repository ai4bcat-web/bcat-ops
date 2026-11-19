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
  // Ask BCAT data tools (read-only): see askSources.ts.
  CARRIER_BILL_TABLE_NAME: 'CarrierBill',
  VENDOR_PAYABLE_TABLE_NAME: 'VendorPayable',
  MAINTENANCE_INVOICE_TABLE_NAME: 'MaintenanceInvoice',
  FUEL_TRANSACTION_TABLE_NAME: 'FuelTransaction',
  DRIVER_TABLE_NAME: 'Driver',
  EQUIPMENT_TABLE_NAME: 'Equipment',
  DRIVER_PAY_PERIOD_TABLE_NAME: 'DriverPayPeriod',
  DRIVER_PAY_CREDIT_TABLE_NAME: 'DriverPayCredit',
  DRIVER_PAY_DEDUCTION_TABLE_NAME: 'DriverPayDeduction',
  DRIVER_PAY_SETTING_TABLE_NAME: 'DriverPaySetting',
  RECURRING_EXPENSE_TABLE_NAME: 'RecurringExpense',
  EXPENSE_RECORD_TABLE_NAME: 'ExpenseRecord',
  EXPENSE_TYPE_TABLE_NAME: 'ExpenseType',
  TRUCK_EXPENSE_ALLOCATION_TABLE_NAME: 'TruckExpenseAllocation',
  TRUCK_MILEAGE_TABLE_NAME: 'TruckMileage',
  INSURANCE_PERIOD_TABLE_NAME: 'InsurancePeriod',
  INSURANCE_LINE_ITEM_TABLE_NAME: 'InsuranceLineItem',
  LOAD_TABLE_NAME: 'Load',
} as const

applyDataTableSuffix(CRM_ACTIONS_TABLES)
