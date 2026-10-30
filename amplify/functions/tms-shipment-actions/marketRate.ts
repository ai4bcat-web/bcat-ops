/**
 * Step P4 — quote in → DAT RateView → suggested or auto response.
 *
 * Every market lookup answers with either a live DAT RateView call, when credentials
 * are present and DAT answers, or a deterministic stub that is labelled STUB every
 * place it appears. A live path that fails never silently pretends success.
 */
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'

import { conflictError, isConflict, numberOrNull, updateItemTx, type Row } from '../_shared/shipmentStore'
import {
  assertString,
  optionalBoolean,
  optionalInteger,
  optionalString,
  type Caller,
} from '../_shared/actionInputs'
import {
  liveRateView,
  stubRateView,
  type RateViewAnswer,
  type RateViewCredentials,
  type RateViewRequest,
} from '../../../src/lib/integrations/rateView'
import { marginBpsOf, resolveMargin, sellRateFromMarket } from '../../../src/lib/flowDefaults'

export interface MarketRateDeps {
  tables: { quote: string; customer: string; settings: string; integration: string }
  getById(table: string, id: string): Promise<Row | null>
  getSettings(): Promise<Row>
  transact(items: TransactWriteItem[]): Promise<void>
  writeAudit(...args: [entityType: string, entityId: string, action: string, caller: Caller, changes: Row]): Promise<void>
  /** Step J credentials for a provider, or an empty object when it is not connected. */
  credentialsFor(provider: string): Promise<Record<string, string>>
  /** Injected so the test never reaches the network. */
  fetchImpl: typeof fetch
  now(): string
}

export interface MarketRateInput {
  quoteId?: string | null
  shipmentId?: string | null
  customerId?: string | null
  originCity: string
  originState: string
  destinationCity: string
  destinationState: string
  equipmentType: string
  pickupDate?: string | null
  miles?: number | null
  mode?: string | null
  save?: boolean | null
  expectedUpdatedAt?: string | null
}

export interface MarketRateResult {
  answer: RateViewAnswer
  targetBps: number
  floorBps: number
  autoReply: boolean
  suggestedSellCents: number
  marginAtSuggested: number
  belowFloor: boolean
  floorSellCents: number
  quote?: Row
}

const ACTION = 'RATE_FROM_MARKET'
const EDITABLE_STATUSES: readonly string[] = ['DRAFT', 'REQUESTED']

function readInput(input: Row): MarketRateInput {
  return {
    quoteId: optionalString(input.quoteId),
    shipmentId: optionalString(input.shipmentId),
    customerId: optionalString(input.customerId),
    originCity: assertString(input.originCity, 'originCity'),
    originState: assertString(input.originState, 'originState'),
    destinationCity: assertString(input.destinationCity, 'destinationCity'),
    destinationState: assertString(input.destinationState, 'destinationState'),
    equipmentType: assertString(input.equipmentType, 'equipmentType'),
    pickupDate: optionalString(input.pickupDate),
    miles: optionalInteger(input.miles, { min: 1, label: 'miles' }),
    mode: optionalString(input.mode),
    save: optionalBoolean(input.save),
    expectedUpdatedAt: optionalString(input.expectedUpdatedAt),
  }
}

function buildRequest(input: MarketRateInput): RateViewRequest {
  return {
    originCity: input.originCity,
    originState: input.originState,
    destinationCity: input.destinationCity,
    destinationState: input.destinationState,
    equipmentType: input.equipmentType,
    pickupDate: input.pickupDate,
    miles: input.miles,
  }
}

function isComplete(creds: Record<string, string>): creds is { serviceAccountEmail: string; serviceAccountPassword: string } & Record<string, string> {
  return Boolean(creds.serviceAccountEmail?.trim() && creds.serviceAccountPassword?.trim())
}

async function fetchAnswer(deps: MarketRateDeps, req: RateViewRequest): Promise<RateViewAnswer> {
  const creds = await deps.credentialsFor('DAT')
  if (isComplete(creds)) {
    const live = await liveRateView(req, creds as RateViewCredentials, deps.fetchImpl)
    if (live) return live
  }
  const stub = stubRateView(req)
  return {
    ...stub,
    message:
      creds.serviceAccountEmail || creds.serviceAccountPassword
        ? `DAT RateView was unreachable or refused — falling back to stub. ${stub.message}`
        : stub.message,
  }
}

function marketDetail(answer: RateViewAnswer): Row {
  return {
    low: answer.lowCents,
    high: answer.highCents,
    average: answer.averageCents,
    fuel: answer.fuelCents,
    perMile: answer.perMileCents,
    miles: answer.miles,
    reports: answer.reports,
    days: answer.days,
  }
}

export async function priceFromMarket(deps: MarketRateDeps, input: Row, caller: Caller): Promise<Row> {
  const fields = readInput(input)

  // Load the quote first; its customer and mode are the defaults when the input
  // does not override them. The quote is also the save target.
  let quote: Row | null = null
  if (fields.quoteId) {
    quote = await deps.getById(deps.tables.quote, fields.quoteId)
    if (!quote) throw new Error(`Quote not found: ${fields.quoteId}`)
  }

  const customerId = fields.customerId ?? optionalString(quote?.customerId)
  const customer = customerId ? await deps.getById(deps.tables.customer, customerId) : null
  const settings = await deps.getSettings()
  const mode = fields.mode ?? optionalString(quote?.mode)

  const req = buildRequest(fields)
  const answer = await fetchAnswer(deps, req)

  const margin = resolveMargin(settings, customer, mode)
  const suggestedSellCents = sellRateFromMarket(answer.averageCents, margin.targetBps)
  const marginAtSuggested = marginBpsOf(suggestedSellCents, answer.averageCents)
  const floorSellCents = sellRateFromMarket(answer.averageCents, margin.floorBps)
  const belowFloor = marginAtSuggested < margin.floorBps
  const autoReply = margin.autoReply && !belowFloor

  const result: MarketRateResult = {
    answer,
    targetBps: margin.targetBps,
    floorBps: margin.floorBps,
    autoReply,
    suggestedSellCents,
    marginAtSuggested,
    belowFloor,
    floorSellCents,
  }

  // Save only reaches the quote table, and only for still-editable quotes.
  if (fields.save && fields.quoteId && quote) {
    const status = String(quote.status ?? '')
    if (!EDITABLE_STATUSES.includes(status)) {
      throw new Error(`Cannot re-price a quote that is already ${status.toLowerCase()}`)
    }

    const at = deps.now()
    const patch: Row = {
      marketRateCents: answer.averageCents,
      marketSource: answer.source,
      marketStub: answer.stub,
      marketAt: at,
      marketDetail: marketDetail(answer),
      marginTargetBps: margin.targetBps,
      amountCents: suggestedSellCents,
      updatedBy: caller.email,
      updatedAt: at,
      version: Math.max(1, numberOrNull(quote.version) ?? 0) + 1,
    }

    const casAt = fields.expectedUpdatedAt ?? optionalString(quote.updatedAt)
    const tx = updateItemTx(deps.tables.quote, fields.quoteId, patch, casAt)

    try {
      await deps.transact([tx])
    } catch (err) {
      if (isConflict(err)) throw conflictError('quote', err)
      throw err
    }

    await deps.writeAudit('Quote', fields.quoteId, ACTION, caller, {
      status,
      previous: {
        marketRateCents: numberOrNull(quote.marketRateCents),
        amountCents: numberOrNull(quote.amountCents),
        marginTargetBps: numberOrNull(quote.marginTargetBps),
      },
      ...patch,
    })

    result.quote = { ...quote, ...patch }
  }

  return result as unknown as Row
}
