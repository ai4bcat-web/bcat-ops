import { defineFunction } from '@aws-amplify/backend'

/**
 * appt-request-emailer — sends an appointment-request email to a facility's
 * appointment contact (from the Location directory), straight from the Appts page.
 * Plain-text SES send from dennis@bcatcorp.com (domain-verified), so the facility's
 * reply lands in Dennis's inbox.
 */
export const apptRequestEmailer = defineFunction({
  name: 'appt-request-emailer',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 30,
  // FROM_ADDRESS wired in backend.ts.
})
