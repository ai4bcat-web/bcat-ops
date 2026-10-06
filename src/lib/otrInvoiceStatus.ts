/**
 * OTR's invoice status, named and coloured the way OTR's own portal names and colours it.
 *
 * Their API returns a NUMBER. Their portal shows a word. If BCAT Ops invented its own
 * wording, the office would be comparing "Needs client" here against "IssueClient" there
 * and deciding for themselves whether those are the same thing — so the labels below are
 * OTR's, not ours.
 *
 * Where a label is marked OBSERVED it was read off the live portal board. The rest come
 * from OTR's published enum, which is the best evidence available until that status turns
 * up on a real invoice; if one of those ever reads differently in the portal, fix it here
 * and the whole app follows.
 */

export interface OtrStatusMeta {
  code: number
  /** Exactly what OTR's portal calls it. */
  label: string
  /** Portal row colour, so a glance here matches a glance there. */
  tone: { bg: string; fg: string; border: string }
  /** Nothing more will happen to this invoice. */
  terminal: boolean
  /** OTR or the broker is waiting on us — these are the rows worth chasing. */
  needsAttention: boolean
}

const YELLOW = { bg: '#fef9c3', fg: '#854d0e', border: '#fde047' }
const RED    = { bg: '#fecaca', fg: '#b91c1c', border: '#f87171' }
const ORANGE = { bg: '#fed7aa', fg: '#c2410c', border: '#fb923c' }
const TAN    = { bg: '#e7d7a8', fg: '#854d0e', border: '#d6bd6a' }
const GREEN  = { bg: '#dcfce7', fg: '#15803d', border: '#86efac' }
const BLUE   = { bg: '#dbeafe', fg: '#1d4ed8', border: '#93c5fd' }
const GREY   = { bg: '#f1f5f9', fg: '#64748b', border: '#cbd5e1' }

/**
 * OTR's published status enum, by code.
 *
 * 1, 6 and 8 carry labels read off the live portal — their portal says "IssueClient" and
 * "IssueFollowUp" where the API documentation says "Current Client Request" and "OTR
 * Followup", and the portal is what the office is looking at.
 */
export const OTR_STATUSES: Record<number, OtrStatusMeta> = {
  1:  { code: 1,  label: 'Pending',         tone: YELLOW, terminal: false, needsAttention: false }, // OBSERVED
  2:  { code: 2,  label: 'Advance Issued',  tone: BLUE,   terminal: false, needsAttention: false },
  3:  { code: 3,  label: 'Approved',        tone: GREEN,  terminal: true,  needsAttention: false },
  4:  { code: 4,  label: 'Dead',            tone: GREY,   terminal: true,  needsAttention: false },
  5:  { code: 5,  label: 'Addendum',        tone: TAN,    terminal: false, needsAttention: true  },
  6:  { code: 6,  label: 'IssueClient',     tone: RED,    terminal: false, needsAttention: true  }, // OBSERVED
  7:  { code: 7,  label: 'Duplicate',       tone: RED,    terminal: true,  needsAttention: true  },
  8:  { code: 8,  label: 'IssueFollowUp',   tone: ORANGE, terminal: false, needsAttention: true  }, // OBSERVED
  9:  { code: 9,  label: 'Advance Pending', tone: YELLOW, terminal: false, needsAttention: false },
  99: { code: 99, label: 'Process Blocked', tone: RED,    terminal: false, needsAttention: true  },
}

/**
 * What OTR currently says about an invoice.
 *
 * Accepts the number the API sends, or a string — older rows stored the label, and a status
 * that arrives as text should not become "unknown" just because the wire format changed.
 *
 * An unrecognised code is reported AS the code rather than as a blank or a guess. A new OTR
 * status is a thing to go and look up, and "Status 12" sends someone to do that; an empty
 * cell just looks broken.
 */
export function otrStatusMeta(raw: number | string | null | undefined): OtrStatusMeta | null {
  if (raw == null || raw === '') return null

  if (typeof raw === 'number' || /^\d+$/.test(String(raw).trim())) {
    const code = Number(raw)
    return (
      OTR_STATUSES[code] ?? {
        code,
        label: `Status ${code}`,
        tone: GREY,
        terminal: false,
        needsAttention: false,
      }
    )
  }

  const text = String(raw).trim()
  const byLabel = Object.values(OTR_STATUSES).find(
    (s) => s.label.toLowerCase() === text.toLowerCase(),
  )
  if (byLabel) return byLabel

  // A label we have never seen. Show it as OTR sent it rather than discarding it.
  return { code: -1, label: text, tone: GREY, terminal: false, needsAttention: false }
}

/** The label alone, for a row that only has room for one. */
export function otrStatusLabel(raw: number | string | null | undefined): string | null {
  return otrStatusMeta(raw)?.label ?? null
}

/**
 * Our own queue status for an OTR status.
 *
 * Only a terminal, successful OTR status closes a row out. "Approved" is the one that means
 * OTR has taken the invoice on; "Dead" and "Duplicate" are terminal but are not money, so
 * they stay visible rather than being filed as finished.
 */
export function localStatusFor(raw: number | string | null | undefined): 'FACTORED' | 'PENDING_WITH_OTR' {
  const meta = otrStatusMeta(raw)
  return meta?.code === 3 ? 'FACTORED' : 'PENDING_WITH_OTR'
}
