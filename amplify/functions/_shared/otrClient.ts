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

import { buildMultipart } from './multipart'
import { sniffDoc, withExt } from './sniffDoc'
import { toAsciiSafePdf, wrapImageInPdf } from './asciiSafePdf'

export const OTR_STAGING_BASE = 'https://servicesstg.otrsolutions.com/CarrierTmsV3'

/** Parse a response body that may not be JSON at all, without throwing over it. */
function safeJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

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
  /** v2's single-line lane string, when it sent one. */
  description?: string | null
  origin: { city: string; state: string } | null
  destination: { city: string; state: string } | null
}

/**
 * Parse a response that is SUPPOSED to carry JSON, and say what went wrong when it does not.
 *
 * `JSON.parse('')` throws "Unexpected end of JSON input" — a message that describes our own
 * parser rather than anything OTR did, and which reached the office as a toast telling them
 * nothing about their invoice. OTR really does answer some requests 2xx with no body at all
 * (a bare 204 on create), so this is a case to handle rather than a thing that cannot
 * happen.
 *
 * Throws an OtrError carrying the status and the raw body, so the queue shows a sentence a
 * person can act on and CloudWatch keeps whatever OTR actually sent.
 */
function parseJsonOrThrow(text: string, status: number, what: string): Record<string, unknown> {
  const trimmed = (text ?? '').trim()
  if (!trimmed) {
    throw new OtrError(
      `${what}: OTR returned ${status} with an empty response, so there is nothing to confirm it worked. Check the invoice in the OTR portal before resubmitting.`,
      status,
      text,
    )
  }
  const parsed = safeJson(trimmed)
  if (!parsed) {
    throw new OtrError(
      `${what}: OTR returned ${status} with a response we could not read (${trimmed.slice(0, 120)})`,
      status,
      text,
    )
  }
  return parsed
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
  /*
   * Where documents go. OTR's v2 API, which is a different host path AND a different
   * subscription product — ours was only granted access to it after they widened the key.
   *
   * Invoices still go to `baseUrl` (v1). The two share invoice ids: v2's ItemPkey accepts
   * the id v1 handed back when the invoice was created, verified against live invoice
   * 16222565. Straddling two versions is not elegant, but v1 invoice creation works and
   * v1 document upload never has, so this moves exactly the half that was broken.
   *
   * Leave unset to keep uploading through v1.
   */
  uploadBaseUrl?: string
  /**
   * Our own DOT number. v2 requires it on every invoice (`ClientDOT`); v1 never asked.
   * Set from OTR_CLIENT_DOT.
   */
  clientDot?: string
  subscriptionKey: string
  username: string
  password: string
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Seconds of headroom before expiry at which we re-auth. Default 300. */
  refreshSkewSeconds?: number
}

/** v2 bases are path-versioned as `/carrier-tms/<n>`; v1 was `/CarrierTmsV3`. */
export function isV2Base(baseUrl: string): boolean {
  return /\/carrier-tms\/\d+/i.test(baseUrl)
}

export class OtrClient {
  private token: TokenState | null = null
  /** v2 issues its own token from its own /auth/token; they are not interchangeable. */
  private uploadToken: TokenState | null = null
  private readonly fetchImpl: typeof fetch
  private readonly skewMs: number

  /** True when invoices themselves go to v2 — production is v2-only. */
  private get invoicesOnV2(): boolean {
    return isV2Base(this.cfg.baseUrl)
  }

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

  /** A token for the upload host, cached separately — v1 and v2 tokens are not swappable. */
  private async uploadAccessToken(): Promise<string> {
    const base = this.cfg.uploadBaseUrl
    if (!base) return this.accessToken()
    if (this.uploadToken && Date.now() < this.uploadToken.expiresAt - this.skewMs) {
      return this.uploadToken.accessToken
    }
    return this.authenticate(base)
  }

  private async authenticate(base = this.cfg.baseUrl): Promise<string> {
    const body = new URLSearchParams({
      username: this.cfg.username,
      password: this.cfg.password,
    })
    const res = await this.fetchImpl(`${base}/auth/token`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.cfg.subscriptionKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      // A Buffer IS a Uint8Array, which fetch accepts; the DOM types only know the
      // narrower set. Passing it directly is what gets a Content-Length instead of a
      // chunked stream.
      body: body as unknown as BodyInit,
    })
    const text = await res.text()
    if (!res.ok) {
      // Never echo the request body — it carries the password.
      throw new OtrError(`OTR auth failed (${res.status})`, res.status, text)
    }
    const json = parseJsonOrThrow(text, res.status, 'OTR sign-in') as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (!json.access_token) {
      throw new OtrError('OTR auth returned no access_token', res.status, text)
    }
    const state: TokenState = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: Date.now() + (json.expires_in ?? 7200) * 1000,
    }
    if (base === this.cfg.uploadBaseUrl && base !== this.cfg.baseUrl) this.uploadToken = state
    else this.token = state
    return state.accessToken
  }

  /** Headers for the upload host, carrying ITS token. */
  private async uploadHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return {
      'Ocp-Apim-Subscription-Key': this.cfg.subscriptionKey,
      Authorization: `Bearer ${await this.uploadAccessToken()}`,
      ...extra,
    }
  }

  /** Same one-retry-on-401 as `request`, against the upload host. */
  private async uploadRequest(path: string, init: RequestInit): Promise<Response> {
    const base = this.cfg.uploadBaseUrl || this.cfg.baseUrl
    const res = await this.fetchImpl(`${base}${path}`, init)
    if (res.status !== 401) return res
    this.uploadToken = null
    this.token = null
    const headers = await this.uploadHeaders(
      Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).filter(
          ([k]) => !['authorization', 'ocp-apim-subscription-key'].includes(k.toLowerCase()),
        ),
      ),
    )
    return this.fetchImpl(`${base}${path}`, { ...init, headers })
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
    /*
     * v2 takes the MC in the PATH: GET /broker-check/{brokerMc}. v1 took a query string,
     * and against production that shape is simply not a route — the call came back 404,
     * which is how this was found rather than by reading.
     *
     * v2 has no brokerDot form, so an MC is required there; v1 accepted either.
     */
    let path: string
    if (this.invoicesOnV2) {
      if (!opts.brokerMc) throw new Error('brokerCheck on v2 requires brokerMc')
      path = `/broker-check/${encodeURIComponent(opts.brokerMc)}`
    } else {
      const qs = new URLSearchParams()
      if (opts.brokerMc) qs.set('brokerMc', opts.brokerMc)
      if (opts.brokerDot) qs.set('brokerDot', opts.brokerDot)
      path = `/broker-check?${qs}`
    }

    const res = await this.request(path, {
      method: 'GET',
      headers: await this.authedHeaders({ Accept: 'application/json' }),
    })
    const text = await res.text()
    if (!res.ok) {
      // 402 here means the MC itself is invalid — a data problem, not a transport one.
      throw new OtrError(`Broker check failed (${res.status})`, res.status, text)
    }
    // A non-JSON 200 is OTR telling us something we do not model yet. The caller logs it.
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
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
    /*
     * v2 renamed and trimmed the body. BrokerMC became CustomerMC and is a NUMBER; the
     * ZIP fields were dropped entirely; and ClientDOT — our own DOT, which v1 never asked
     * for — is required. Production speaks only v2, so this is not optional there.
     *
     * The zips are still collected and still shown on the row: they were required by v1,
     * they are what a human checks an invoice against, and OTR dropping them from the wire
     * is no reason to stop knowing them.
     */
    const body: Record<string, unknown> = this.invoicesOnV2
      ? {
          InvoiceNo: payload.InvoiceNo,
          PoNumber: payload.PoNumber,
          /*
           * BrokerMC, as a NUMBER — not CustomerMC.
           *
           * OTR's own v2 reference lists `CustomerMC` in its required-fields table and
           * then shows `BrokerMC` in the example body on the same page. The live API
           * takes BrokerMC; CustomerMC is rejected with a bare
           * `{"statusCode":400,"message":"Invalid Request"}` that names no field, which is
           * what "Create invoice failed (400)" was. Verified against production: the same
           * payload with BrokerMC returns 201 and an invoicePkey.
           */
          BrokerMC: Number(payload.BrokerMC),
          ClientDOT: this.cfg.clientDot ?? '',
          InvoiceAmount: payload.InvoiceAmount,
          InvoiceDate: payload.InvoiceDate,
          FromCity: payload.FromCity,
          FromState: payload.FromState,
          ToCity: payload.ToCity,
          ToState: payload.ToState,
        }
      : ({ ...payload } as Record<string, unknown>)

    if (this.invoicesOnV2 && !this.cfg.clientDot) {
      // Caught here rather than as an opaque 400 from OTR two calls later.
      throw new OtrError('OTR_CLIENT_DOT is not configured — v2 requires ClientDOT', 0, '')
    }

    const res = await this.request('/invoices', {
      method: 'POST',
      headers: await this.authedHeaders({
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }),
      body: JSON.stringify(body),
    })
    const text = await res.text()
    /*
     * A duplicate is the invoice we were about to create, so carry on with it.
     *
     * OTR answers a repeat POST with 409 and the SAME body, invoicePkey included. Treating
     * that as a failure meant a submit that was interrupted after the invoice was created
     * — a timeout, a retry, a second click — could never be completed, because every
     * attempt afterwards died before reaching the documents. Only a 409 that actually
     * carries an id is accepted; anything else still raises.
     */
    if (res.status === 409) {
      const dup = safeJson(text)
      const dupId = Number(dup?.invoicePkey ?? dup?.invoiceId)
      if (Number.isFinite(dupId)) {
        console.warn('[otr] invoice already exists at OTR; continuing with it', {
          invoiceNo: payload.InvoiceNo,
          invoiceId: dupId,
        })
        return {
          invoiceId: dupId,
          invoiceNo: String(dup?.invoiceNo ?? payload.InvoiceNo),
          poNumber: String(dup?.poNumber ?? payload.PoNumber),
          clientName: String(dup?.clientName ?? ''),
          brokerName: String(dup?.brokerName ?? ''),
          invoiceExists: true,
          isDuplicate: true,
          message: (dup?.Message ?? dup?.message ?? null) as string | null,
        }
      }
    }
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
    /*
     * A 204 here means OTR took the request and told us nothing — and it is NOT success.
     *
     * Reproduced against production: an invoice whose BrokerMC is not in OTR's broker
     * database comes back 204 with a zero-byte body, while the same payload with a known MC
     * returns 201 and an invoicePkey. 204 is indistinguishable from success by status alone,
     * so the only honest reading is "no invoice was created, and OTR did not say why".
     *
     * Previously this fell through to JSON.parse(''), which threw "Unexpected end of JSON
     * input" — a message about our own parser, shown to the office as the entire explanation
     * for why their load would not factor.
     */
    if (res.status === 204 || !text.trim()) {
      throw new OtrError(
        `OTR accepted the request but created nothing (${res.status}). This is what OTR does ` +
          `when it does not recognise the broker — check MC ${payload.BrokerMC} on the ` +
          `customer record, and use Check broker to confirm it before resubmitting.`,
        res.status,
        text,
      )
    }

    const j = parseJsonOrThrow(text, res.status, 'Create invoice')
    /*
     * v2 calls the id `invoicePkey`; v1 called it `invoiceId`.
     *
     * The same rename runs through the upload side, where v2 wants `ItemPkey`. Reading
     * only invoiceId left v2 throwing "Create invoice returned no invoiceId" on a response
     * that had just created the invoice.
     */
    const invoiceId = Number(j.invoicePkey ?? j.invoiceId)
    if (!Number.isFinite(invoiceId)) {
      throw new OtrError('Create invoice returned no invoice id', res.status, text)
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
   *
   * OTR accepts PDF, PNG and JPEG only, and documents 400, 401 and 413 as the ways this
   * fails. A 500 is not in their list; the two we have seen are logged with whatever they
   * said, because an undocumented failure is a conversation with them, not a guess here.
   */
  async uploadDocument(opts: {
    invoiceId: number | string
    docType: OtrDocType
    fileName: string
    contentType: string
    file: Uint8Array
    sendEmail?: boolean
    /** Force the ASCII-safe rewrite on or off; defaults to the OTR_ASCII_SAFE_PDF env. */
    asciiSafe?: boolean
  }): Promise<{ message: string; invoiceId: string }> {
    /*
     * A fresh, exactly-sized copy of the bytes.
     *
     * transformToByteArray can hand back a VIEW onto a larger buffer, and a Blob built from
     * a mis-measured view sends the wrong bytes. Copying costs one pass over a POD and
     * removes the whole class of question.
     */
    const bytes = new Uint8Array(opts.file.byteLength)
    bytes.set(opts.file)

    /*
     * The body is built here, as one Buffer, rather than handed to fetch as a FormData.
     *
     * fetch will encode a FormData perfectly well — and then STREAM it, which means
     * Transfer-Encoding: chunked and no Content-Length. That is legal HTTP, and it is also
     * the last thing on this side that had never been changed while every single document
     * we sent came back rejected: a 1 MB POD, a 139 KB rate confirmation, and two test
     * PDFs of 610 and 853 bytes, with errors that look like a parser reading a body it
     * could not frame — a null reference, and a byte count matching nothing anyone sent.
     *
     * A finished Buffer gets a Content-Length and arrives in one piece. Field names and
     * order still follow OTR's documented example exactly, and the file part carries no
     * declared type, as their own curl does.
     */
    /*
     * What the file IS, from its own bytes — not from the key's extension. We were naming
     * every POD `.pdf` and declaring it as such; a scan stored as a JPEG then reached
     * OTR's PDF reader, which answered exactly what you would expect: "Invalid or corrupt
     * pdf format".
     */
    const sniffed = sniffDoc(bytes)
    let outBytes = bytes
    let effective = sniffed
    let wrapped = false

    /*
     * An image has to become a PDF before it leaves here. Their docs list PNG and JPEG as
     * accepted; in practice a 614-byte JPEG declared as image/jpeg came back from IronPDF
     * as "Invalid or corrupt pdf format", because everything is fed to a PDF reader. Our
     * enhanced PODs are sometimes `.enhanced.jpg`, so this is the normal path, not an edge.
     */
    if (sniffed && (sniffed.ext === 'jpg' || sniffed.ext === 'png')) {
      try {
        const pdf = await wrapImageInPdf(bytes, sniffed.ext)
        const copy = new Uint8Array(pdf.byteLength)
        copy.set(pdf)
        outBytes = copy
        effective = { ext: 'pdf', mime: 'application/pdf' }
        wrapped = true
      } catch (e) {
        console.warn('[otr] could not wrap image in a PDF; sending the image', {
          message: e instanceof Error ? e.message : String(e),
        })
      }
    }

    const fileName = effective ? withExt(opts.fileName, effective.ext) : opts.fileName
    const partType = effective?.mime ?? opts.contentType
    let asciiSafe = false

    /*
     * OTR's endpoint decodes the body as UTF-8 and re-encodes it, which shreds any byte
     * above 0x7F. Proven by arithmetic, twice: a 614-byte JPEG reported back as exactly
     * 976 bytes, and a 1,018,923-byte POD reported as 1,852,054 against a predicted
     * 1,860,973. A PDF re-encoded with /ASCIIHexDecode has no high bytes at all, so it
     * passes through that round trip byte-for-byte. Roughly doubles the size.
     *
     * Set OTR_ASCII_SAFE_PDF=off once OTR handles binary bodies correctly.
     */
    /*
     * The ASCII rewrite is OFF against v2, and that is the whole point of moving.
     *
     * v1 decoded the request body as UTF-8 and shredded every byte above 0x7F, so a POD
     * had to be re-encoded with /ASCIIHexDecode — roughly double the size — just to
     * survive the trip. v2 takes the raw binary: the real 1,018,923-byte POD for invoice
     * 16222565 uploaded untouched and returned 200. Only a v1 upload still needs the
     * workaround, and OTR_ASCII_SAFE_PDF=on forces it back for either.
     */
    const usingV2 = isV2Base(this.cfg.uploadBaseUrl || this.cfg.baseUrl)
    const asciiSafeDefault = usingV2
      ? process.env.OTR_ASCII_SAFE_PDF === 'on'
      : process.env.OTR_ASCII_SAFE_PDF !== 'off'
    const wantAsciiSafe = opts.asciiSafe ?? asciiSafeDefault
    if (effective?.ext === 'pdf' && wantAsciiSafe) {
      try {
        const safe = await toAsciiSafePdf(outBytes)
        // Only worth the size if it actually achieved zero high bytes.
        if (safe.highBytes === 0) {
          // Copied for the same reason the source bytes are, above: an exactly-sized
          // ArrayBuffer-backed array, so neither the type nor the length is in question.
          const copy = new Uint8Array(safe.bytes.byteLength)
          copy.set(safe.bytes)
          outBytes = copy
          asciiSafe = true
        } else {
          console.warn('[otr] ascii-safe rewrite left high bytes; sending original', {
            highBytes: safe.highBytes,
          })
        }
      } catch (e) {
        // A PDF we cannot rewrite is still worth sending as-is.
        console.warn('[otr] ascii-safe rewrite failed; sending original', {
          message: e instanceof Error ? e.message : String(e),
        })
      }
    }

    /*
     * Field order and names follow OTR's documented curl exactly — and so, now, does the
     * file part's Content-Type. We had been omitting it on the belief that their curl sends
     * none; capturing `curl --form "file=@pod.pdf"` on the wire shows it sends
     * `Content-Type: application/pdf`. A .NET handler reading a null ContentType throws
     * "Object reference not set to an instance of an object", which is precisely what both
     * of our probe PDFs came back with.
     */
    /*
     * v2 renamed the invoice field to ItemPkey and moved the route to /file-upload. The
     * id itself is unchanged — v2 accepts the id v1 issued when the invoice was created,
     * which is what lets invoices stay on v1 while documents move.
     */
    const { body, contentType } = buildMultipart([
      { name: 'file', fileName, contentType: partType, bytes: outBytes },
      { name: 'DocumentType', value: 'invoice-file-upload' },
      usingV2
        ? { name: 'ItemPkey', value: String(opts.invoiceId) }
        : { name: 'invoiceid', value: String(opts.invoiceId) },
      { name: 'SendEmail', value: opts.sendEmail ? 'true' : 'false' },
      { name: 'InvoiceDocTypes', value: String(opts.docType) },
    ])

    console.log('[otr] uploading document', {
      fileName,
      declaredType: partType,
      sniffed: sniffed?.ext ?? 'unknown',
      wrapped,
      asciiSafe,
      api: usingV2 ? 'v2' : 'v1',
      docType: opts.docType,
      sourceBytes: bytes.byteLength,
      fileBytes: outBytes.byteLength,
      bodyBytes: body.byteLength,
      contentType,
    })

    const res = await this.uploadRequest(usingV2 ? '/file-upload' : '/documents/upload', {
      method: 'POST',
      headers: await this.uploadHeaders({
        'X-Invoice-Doc-Type': String(opts.docType),
        Accept: 'application/json',
        // Our own boundary, so the body and the header cannot disagree.
        'Content-Type': contentType,
        'Content-Length': String(body.byteLength),
      }),
      // A Buffer IS a Uint8Array, which fetch accepts; the DOM lib types only know the
      // narrower set. Passing the bytes directly is what gets a Content-Length instead of
      // a chunked stream.
      body: body as unknown as BodyInit,
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
    /*
     * An upload that answers 204 has still uploaded. Unlike create, nothing downstream needs
     * a field out of this body — the invoice id came from the create call — so an empty
     * response is success rather than a failure to report.
     */
    const j = (safeJson(text) ?? {}) as { message?: string; invoiceId?: string }
    return { message: j.message ?? '', invoiceId: String(j.invoiceId ?? opts.invoiceId) }
  }

  /**
   * Read back what OTR currently says about one invoice.
   *
   * v1 and v2 disagree about everything here, and this was still speaking v1 — the path
   * `/invoices/{id}` is a 404 on v2, so every status refresh had been failing silently
   * against production since the switch.
   *
   * v2 takes the id as a QUERY parameter and answers with a flat object whose Status is a
   * NUMBER, not a word:
   *
   *   { "InvoiceNo": "14523",
   *     "InvoiceItems": { "Description": "Ln: LIBERTYVILLE,IL To CHICAGO,IL", "UnitPrice": 500 },
   *     "ModifiedDate": "2026-10-05T19:05:51.77",
   *     "Status": 1 }
   *
   * Most of what v1 returned — customer, PO, schedule, fuel advance — simply is not in the
   * v2 response, so those come back null rather than as zeros or empty strings that would
   * read as "OTR says there is no PO".
   */
  async getInvoice(invoiceId: number | string): Promise<OtrInvoiceDetails> {
    const path = this.invoicesOnV2
      ? `/invoices?invoicePkeys=${encodeURIComponent(String(invoiceId))}`
      : `/invoices/${encodeURIComponent(String(invoiceId))}`
    const res = await this.request(path, {
      method: 'GET',
      headers: await this.authedHeaders({ Accept: 'application/json' }),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new OtrError(`Get invoice ${invoiceId} failed (${res.status})`, res.status, text)
    }

    const parsed = parseJsonOrThrow(text, res.status, `Get invoice ${invoiceId}`)
    // v1 wraps it; v2 is flat. An array is tolerated in case v2 ever returns several.
    const inv = (Array.isArray(parsed)
      ? (parsed[0] ?? {})
      : ((parsed.invoice as Record<string, unknown>) ?? parsed)) as Record<string, unknown>

    const lane = (inv.lane ?? {}) as Record<string, { city?: string; state?: string }>
    const items = (inv.InvoiceItems ?? {}) as Record<string, unknown>
    const amount = Number(inv.invoiceAmount ?? items.UnitPrice ?? 0)

    return {
      // v2 sends a number, v1 a word. Both are passed through as text and resolved to
      // OTR's own label by src/lib/otrInvoiceStatus.ts, which is the only place that maps.
      status: String(inv.Status ?? inv.status ?? ''),
      invoiceNo: String(inv.InvoiceNo ?? inv.invoiceNo ?? ''),
      poNumber: String(inv.poNumber ?? ''),
      customerName: String(inv.customerName ?? ''),
      invoiceAmount: Number.isFinite(amount) ? amount : 0,
      scheduleId: inv.scheduleId ? String(inv.scheduleId) : null,
      fuelAdvanceStatus: inv.fuelAdvanceStatus ? String(inv.fuelAdvanceStatus) : null,
      submittedDate: inv.submittedDate ? String(inv.submittedDate) : null,
      lastUpdated: inv.ModifiedDate
        ? String(inv.ModifiedDate)
        : inv.lastUpdated
          ? String(inv.lastUpdated)
          : null,
      /** v2's one-line lane, e.g. "Ln:  LIBERTYVILLE,IL To  CHICAGO,IL". */
      description: typeof items.Description === 'string' ? items.Description.trim() : null,
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
  /*
   * Matched case-insensitively: v1 replied with lowercase keys and v2 replies with `Name`,
   * so a case-sensitive lookup silently found nothing against production and the row went
   * back to showing an MC nobody recognises.
   */
  const keys = ['brokername', 'clientname', 'debtorname', 'customername', 'name', 'companyname']
  const lower = new Map(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]))
  for (const key of keys) {
    const value = lower.get(key)
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
