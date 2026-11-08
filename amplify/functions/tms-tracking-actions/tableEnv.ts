import { applyDataTableSuffix } from '../_shared/dataTableEnv'

/** Every `<X>_TABLE_NAME` this Lambda reads and the model behind it; backend.ts passes DATA_TABLE_SUFFIX instead of the names. */
export const TRACKING_ACTIONS_TABLES = {
  CONVERSATION_TABLE_NAME: 'DispatchConversation',
  MESSAGE_TABLE_NAME: 'DispatchMessage',
  SETTINGS_TABLE_NAME: 'DispatchSettings',
  DRIVER_TABLE_NAME: 'Driver',
  TRUCK_CONFIG_TABLE_NAME: 'TruckConfig',
  TRACKING_LINK_TABLE_NAME: 'TrackingLink',
  LOAD_CHECK_CALL_TABLE_NAME: 'LoadCheckCall',
  SHIPMENT_TABLE_NAME: 'Shipment',
  ORDER_TABLE_NAME: 'Order',
  LOAD_CARRIER_TABLE_NAME: 'LoadCarrier',
  LOAD_TABLE_NAME: 'Load',
  CUSTOMER_TABLE_NAME: 'Customer',
  TMS_SETTINGS_TABLE_NAME: 'TmsSettings',
  AUDIT_LOG_TABLE_NAME: 'AuditLog',
  DIVISION_TABLE_NAME: 'Division',
  TRUCK_LOCATION_HISTORY_TABLE_NAME: 'TruckLocationHistory',
  TRUCK_LOCATION_TABLE_NAME: 'TruckLocation',
  USER_PROFILE_TABLE_NAME: 'UserProfile',
  SHIPMENT_NOTICE_TABLE_NAME: 'ShipmentNotice',
  SHIPMENT_DOCUMENT_TABLE_NAME: 'ShipmentDocument',
  SHIPMENT_MESSAGE_TABLE_NAME: 'ShipmentMessage',
  LOAD_CHARGE_TABLE_NAME: 'LoadCharge',
  LOAD_FINANCIALS_TABLE_NAME: 'LoadFinancials',
} as const

applyDataTableSuffix(TRACKING_ACTIONS_TABLES)
