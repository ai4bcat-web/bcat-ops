/**
 * The one helper every Lambda uses to record a customer change in AuditLog with its reason.
 * Storage-agnostic: the caller passes its own audit writer (each function already has one).
 *
 *   await auditCustomerChange(write, {
 *     customerId, before, after, source: 'OTR rejected → manual invoice', reason: otrReason,
 *   })
 *
 * Writes nothing when no customer field actually changed. The shape is in src/lib/customerAudit.ts.
 */
import {
  buildCustomerAuditChanges,
  CUSTOMER_AUDIT_ENTITY_TYPE,
  diffCustomer,
  type CustomerAuditChanges,
} from '../../../src/lib/customerAudit'

export {
  changeNeedsReason, diffCustomer, REASON_REQUIRED_FIELDS, REASON_REQUIRED_MESSAGE,
  CUSTOMER_AUDIT_ENTITY_TYPE,
} from '../../../src/lib/customerAudit'

export type CustomerAuditWriter = (
  entityType: string,
  entityId: string,
  action: string,
  changes: Record<string, unknown>,
) => Promise<void>

export async function auditCustomerChange(
  write: CustomerAuditWriter,
  input: {
    customerId: string
    before: Record<string, unknown> | null
    after: Record<string, unknown>
    source: string
    reason?: string | null
    /** Defaults to CUSTOMER_CREATED when `before` is null, else CUSTOMER_UPDATED. */
    action?: string
    name?: string | null
  },
): Promise<CustomerAuditChanges | null> {
  const fields = diffCustomer(input.before, input.after)
  if (fields.length === 0) return null
  const changes = buildCustomerAuditChanges({
    fields,
    reason: input.reason,
    source: input.source,
    name: input.name ?? (typeof input.after.name === 'string' ? input.after.name : (input.before?.name as string | undefined) ?? null),
  })
  const action = input.action ?? (input.before ? 'CUSTOMER_UPDATED' : 'CUSTOMER_CREATED')
  await write(CUSTOMER_AUDIT_ENTITY_TYPE, input.customerId, action, changes as unknown as Record<string, unknown>)
  return changes
}
