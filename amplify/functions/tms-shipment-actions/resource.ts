import { defineFunction } from '@aws-amplify/backend'

/**
 * tms-shipment-actions Lambda — custom AppSync mutation `tmsShipmentActions(action, input)`.
 *
 * Step B's single writer for the shipment side of the TMS: Shipment, Order,
 * LoadCarrier, LoadFinancials and LoadCharge are written with the DynamoDB SDK
 * (TransactWriteItems where several tables must agree), while Load itself goes
 * through the generated AppSync `updateLoad` mutation so the calendar's
 * subscriptions still fire.
 *
 * 60s rather than the directory Lambda's 30: DUPLICATE_SHIPMENT writes up to 20
 * shipments, each with its own order, load, financials and charge rows.
 */
export const tmsShipmentActions = defineFunction({
  name: 'tms-shipment-actions',
  entry: './handler.ts',
  resourceGroupName: 'tms',
  timeoutSeconds: 60,
})
