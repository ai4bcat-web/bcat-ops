import { defineFunction } from '@aws-amplify/backend'

/**
 * tms-carrier-actions Lambda — custom AppSync mutation `tmsCarrierActions(action, input)`.
 *
 * Step C's single writer for the carrier directory: Carrier, CarrierContact,
 * CarrierPaymentMethod and CarrierDocument are written with the DynamoDB SDK,
 * the same way tmsDirectoryActions owns Customer and Location. Booking itself
 * is not here — a load's carrier is assigned by tmsShipmentActions, which is
 * where the transaction across the shipment tables already lives.
 *
 * 30s like the directory Lambda: every action is a handful of reads and one
 * conditional write or transaction.
 */
export const tmsCarrierActions = defineFunction({
  name: 'tms-carrier-actions',
  entry: './handler.ts',
  resourceGroupName: 'tms',
  timeoutSeconds: 30,
})
