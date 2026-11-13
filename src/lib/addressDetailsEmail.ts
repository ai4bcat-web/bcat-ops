/**
 * "Send Address Details" (Ryne 2026-11-13): an e-mail to the carrier's dispatcher with the
 * load's stops — where to go, when, and what to quote at the dock. It never carries money
 * (no rates, no charges) and never marks the load dispatched.
 *
 * Pure: the shipment-actions Lambda builds the message from the stored load with this, and
 * the dialog builds the same text for its preview.
 */

export interface AddressDetailsRef {
  code?: string | null
  label?: string | null
  value?: string | null
  visibility?: string | null
}

export interface AddressDetailsStopInput {
  type?: string | null
  name?: string | null
  city?: string | null
  address?: { street?: string | null; street2?: string | null; city?: string | null; state?: string | null; zip?: string | null } | null
  appt?: string | null
  apptType?: string | null
  apptEnd?: string | null
  refs?: AddressDetailsRef[] | null
  contact?: { name?: string | null; phone?: string | null; hours?: string | null } | null
  /** The stop's carrier-visible note (the one that prints on the rate con). `stopNotes` is internal and never sent. */
  instructions?: string | null
  pieces?: number | null
  weightLbs?: number | null
}

export interface AddressDetailsInput {
  pro: string
  carrierName?: string | null
  carrierRef?: string | null
  equipment?: string | null
  commodity?: string | null
  weightLbs?: number | null
  pieces?: number | null
  piecesUnit?: string | null
  stops: AddressDetailsStopInput[]
}

export interface AddressDetailsEmail {
  subject: string
  text: string
  html: string
}

const TZ = 'America/Chicago'

const one = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').trim() : '')

function parts(iso: string): { date: string; time: string } | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? ''
  return { date: `${get('month')}/${get('day')}/${get('year')}`, time: `${get('hour')}:${get('minute')}` }
}

/** "11/16/2026 09:00", "FCFS 11/16/2026 08:00–14:00", "11/16/2026 (time TBD)". */
export function addressDetailsAppt(appt?: string | null, apptType?: string | null, apptEnd?: string | null): string {
  const start = appt ? parts(appt) : null
  if (!start) return 'Not set'
  const type = (apptType ?? '').toLowerCase()
  const end = apptEnd ? parts(apptEnd) : null
  if (type === 'tbd') return `${start.date} (time TBD)`
  if (type === 'fcfs') return end ? `FCFS ${start.date} ${start.time}–${end.time}` : `FCFS ${start.date}`
  if (type === 'range' && end) return `${start.date} ${start.time}–${end.time}`
  return `${start.date} ${start.time}`
}

function addressLines(s: AddressDetailsStopInput): string[] {
  const a = s.address ?? {}
  const street = [one(a.street), one(a.street2)].filter(Boolean).join(', ')
  const cityLine = [one(a.city), [one(a.state), one(a.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  const lines = [street, cityLine || one(s.city)].filter(Boolean)
  return lines.length ? lines : ['Address not on file']
}

/** Only references a carrier may see (the rate con's rule). */
function carrierRefs(refs: AddressDetailsRef[] | null | undefined): string[] {
  return (refs ?? [])
    .filter((r) => r && (r.visibility == null || r.visibility === 'CARRIER' || r.visibility === 'ALL'))
    .map((r) => {
      const value = one(r.value)
      const label = one(r.label) || one(r.code)
      return value ? (label ? `${label} ${value}` : value) : ''
    })
    .filter(Boolean)
}

interface StopBlock { title: string; rows: [string, string][]; address: string[] }

function stopBlocks(stops: AddressDetailsStopInput[]): StopBlock[] {
  let picks = 0
  let drops = 0
  return stops.map((s) => {
    const isPick = (s.type ?? '').toLowerCase() === 'pickup'
    const n = isPick ? ++picks : ++drops
    const total = stops.filter((x) => ((x.type ?? '').toLowerCase() === 'pickup') === isPick).length
    const title = `${isPick ? 'Pickup' : 'Delivery'}${total > 1 ? ` ${n}` : ''}: ${one(s.name) || 'Facility not named'}`
    const rows: [string, string][] = [['Appointment', addressDetailsAppt(s.appt, s.apptType, s.apptEnd)]]
    const hours = one(s.contact?.hours)
    if (hours) rows.push(['Hours', hours])
    const refs = carrierRefs(s.refs)
    if (refs.length) rows.push(['Reference #', refs.join(' · ')])
    const contact = [one(s.contact?.name), one(s.contact?.phone)].filter(Boolean).join(' · ')
    if (contact) rows.push(['Contact', contact])
    const freight = [s.pieces != null ? `${s.pieces} pcs` : '', s.weightLbs != null ? `${s.weightLbs} lbs` : ''].filter(Boolean).join(' · ')
    if (freight) rows.push(['Freight', freight])
    const notes = typeof s.instructions === 'string' ? s.instructions.trim() : ''
    if (notes) rows.push(['Notes', notes])
    return { title, rows, address: addressLines(s) }
  })
}

export function addressDetailsSubject(pro: string): string {
  return `PRO ${one(pro)} — Pickup & delivery details`
}

const esc = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function buildAddressDetailsEmail(input: AddressDetailsInput, signOff = 'BCAT Tracking'): AddressDetailsEmail {
  const pro = one(input.pro)
  const header: [string, string][] = [['PRO #', pro]]
  if (one(input.carrierRef)) header.push(['Carrier ref #', one(input.carrierRef)])
  if (one(input.carrierName)) header.push(['Carrier', one(input.carrierName)])
  if (one(input.equipment)) header.push(['Equipment', one(input.equipment)])
  if (one(input.commodity)) header.push(['Commodity', one(input.commodity)])
  if (input.weightLbs != null) header.push(['Weight', `${input.weightLbs} lbs`])
  if (input.pieces != null) header.push(['Pieces', `${input.pieces}${one(input.piecesUnit) ? ` ${one(input.piecesUnit)}` : ''}`])
  const blocks = stopBlocks(input.stops)

  const text = [
    `Pickup & delivery details for PRO ${pro}.`,
    '',
    ...header.map(([k, v]) => `${k}: ${v}`),
    '',
    ...blocks.flatMap((b) => [
      b.title.toUpperCase(),
      ...b.address,
      ...b.rows.map(([k, v]) => `${k}: ${v.replace(/\r?\n/g, ' ')}`),
      '',
    ]),
    'Please reply all with any questions (keep tracking@bcatcorp.com copied).',
    '',
    `— ${signOff}`,
  ].join('\r\n')

  const cell = 'padding:2px 12px 2px 0;vertical-align:top;'
  const table = (rows: [string, string][]) =>
    `<table style="border-collapse:collapse;font-size:14px">${rows.map(([k, v]) =>
      `<tr><td style="${cell}color:#555;white-space:nowrap">${esc(k)}</td><td style="${cell}">${esc(v).replace(/\r?\n/g, '<br>')}</td></tr>`).join('')}</table>`
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;line-height:1.4">',
    `<p style="margin:0 0 12px">Pickup &amp; delivery details for <b>PRO ${esc(pro)}</b>.</p>`,
    table(header),
    ...blocks.map((b) =>
      `<div style="margin-top:16px;padding:10px 12px;border:1px solid #ddd;border-radius:6px">` +
      `<div style="font-weight:bold;margin-bottom:4px">${esc(b.title)}</div>` +
      `<div style="margin-bottom:6px">${b.address.map(esc).join('<br>')}</div>` +
      `${table(b.rows)}</div>`),
    '<p style="margin:16px 0 0">Please reply all with any questions (keep tracking@bcatcorp.com copied).</p>',
    `<p style="margin:12px 0 0">— ${esc(signOff)}</p>`,
    '</div>',
  ].join('')

  return { subject: addressDetailsSubject(pro), text, html }
}
