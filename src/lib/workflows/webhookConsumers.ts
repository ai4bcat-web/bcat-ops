/**
 * Step K — where an inbound webhook would go, once something is live to receive it.
 *
 * Every entry is null in K and that is the whole point: a webhook run records that the
 * payload arrived, stores it, and ends IGNORED. Nothing routes a third party's payload
 * into a business write until a consumer is written and reviewed on its own terms.
 */

export interface WebhookConsumer {
  provider: string
  describe: string
  route(payload: unknown): { action: string; input: unknown }
}

/**
 * Keyed by `Integration.provider`. A provider absent from this map and a provider
 * mapped to null mean the same thing to `consumerFor`; the explicit nulls are here so
 * the list of providers that actually send us webhooks is visible.
 */
export const CONSUMERS: Record<string, WebhookConsumer | null> = {
  PARADE: null,
  PROJECT44: null,
  MACROPOINT: null,
  TRUCKER_TOOLS: null,
  HIGHWAY: null,
  ORDERFUL: null,
  QUICKBOOKS_ONLINE: null,
  OTR: null,
  MOTIVE: null,
  TWILIO: null,
  SLACK: null,
}

export function consumerFor(provider: string): WebhookConsumer | null {
  return CONSUMERS[provider] ?? null
}
