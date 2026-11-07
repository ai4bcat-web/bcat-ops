/**
 * The async payload vendor-ap-intake hands the extractor for a new VendorPayable row.
 *
 * Below the stage that creates WorkflowRun the target is production's `vendor-ap-extract`, which
 * reads `{ id }`. From that stage the target is `workflow-agent`, which speaks the run hand-off
 * shape. backend.ts sets VENDOR_AP_EXTRACT_TARGET=workflow-agent only in the second case, so an
 * unset value (production today) keeps the legacy payload.
 */
export function extractPayload(target: string | undefined, rowId: string): Record<string, unknown> {
  return target === 'workflow-agent'
    ? { runFor: { sourceKind: 'VENDOR_PAYABLE', sourceId: rowId, inboxRole: 'AP', provider: 'GMAIL' } }
    : { id: rowId }
}
