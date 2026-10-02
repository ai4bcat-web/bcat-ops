/**
 * OTR Solutions Carrier TMS v3 client.
 *
 * Wraps the endpoints the factoring queue needs: auth, broker approval, invoice
 * creation, document upload, and status read-back. Every call is typed at the
 * boundary so a shape change from OTR surfaces as a thrown error rather than an
 * `undefined` flowing into a DynamoDB write.
 *
 * Base URL is injected (OTR_BASE_URL) so staging and production are a config
 * change, never a code change. Verified against staging 2026-09-30:
 *   POST /auth/token        -> 200, bearer + refresh, expires_in 7199
 *
 * Money: OTR takes InvoiceAmount as a DOLLAR number. bcat-ops stores Load.rate
 * in CENTS. `centsToDollars` is the only place that conversion is allowed to
 * happen — never inline at a call site.
 */

export const OTR_STAGING_BASE = 'https://servicesstg.otrsolutions.com/CarrierTmsV3'

/** Document classifications OTR accepts on upload. */
export const OTR_DOC_TYPE = {
  POD: 1,
  RATE_CONFIRMATION: 3,
  NOTICE_OF_ASSIGNMENT: 4,
  LETTER_OF_RELEASE: 5,
  CARRIER_PACKET: 6,
  OTHER: 7,
} as const
export type OtrDocType = (typeof OTR_DOC_TYPE)[keyof typeof OTR_DOC_TYPE]

/** Broker approval decisions. A 402 on create means the MC was never approved. */
export type BrokerDecision = 'APPROVED' | 'CALL OFFICE' | 'NOT APPROVED' | 'UNKNOWN'

/**
 * Invoice statuses OTR reports. Mirrored onto the queue row so the board in
 * bcat-ops matches OTR's without a human re-keying it.
 */
export const OTR_INVOICE_STATUSES = [
  'Pending',
  'Advance Pending',
  'Advance Paid',
  'Approved',
  'Client Request',
  'Duplicate',
  'OTR Follow-Up',
  'Paid',
] as const
export type OtrInvoiceStatus = (typeof OTR_INVOICE_STATUSES)[number]

/** Every field OTR requires on create. All are mandatory — there are no optionals. */
export interface OtrInvoicePayload {
  InvoiceNo: string
  BrokerMC: string
  PoNumber: string
  InvoiceAmount: number // dollars
  InvoiceDate: string // YYYY-MM-DD
  FromCity: string
  FromState: string
  FromZip: string
  ToCity: string
  ToState: string
  ToZip: string
}

export interface OtrCreateInvoiceResult {
  invoiceId: number
  invoiceNo: string
  poNumber: string
  clientName: string
  brokerName: string
  /** OTR sets this when the invoice number already exists for the client. */
  invoiceExists: boolean
  isDuplicate: boolean
  message: string | null
}

export interface OtrInvoiceDetails {
  status: string
  invoiceNo: string
  poNumber: string
  customerName: string
  invoiceAmount: number
  scheduleId: string | null
  fuelAdvanceStatus: string | null
  submittedDate: string | null
  lastUpdated: string | null
  origin: { city: string; state: string } | null
  destination: { city: string; state: string } | null
}

export class OtrError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    /** True when the caller can fix this by re-authenticating. */
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'OtrError'
  }
}

/** Load.rate is cents. OTR wants dollars. Rounds to the cent, never to the dollar. */
export function centsToDollars(cents: number): number {
  return Math.round(cents) / 100
}

interface TokenState {
  accessToken: string
  refreshToken: string | null
  /** Epoch ms. We refresh early so a long submit never straddles an expiry. */
  expiresAt: number
}

export interface OtrClientConfig {
  baseUrl: string
  subscriptionKey: string
  username: string
  password: string
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Seconds of headroom before expiry at which we re-auth. Default 300. */
  refreshSkewSeconds?: number
}

export class OtrClient {
  private token: TokenState | null = null
  private readonly fetchImpl: typeof fetch
  private readonly skewMs: number

  constructor(private readonly cfg: OtrClientConfig) {
    if (!cfg.baseUrl) throw new Error('OTR baseUrl is required')
    if (!cfg.subscriptionKey) throw new Error('OTR subscriptionKey is required')
    this.fetchImpl = cfg.fetchImpl ?? fetch
    this.skewMs = (cfg.refreshSkewSeconds ?? 300) * 1000
  }

  /** Bearer token, minted on first use and reused until it nears expiry. */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - this.skewMs) {
      return this.token.accessToken
    }
    return this.authenticate()
  }

  private async authenticate(): Promise<string> {
    const body = new URLSearchParams({
      username: this.cfg.username,
      password: this.cfg.password,
    })
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/auth/token`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.cfg.subscriptionKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    })
    const text = await res.text()
    if (!res.ok) {
      // Never echo the request body — it carries the password.
      throw new OtrError(`OTR auth failed (${res.status})`, res.status, text)
    }
    const json = JSON.parse(text) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (!json.access_token) {
      throw new OtrError('OTR auth returned no access_token', res.status, text)
    }
    this.token = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: Date.now() + (json.expires_in ?? 7200) * 1000,
    }
    return this.token.accessToken
  }

  private async authedHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return {
      'Ocp-Apim-Subscription-Key': this.cfg.subscriptionKey,
      Authorization: `Bearer ${await this.accessToken()}`,
      ...extra,
    }
  }

  /**
   * One retry on 401: a token can expire between the skew check and the call.
   * Anything else is surfaced to the caller rather than silently swallowed.
   */
  private async request(path: string, init: RequestInit, retryOn401 = true): Promise<Response> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, init)
    if (res.status === 401 && retryOn401) {
      this.token = null
      const headers = await this.authedHeaders(
        // Preserve any non-auth headers the caller set (e.g. X-Invoice-Doc-Type).
        Object.fromEntries(
          Object.entries((init.headers ?? {}) as Record<string, string>).filter(
            ([k]) => !['authorization', 'ocp-apim-subscription-key'].includes(k.toLowerCase()),
          ),
        ),
      )
      return this.fetchImpl(`${this.cfg.baseUrl}${path}`, { ...init, headers })
    }
    return res
  }

  /**
   * Broker approval, checked BEFORE submitting so an unapproved MC shows on the
   * queue row instead of failing the submit with a 402.
   */
  async brokerCheck(opts: { brokerMc?: string; brokerDot?: string }): Promise<{
    decision: BrokerDecision
    message: string
    /** The broker's name, when OTR's reply carries one. See brokerNameFrom. */
    brokerName: string | null
    /** The whole reply, logged by the caller so the shape stops being a guess. */
    raw: unknown
  }> {
    if (!opts.brokerMc && !opts.brokerDot) {
      throw new Error('brokerCheck requires brokerMc or brokerDot')
    }
    const qs = new URLSearchParams()
    if (opts.brokerMc) qs.set('brokerMc', opts.brokerMc)
    if (opts.brokerDot) qs.set('brokerDot', opts.brokerDot)

    const res = await this.request(`/broker-check?${qs}`, {
      method: 'GET',
      headers: await this.authedHeaders({ Accept: 'application/json' }),
    })
    const text = await res.text()
    if (!res.ok) {
      // 402 here means the MC itself is invalid — a data problem, not a transport one.
      throw new OtrError(`Broker check failed (${res.status})`, res.status, text)
    }
    let raw: unknown = null
    try {
      raw = JSON.parse(text)
    } catch {
      // A non-JSON 200 is OTR telling us something we do not model yet. The caller logs it.
      raw = text
    }
    const message = (raw as { message?: string } | null)?.message ?? ''
    return {
      decision: normalizeDecision(message),
      message,
      brokerName: brokerNameFrom(raw),
      raw,
    }
  }

  /** Create the invoice. Returns OTR's invoiceId, which every document upload needs. */
  async createInvoice(payload: OtrInvoicePayload): Promise<OtrCreateInvoiceResult> {
    const res = await this.request('/invoices', {
      method: 'POST',
      headers: await this.authedHeaders({
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }),
      body: JSON.stringify(payload),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new OtrError(
        res.status === 402
          ? `Broker MC ${payload.BrokerMC} is not approved by OTR`
          : res.status === 409
            ? `Duplicate invoice or PO already exists at OTR (${payload.InvoiceNo})`
            : `Create invoice failed (${res.status})`,
        res.status,
        text,
      )
    }
    const j = JSON.parse(text) as Record<string, unknown>
    const invoiceId = Number(j.invoiceId)
    if (!Number.isFinite(invoiceId)) {
      throw new OtrError('Create invoice returned no invoiceId', res.status, text)
    }
    return {
      invoiceId,
      invoiceNo: String(j.invoiceNo ?? payload.InvoiceNo),
      poNumber: String(j.poNumber ?? payload.PoNumber),
      clientName: String(j.clientName ?? ''),
      brokerName: String(j.brokerName ?? ''),
      invoiceExists: Boolean(j.invoiceExists),
      isDuplicate: Boolean(j.IsDuplicate ?? j.isDuplicate),
      message: (j.Message ?? j.message ?? null) as string | null,
    }
  }

  /**
   * Attach a document to an invoice. `file` is raw bytes — the caller reads them
   * from S3 so this module never learns about buckets.
   */
  async uploadDocument(opts: {
    invoiceId: number | string
    docType: OtrDocType
    fileName: string
    contentType: string
    file: Uint8Array
    sendEmail?: boolean
  }): Promise<{ message: string; invoiceId: string }> {
    const form = new FormData()
    form.append('file', new Blob([opts.file as BlobPart], { type: opts.contentType }), opts.fileName)
    form.append('invoiceid', String(opts.invoiceId))
    form.append('InvoiceDocTypes', String(opts.docType))
    form.append('SendEmail', opts.sendEmail ? 'true' : 'false')
    form.append('DocumentType', 'invoice-file-upload')

    // Content-Type is deliberately unset: fetch adds the multipart boundary.
    const res = await this.request('/documents/upload', {
      method: 'POST',
      headers: await this.authedHeaders({
        'X-Invoice-Doc-Type': String(opts.docType),
        Accept: 'application/json',
      }),
      body: form,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new OtrError(
        res.status === 413
          ? `${opts.fileName} exceeds OTR's upload size limit`
          : `Document upload failed (${res.status})`,
        res.status,
        text,
      )
    }
    const j = JSON.parse(text) as { message?: string; invoiceId?: string }
    return { message: j.message ?? '', invoiceId: String(j.invoiceId ?? opts.invoiceId) }
  }

  /**
   * Ask OTR what a path answers, without acting on anything.
   *
   * We know four endpoints because those are the four we were given. Pulling the invoices
   * that already exist on OTR's portal — and updating one — needs endpoints nobody here has
   * seen documented, and guessing at them one deploy at a time is a bad way to find out.
   *
   * GET only, and the body is truncated: this exists to establish what is THERE, and a
   * probe that could change something at a factoring company is not a probe.
   */
  async probe(path: string): Promise<{ path: string; status: number; body: string }> {
    if (!path.startsWith('/')) throw new Error('probe path must start with /')
    try {
      const res = await this.request(path, {
        method: 'GET',
        headers: await this.authedHeaders({ Accept: 'application/json' }),
      })
      const text = await res.text()
      return { path, status: res.status, body: text.slice(0, 1200) }
    } catch (err) {
      return { path, status: 0, body: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Read-back for the board: current status of one invoice. */
  async getInvoice(invoiceId: number | string): Promise<OtrInvoiceDetails> {
    const res = await this.request(`/invoices/${encodeURIComponent(String(invoiceId))}`, {
      method: 'GET',
      headers: await this.authedHeaders({ Accept: 'application/json' }),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new OtrError(`Get invoice ${invoiceId} failed (${res.status})`, res.status, text)
    }
    const inv = ((JSON.parse(text) as { invoice?: Record<string, unknown> }).invoice ??
      {}) as Record<string, unknown>
    const lane = (inv.lane ?? {}) as Record<string, { city?: string; state?: string }>
    return {
      // OTR capitalizes this key; tolerate either spelling.
      status: String(inv.Status ?? inv.status ?? ''),
      invoiceNo: String(inv.invoiceNo ?? ''),
      poNumber: String(inv.poNumber ?? ''),
      customerName: String(inv.customerName ?? ''),
      invoiceAmount: Number(inv.invoiceAmount ?? 0),
      scheduleId: inv.scheduleId ? String(inv.scheduleId) : null,
      fuelAdvanceStatus: inv.fuelAdvanceStatus ? String(inv.fuelAdvanceStatus) : null,
      submittedDate: inv.submittedDate ? String(inv.submittedDate) : null,
      lastUpdated: inv.lastUpdated ? String(inv.lastUpdated) : null,
      origin: lane.origin
        ? { city: String(lane.origin.city ?? ''), state: String(lane.origin.state ?? '') }
        : null,
      destination: lane.destination
        ? { city: String(lane.destination.city ?? ''), state: String(lane.destination.state ?? '') }
        : null,
    }
  }
}

/** OTR returns the decision as free text; map it onto the documented set. */
/**
 * The broker's name out of a broker-check reply, if there is one.
 *
 * We only ever read `message` from this endpoint, so whether OTR also returns who the MC
 * belongs to was never established either way — and the name is exactly what the factoring
 * queue wants, since an MC is nine digits nobody recognises. Rather than hard-code a field
 * we have not seen, this looks for a string field whose key names a broker or a client,
 * and returns null when there is none. Both outcomes are correct: if OTR sends a name we
 * use it, and if it does not, the office types one.
 *
 * `createInvoice` definitely returns brokerName and clientName, but only once an invoice
 * exists — far too late to label a row that has not been submitted yet.
 */
export function brokerNameFrom(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const keys = ['brokerName', 'clientName', 'debtorName', 'customerName', 'name', 'companyName']
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  // Some replies nest the subject one level down.
  for (const nested of Object.values(record)) {
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const found = brokerNameFrom(nested)
      if (found) return found
    }
  }
  return null
}

export function normalizeDecision(message: string): BrokerDecision {
  const m = message.trim().toUpperCase()
  if (m.includes('NOT APPROVED')) return 'NOT APPROVED'
  if (m.includes('CALL OFFICE')) return 'CALL OFFICE'
  if (m.includes('APPROVED')) return 'APPROVED'
  return 'UNKNOWN'
}
