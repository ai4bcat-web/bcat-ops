import { defineFunction } from '@aws-amplify/backend'

/**
 * The second Load-stream consumer. Where `load-tracking-projector` turns a stamped
 * stop time into a status, this one turns a status into the e-mails that status is
 * supposed to cause: the customer's milestone notice, and — once every leg of a
 * shipment has delivered — the request to the outside carrier for their POD and
 * invoice, carrying a CARRIER_UPLOAD link.
 *
 * Every send is a `ShipmentNotice` row written first, on a deterministic id
 * (`ms:<shipmentId>:<milestone>`, `pod:<loadCarrierId>`) with a conditional Put, so
 * a stream retry or the second leg of a two-leg shipment collides in DynamoDB
 * rather than in somebody's inbox. SES is denied on dev, where the rows therefore
 * land NOT_SENT carrying the text they rendered — which is the honest outcome.
 */
export const shipmentNotifier = defineFunction({
  name: 'shipment-notifier',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 60,
  memoryMB: 512,
})
