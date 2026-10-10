/**
 * Where the dispatch Lambdas get their Twilio credentials and number.
 *
 * Everything lives under one SSM path (DISPATCH_PARAM_PATH, e.g. /bcat/dispatch/<pool>/)
 * written by scripts/dispatchTwilioSetup.mts, and is read at run time rather than baked
 * in at deploy: the stack can go out before the number is bought, and rotating a key is a
 * parameter change rather than a release. Cached for a few minutes per container.
 */
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm'
import type { TwilioCreds } from './twilio'

export interface DispatchConfig extends TwilioCreds {
  /** The Elk Grove number drivers text and call, E.164. */
  dispatchNumber: string
  /** Shared secret every webhook URL carries as ?t=. */
  webhookSecret: string
}

const CACHE_MS = 5 * 60 * 1000
let cached: { at: number; value: DispatchConfig | null } | null = null

export function resetDispatchConfigCache(): void {
  cached = null
}

/** Assemble the config from the parameters under the path, or null when it is not set up. */
export function configFromParams(params: Record<string, string>): DispatchConfig | null {
  const need = ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'DISPATCH_NUMBER', 'WEBHOOK_SECRET']
  if (need.some((k) => !params[k])) return null
  return {
    accountSid: params.TWILIO_ACCOUNT_SID,
    apiKeySid: params.TWILIO_API_KEY_SID,
    apiKeySecret: params.TWILIO_API_KEY_SECRET,
    authToken: params.TWILIO_AUTH_TOKEN || null,
    messagingServiceSid: params.TWILIO_MESSAGING_SERVICE_SID || null,
    dispatchNumber: params.DISPATCH_NUMBER,
    webhookSecret: params.WEBHOOK_SECRET,
  }
}

export async function loadDispatchConfig(ssm: SSMClient = new SSMClient({}), path = process.env.DISPATCH_PARAM_PATH ?? ''): Promise<DispatchConfig | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  if (!path) return null
  const prefix = path.endsWith('/') ? path : `${path}/`
  const params: Record<string, string> = {}
  let next: string | undefined
  do {
    const page = await ssm.send(new GetParametersByPathCommand({ Path: prefix, WithDecryption: true, NextToken: next }))
    for (const p of page.Parameters ?? []) {
      if (p.Name && p.Value != null) params[p.Name.slice(prefix.length)] = p.Value
    }
    next = page.NextToken
  } while (next)
  const value = configFromParams(params)
  cached = { at: Date.now(), value }
  return value
}
