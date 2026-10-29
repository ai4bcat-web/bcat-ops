/**
 * Step J — the integration framework's one contract.
 *
 * Everything else in `src/lib/integrations` (the registry, the adapters, the health
 * rules, the credential store) and every consumer (the provider pages, the directory
 * Lambda, the public API routes) is typed from here, so adding a provider is one
 * object in `registry.ts` and nothing else.
 *
 * Pure types and unions only: this file is imported by the browser bundle and by
 * Lambdas through relative paths, so it must not pull in a runtime dependency.
 */

/** Every provider the brokerage can hold a connection to. Spec §8.1 plus the stack's own. */
export type ProviderKey =
  // Load boards and posting
  | 'DAT'
  | 'TRUCKSTOP'
  | 'LOADBOARD_NETWORK'
  | 'FREIGHTLINK'
  | 'CONVOY'
  // Capacity
  | 'PARADE'
  | 'GREENSCREENS'
  // Carrier tracking
  | 'TRUCKER_TOOLS'
  | 'MACROPOINT'
  | 'LOAD_MARKET'
  | 'PROJECT44'
  // Carrier compliance
  | 'HIGHWAY'
  | 'MYCARRIERPACKETS'
  | 'RMIS'
  // Factoring
  | 'OTR'
  | 'HAULPAY'
  | 'DENIM'
  | 'ARTISPAY'
  | 'TRIUMPH'
  // Accounting
  | 'QUICKBOOKS_ONLINE'
  | 'QUICKBOOKS_DESKTOP'
  | 'SAGE50'
  // Fuel, insurance, rating
  | 'WEX_EFS'
  | 'LOADSURE'
  | 'SEVEN_L'
  | 'SMC3'
  // BCAT's own API and EDI
  | 'OPENAPI'
  | 'ORDERFUL'
  // E-mail, messaging, CRM
  | 'GMAIL'
  | 'OUTLOOK'
  | 'SLACK'
  | 'TWILIO'
  | 'HUBSPOT'
  // The stack's own live providers
  | 'ANTHROPIC'
  | 'GOOGLE_MAPS'
  | 'MOTIVE'
  | 'BLUE_INK'
  | 'PAYCHEX'
  | 'JOBSDONE'

export type IntegrationCategory =
  | 'LOAD_BOARD'
  | 'CAPACITY'
  | 'TRACKING'
  | 'COMPLIANCE'
  | 'FACTORING'
  | 'ACCOUNTING'
  | 'FUEL'
  | 'INSURANCE'
  | 'RATING'
  | 'MESSAGING'
  | 'EMAIL'
  | 'AI'
  | 'MAPS'
  | 'CRM'
  | 'EDI'
  | 'API'
  | 'TELEMATICS'
  | 'PAYROLL'
  | 'DOCUMENTS'

/**
 * Where the credential lives — never in DynamoDB and never in the client.
 *
 * `STACK`   an Amplify `secret()` already on the stack; shown by name, validated, never edited here.
 * `PAGE`    entered on the provider page, written to `/bcat/integrations/<poolId>/<PROVIDER>`.
 * `BRIDGE`  inbound only (an Apps Script posting to a Function URL with the shared intake secret).
 * `SCRIPT`  provisioned by a repo script into its own SSM path (Twilio's dispatch config).
 * `OWN`     BCAT issues the credential itself (the public API's clients).
 * `NONE`    nothing to hold (a provider that is not applicable, or one MVMNT would run).
 */
export type CredentialSource = 'NONE' | 'STACK' | 'PAGE' | 'BRIDGE' | 'SCRIPT' | 'OWN'

export type Capability = 'connect' | 'validate' | 'post' | 'track' | 'quote' | 'factor' | 'sync'

export const CAPABILITIES: Capability[] = [
  'connect',
  'validate',
  'post',
  'track',
  'quote',
  'factor',
  'sync',
]

export type Applicability = 'LIVE_CAPABLE' | 'NOT_APPLICABLE'

/**
 * What a provider's adapter is allowed to read of the freight (invariant 4, printed on
 * the page so the answer is never a guess).
 *
 * `NONE`         no shipment is read at all.
 * `WORKING_SET`  the shipments a signed-in user already sees.
 * `IDENTITY`     one shipment, looked up by its own number by a caller holding its id.
 */
export type LoadsRead = 'NONE' | 'WORKING_SET' | 'IDENTITY'

export interface CredentialField {
  key: string
  label: string
  /** A secret is masked in the UI, stored encrypted, and never echoed back. */
  secret: boolean
  hint?: string
  kind?: 'text' | 'email' | 'password' | 'url'
  /** A field the provider does not require to connect (an optional invite URL). */
  optional?: boolean
}

/**
 * `json` is an opaque object a provider extra owns (QuickBooks' account and charge-code
 * mapping). It is validated as a plain object and never rendered in the behaviour card.
 */
export type SettingsFieldType = 'boolean' | 'number' | 'text' | 'select' | 'json'

export interface SettingsField {
  key: string
  label: string
  type: SettingsFieldType
  hint?: string
  options?: Array<{ value: string; label: string }>
  defaultValue?: string | number | boolean | Record<string, unknown> | null
  min?: number
  max?: number
  /** A number field that only accepts multiples of this step (DAT's refresh interval). */
  step?: number
}

/** How `VALIDATE_INTEGRATION` proves the credential — one read call, or why there is none. */
export interface ValidateHow {
  /** Human sentence printed on the page: "GET https://api.gomotive.com/v1/vehicle_locations". */
  describe: string
  /** The adapter key the Lambda dispatches on; absent when nothing can be called. */
  liveCheck?:
    | 'OTR_BROKER_CHECK'
    | 'MOTIVE_VEHICLE_LOCATIONS'
    | 'BLUE_INK_VEHICLES'
    | 'GOOGLE_GEOCODE'
    | 'ANTHROPIC_MODELS'
    | 'SLACK_AUTH_TEST'
    | 'TWILIO_ACCOUNT'
    | 'QBO_COMPANY_INFO'
    | 'HUBSPOT_CONTACTS'
    | 'PAYCHEX_TOKEN'
    | 'BRIDGE_LAST_INBOUND'
    | 'OPENAPI_SELF'
}

export interface ProviderDescriptor {
  key: ProviderKey
  label: string
  category: IntegrationCategory
  credentialSource: CredentialSource
  /** The fields the page asks for when `credentialSource` is PAGE. */
  credentialFields: CredentialField[]
  /** The Amplify secret names shown read-only when `credentialSource` is STACK. */
  stackSecretNames: string[]
  settingsFields: SettingsField[]
  capabilities: Capability[]
  /**
   * The capabilities that have a REAL implementation in this repo today. Everything else
   * is a stub no matter how many credentials are stored, which is what keeps a page from
   * claiming a provider "runs on its own schedule" when nothing calls it. Defaults to
   * `['validate']` when `validateHow.liveCheck` is set, and to `[]` otherwise.
   */
  liveCapabilities?: Capability[]
  validateHow: ValidateHow
  applicability: Applicability
  /** Required when `applicability` is NOT_APPLICABLE; printed verbatim on the page. */
  notApplicableReason?: string
  loadsRead: LoadsRead
  /** The one sentence under "What this feeds". */
  feeds: string
  docsUrl?: string
  /** Where the live action already lives, when one does (Send to Factor, the lanes page). */
  liveLink?: { label: string; to: string }
  /** The repo path that owns the credential for SCRIPT/BRIDGE sources, shown on the page. */
  managedBy?: string
  /** Anything the page must say out loud (OTR has no board listing; Highway is vendor-provisioned). */
  note?: string
}

export type IntegrationStatus = 'NOT_CONNECTED' | 'CONNECTED' | 'DISCONNECTED'

export type IntegrationHealthStatus =
  | 'UNKNOWN'
  | 'OK'
  | 'INVALID_CREDENTIALS'
  | 'UNABLE_TO_VERIFY'

export type IntegrationHealthReason =
  | 'OK'
  | 'NO_CREDENTIALS'
  | 'NEUTERED_ON_DEV'
  | 'PROVIDER_UNREACHABLE'
  | 'NO_VALIDATE_ENDPOINT'
  | 'NOT_APPLICABLE'
  | 'STUB'
  | 'INVALID_CREDENTIALS'

export interface Health {
  status: IntegrationHealthStatus
  reason?: IntegrationHealthReason
  /** Redacted before it is stored or shown; never carries a credential value. */
  detail?: string
  checkedAt: string
}

export type IntegrationMode = 'STUB' | 'LIVE'

export interface AdapterResult {
  mode: IntegrationMode
  ok: boolean
  /** A stub's message always begins `STUB — `. */
  message: string
  /** A stub's id always begins `stub:`; never a plausible provider id. */
  externalId?: string
  detail?: Record<string, unknown>
}

export interface AdapterContext {
  provider: ProviderKey
  credentials: Record<string, string>
  settings: Record<string, unknown>
  now: string
}

/** A capability input is always a sample on a stub: no business record is touched. */
export interface Adapter {
  validate(ctx: AdapterContext): Promise<Health>
  post?(ctx: AdapterContext, input: Record<string, unknown>): Promise<AdapterResult>
  track?(ctx: AdapterContext, input: Record<string, unknown>): Promise<AdapterResult>
  quote?(ctx: AdapterContext, input: Record<string, unknown>): Promise<AdapterResult>
  /** Takes a sample only — the one live factor path stays F's gated SEND_TO_FACTOR. */
  factor?(ctx: AdapterContext, sample: Record<string, unknown>): Promise<AdapterResult>
  sync?(ctx: AdapterContext, input: Record<string, unknown>): Promise<AdapterResult>
  connect?(ctx: AdapterContext, input: Record<string, unknown>): Promise<AdapterResult>
}

/** Last four characters of a stored secret field — the only part that ever leaves SSM. */
export interface CredentialMaskEntry {
  key: string
  last4: string
}

export interface IntegrationEvent {
  at: string
  action: string
  by: string
  outcome: string
  detail?: string
}

/** The `Integration` row as the client sees it. */
export interface IntegrationRecord {
  id: string
  provider: string
  /** `WEBHOOK_EVENT` rows are idempotency receipts written by the public webhook route. */
  kind: 'PROVIDER' | 'API_CLIENT' | 'WEBHOOK_EVENT'
  category?: IntegrationCategory | null
  mode: IntegrationMode
  credentialSource: CredentialSource
  credentialRef?: string | null
  credentialMask?: CredentialMaskEntry[] | null
  status: IntegrationStatus
  health: IntegrationHealthStatus
  healthReason?: IntegrationHealthReason | null
  healthDetail?: string | null
  lastCheckAt?: string | null
  lastCheckBy?: string | null
  lastOkAt?: string | null
  settings?: Record<string, unknown> | null
  capabilities?: string[] | null
  lastStubAt?: string | null
  stubCount?: number | null
  connectedAt?: string | null
  connectedBy?: string | null
  disconnectedAt?: string | null
  disconnectedBy?: string | null
  /** Inbound webhook receipts (the provider row, not the per-event rows). */
  lastWebhookAt?: string | null
  webhookCount?: number | null
  /** Computed by LIST_INTEGRATIONS; the fields the brokerage still has to supply. */
  missingCredentials?: string[] | null
  /** API clients only. */
  name?: string | null
  scopes?: string[] | null
  lastUsedAt?: string | null
  expiresAt?: string | null
  revokedAt?: string | null
  events?: IntegrationEvent[] | null
  createdBy?: string | null
  updatedBy?: string | null
  version?: number | null
  createdAt?: string
  updatedAt?: string
}

/** What the state badge shows: `status` × `health`, in the kit's own tones. */
export interface IntegrationBadge {
  label: string
  tone: 'blue' | 'green' | 'orange' | 'pink' | 'purple' | 'red' | 'turquoise' | 'gray'
}
