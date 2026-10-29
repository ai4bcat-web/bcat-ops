/**
 * Step J — the stub adapter.
 *
 * A stub is honest or it is worse than nothing: it says STUB, it says what a live call
 * *would* have done, and its id is unmistakably not a provider's. It touches no
 * business record — `factor` takes a sample and has no shipment parameter at all, so
 * there is nothing for it to release into AR behind the gate.
 */
import { modeOf } from './health'
import { squareCustomerImportSample } from './customerImport'
import type { Adapter, AdapterContext, AdapterResult, Capability, ProviderDescriptor } from './types'

const STUB_PREFIX = 'STUB — '

/** What a live call would have done, per capability. Deterministic, no clock, no RNG. */
function wouldHaveDone(d: ProviderDescriptor, capability: Capability): string {
  switch (capability) {
    case 'connect':
      return `A live ${d.label} connection would have exchanged these credentials for a session.`
    case 'validate':
      return `A live ${d.label} connection would have run: ${d.validateHow.describe}`
    case 'post':
      return `A live ${d.label} connection would have posted this shipment to the ${d.label} board.`
    case 'track':
      return `A live ${d.label} connection would have started ${d.label} tracking on this shipment.`
    case 'quote':
      return `A live ${d.label} connection would have asked ${d.label} for a rate on this lane.`
    case 'factor':
      return `A live ${d.label} connection would have sent this invoice sample to ${d.label} for funding.`
    case 'sync':
      return `A live ${d.label} connection would have synced this record with ${d.label}.`
  }
}

function stubResult(d: ProviderDescriptor, capability: Capability, sample: Record<string, unknown>): AdapterResult {
  return {
    mode: 'STUB',
    ok: true,
    message: `${STUB_PREFIX}no call was made. ${wouldHaveDone(d, capability)}`,
    externalId: `stub:${crypto.randomUUID()}`,
    detail: { provider: d.key, capability, sample },
  }
}

/**
 * Every capability the descriptor declares, and not one more: the page offers a
 * *Run stub* button per capability, and a button that calls a method the provider
 * never claimed would be a capability invented by the framework.
 */
export function stubAdapter(d: ProviderDescriptor): Adapter {
  const declared = new Set<Capability>(d.capabilities)

  const adapter: Adapter = {
    validate: async (ctx: AdapterContext) => ({
      status: 'UNABLE_TO_VERIFY',
      reason: d.applicability === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : 'NO_CREDENTIALS',
      detail:
        d.applicability === 'NOT_APPLICABLE'
          ? `${d.label} is not applicable: ${d.notApplicableReason ?? 'no BCAT equivalent'}. No call was made.`
          : `${d.label} has no usable credential, so no call was made.`,
      checkedAt: ctx.now,
    }),
  }

  if (declared.has('connect')) {
    adapter.connect = async (_ctx: AdapterContext, input: Record<string, unknown>) => stubResult(d, 'connect', input)
  }
  if (declared.has('post')) {
    adapter.post = async (_ctx: AdapterContext, input: Record<string, unknown>) => stubResult(d, 'post', input)
  }
  if (declared.has('track')) {
    adapter.track = async (_ctx: AdapterContext, input: Record<string, unknown>) => stubResult(d, 'track', input)
  }
  if (declared.has('quote')) {
    adapter.quote = async (_ctx: AdapterContext, input: Record<string, unknown>) => stubResult(d, 'quote', input)
  }
  if (declared.has('factor')) {
    // Two parameters, and the second is a sample. No shipment id reaches a stub.
    adapter.factor = async (_ctx: AdapterContext, sample: Record<string, unknown>) => stubResult(d, 'factor', sample)
  }
  if (declared.has('sync')) {
    adapter.sync = async (_ctx: AdapterContext, input: Record<string, unknown>) => {
      // The Square stub returns real-shaped customer-import rows when no sample
      // is supplied, so the Car Shipping board has something to consume before
      // credentials exist. Every other provider just echoes the sample back.
      const sample =
        d.key === 'SQUARE' && Object.keys(input).length === 0
          ? { rows: squareCustomerImportSample() }
          : input
      return stubResult(d, 'sync', sample)
    }
  }

  return adapter
}

/**
 * The live adapter only when there is genuinely something live to call — every
 * required credential present and unneutered — and only when one was supplied.
 * Everything else falls back to the stub, which is the whole point of the step.
 */
export function adapterFor(
  d: ProviderDescriptor,
  creds: Record<string, string>,
  live?: Adapter,
): Adapter {
  if (live && modeOf(d, creds) === 'LIVE') return live
  return stubAdapter(d)
}
