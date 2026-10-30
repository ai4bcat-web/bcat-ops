import { defineFunction, secret } from '@aws-amplify/backend'

/**
 * Inbound e-mail intake for per-shipment tracking threads.
 *
 * Receives POSTs from the Gmail bridge (or SES inbound) for messages addressed
 * to `tracking+<shipmentId>@<domain>`, verifies the shared webhook secret, routes
 * the message to its shipment, and invokes `tms-tracking-actions` with
 * `INGEST_SHIPMENT_MESSAGE`.
 *
 * On dev, when SES inbound is not configured or the invoke fails, the parsed
 * message is logged to CloudWatch as proof.
 */
export const shipmentEmailIntake = defineFunction({
  name: 'shipment-email-intake',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  environment: {
    // Shared webhook secret — the SAME one the existing fuel/intake/factoring bridges use.
    SHIPMENT_EMAIL_INTAKE_SECRET: secret('INTAKE_WEBHOOK_SECRET'),
    // Mailbox that owns the per-shipment plus addresses (e.g. ai4bcat@gmail.com).
    THREAD_MAILBOX: 'ai4bcat@gmail.com',
  },
})
