import { defineFunction } from '@aws-amplify/backend'

/**
 * ses-delivery-events — SES says what happened to an e-mail after it accepted it. Every
 * ShipmentNotice send is tagged with its notice id and the `bcat-notices-<branch>` configuration
 * set; that set publishes Delivery / Bounce / Complaint / Reject / DeliveryDelay to EventBridge,
 * and this writes the outcome onto the notice row so the invoice's e-mail history can say
 * "Delivered" or "Bounced" instead of only "SES accepted it" (invoice 20027, 2026-11-13).
 *
 * Its own resource group: the data stack is at its CloudFormation size limit.
 */
export const sesDeliveryEvents = defineFunction({
  name: 'ses-delivery-events',
  entry: './handler.ts',
  resourceGroupName: 'sesEvents',
  timeoutSeconds: 30,
})
