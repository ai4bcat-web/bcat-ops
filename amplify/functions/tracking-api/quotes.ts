/**
 * The public quote link's rules, kept out of the handler so the handler stays a
 * router: which rungs a live link may sit on, what a response body is allowed to
 * say, and exactly what one answer moves.
 *
 * Nothing here touches DynamoDB. `planResponse` turns a body plus the row it is
 * answering into the single write the handler then makes under a condition — so
 * every "this is not a verb for this side", "that counter is the number already on
 * the table" and "a decline needs a reason" is decided once, in one pure function,
 * and the handler never grows a second opinion about any of them.
 *
 * Imports are relative: the public tracking Lambda bundles these files by path.
 */
import { PUBLIC_DECLINE_REASONS } from '../../../src/lib/quotes'
import type {
  QuoteAcceptedVia,
  QuoteCounterBy,
  QuoteLostReason,
  QuoteRecord,
  QuoteResponseKind,
  QuoteSide,
  QuoteStatus,
} from '../../../src/types/tms'

/**
 * The rungs a live link may be answered on.
 *
 * REQUESTED is a buy-side rung only — it means "a carrier has been asked and has
 * not priced it yet". A sell-side REQUESTED is an intake nobody has priced, which
 * has no number to show and therefore no link.
 */
const SELL_LIVE_STATUSES: readonly QuoteStatus[] = ['QUOTED', 'SENT_COUNTER']
const BUY_LIVE_STATUSES: readonly QuoteStatus[] = ['QUOTED', 'SENT_COUNTER', 'REQUESTED']

export function liveLinkStatuses(side: QuoteSide): readonly QuoteStatus[] {
  return side === 'BUY' ? BUY_LIVE_STATUSES : SELL_LIVE_STATUSES
}

/** The five verbs a public page can send, across both sides. */
export type QuoteLinkAction = 'ACCEPT' | 'COUNTER' | 'DECLINE' | 'QUOTE' | 'PASS'

const ACTIONS: readonly QuoteLinkAction[] = ['ACCEPT', 'COUNTER', 'DECLINE', 'QUOTE', 'PASS']

/** A name has to contain a letter; initials and single names are fine. */
const NAME_LETTER = /\p{L}/u
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/
const MAX_NAME = 120
const MAX_EMAIL = 254
const MAX_MESSAGE = 2000
/** A freight quote is not ten million dollars; anything past this is a fat finger. */
const MAX_AMOUNT_CENTS = 1_000_000_000

/** What the page says, and who said it. */
export interface QuoteResponsePlan {
  action: QuoteLinkAction
  /** The rung this answer writes. */
  status: QuoteStatus
  response: QuoteResponseKind
  /** Written only when the answer changes the row's own number (a carrier's price). */
  amountCents: number | null
  /** Their number, when they named one against ours. */
  counterCents: number | null
  counterBy: QuoteCounterBy | null
  lostReason: QuoteLostReason | null
  acceptedVia: QuoteAcceptedVia | null
  /** A number crossed, so the round count moves. */
  bumpRounds: boolean
  /** The rung is terminal: `quoteOpen` comes off the row. */
  closes: boolean
  /** The rungs the write is conditioned on — the answer is once-only per round. */
  from: readonly QuoteStatus[]
  responderName: string
  responderEmail: string
  message: string | null
  /** The thread line this answer leaves behind. */
  eventKind: string
}

type Plan = { plan: QuoteResponsePlan }
type Refusal = { error: string }

/** What the public page shows as the number on the table, for either side. */
function numberOnTheTable(quote: QuoteRecord): number {
  if (quote.side === 'BUY' && quote.counterBy === 'US' && quote.counterCents != null) {
    return quote.counterCents
  }
  return quote.amountCents
}

function readString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return null
  return trimmed
}

function readAmount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null
  if (value <= 0 || value > MAX_AMOUNT_CENTS) return null
  return value
}

/**
 * One answer, read against the row it is answering.
 *
 * Every refusal is a sentence a person can act on — this is a page a customer or a
 * driver is looking at, not an API. The side decides the verbs: a customer accepts,
 * counters or declines; a carrier quotes, accepts, counters or passes.
 */
export function planResponse(
  quote: QuoteRecord,
  body: unknown,
  opts: { showBookNow: boolean },
): Plan | Refusal {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Send your answer as {action, name, email}' }
  }
  const raw = body as Record<string, unknown>

  const responderName = readString(raw.name, MAX_NAME)
  if (!responderName || !NAME_LETTER.test(responderName)) {
    return { error: 'Tell us your name so we know who answered' }
  }
  const responderEmail = readString(raw.email, MAX_EMAIL)
  if (!responderEmail || !EMAIL_RE.test(responderEmail)) {
    return { error: 'We need a working e-mail address so we can confirm your answer' }
  }
  const message = readString(raw.message, MAX_MESSAGE)

  const action = ACTIONS.find((candidate) => candidate === raw.action)
  if (!action) return { error: 'That is not an answer this link accepts' }

  const sell = quote.side === 'SELL'
  const allowed: readonly QuoteLinkAction[] = sell
    ? ['ACCEPT', 'COUNTER', 'DECLINE']
    : ['QUOTE', 'ACCEPT', 'COUNTER', 'PASS']
  if (!allowed.includes(action)) {
    return {
      error: sell
        ? 'This quote can be accepted, countered or declined'
        : 'This offer can be quoted, accepted, countered or passed',
    }
  }

  const common = {
    action,
    responderName,
    responderEmail,
    message,
    from: liveLinkStatuses(quote.side),
    amountCents: null,
    counterCents: null,
    counterBy: null,
    lostReason: null,
    acceptedVia: null,
    bumpRounds: false,
    closes: false,
  } as const

  if (action === 'DECLINE') {
    const reason = PUBLIC_DECLINE_REASONS.find((candidate) => candidate === raw.reason)
    if (!reason) return { error: 'Choose a reason so we know why this one did not work' }
    return {
      plan: {
        ...common,
        status: 'LOST',
        response: 'DECLINED',
        lostReason: reason,
        closes: true,
        eventKind: 'DECLINED_ON_LINK',
      },
    }
  }

  if (action === 'PASS') {
    return {
      plan: {
        ...common,
        status: 'PASS',
        response: 'PASSED',
        lostReason: null,
        closes: true,
        eventKind: 'PASSED_ON_LINK',
      },
    }
  }

  if (action === 'QUOTE') {
    const amountCents = readAmount(raw.amountCents)
    if (!amountCents) return { error: 'Enter the rate you will haul this load for' }
    return {
      plan: {
        ...common,
        status: 'QUOTED',
        response: 'COUNTERED',
        // A carrier's price *is* the row's number on the buy side.
        amountCents,
        // Only from the rung that asked: a carrier who has already priced it is
        // countering, not quoting, and takes the COUNTER path below.
        from: ['REQUESTED'],
        bumpRounds: true,
        eventKind: 'QUOTED_ON_LINK',
      },
    }
  }

  const onTheTable = numberOnTheTable(quote)

  if (action === 'COUNTER') {
    const counterCents = readAmount(raw.amountCents)
    if (!counterCents) return { error: 'Enter the number you want for this one' }
    if (counterCents === onTheTable) {
      return { error: 'That is already the number on the table — accept it instead' }
    }
    return {
      plan: {
        ...common,
        status: 'RECEIVED_COUNTER',
        response: 'COUNTERED',
        counterCents,
        counterBy: 'THEM',
        bumpRounds: true,
        eventKind: 'COUNTERED_ON_LINK',
      },
    }
  }

  // ACCEPT. A customer accepts the price on their page and nothing is rewritten.
  // A carrier may accept our offer or the book-now rate, when one is on show; the
  // number they took becomes the row's number, and nothing is booked either way.
  if (sell) {
    return {
      plan: {
        ...common,
        status: 'RECEIVED_REPLY',
        response: 'ACCEPTED',
        acceptedVia: 'LINK',
        eventKind: 'ACCEPTED_ON_LINK',
      },
    }
  }

  const bookNow = opts.showBookNow && quote.bookNowRateCents != null && quote.bookNowRateCents > 0
    ? quote.bookNowRateCents
    : null
  // A request nobody has priced has nothing to take: an offer is a number, and
  // zero is not one.
  const offered = onTheTable > 0 ? onTheTable : null
  if (offered == null && bookNow == null) {
    return { error: 'There is no rate on this offer to accept yet' }
  }
  const named = raw.amountCents == null ? offered ?? bookNow : readAmount(raw.amountCents)
  if (named == null || (named !== offered && named !== bookNow)) {
    return { error: 'That is not a number this offer is open at' }
  }
  return {
    plan: {
      ...common,
      status: 'RECEIVED_REPLY',
      response: 'ACCEPTED',
      amountCents: named,
      acceptedVia: 'LINK',
      eventKind: 'ACCEPTED_ON_LINK',
    },
  }
}
