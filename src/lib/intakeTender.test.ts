/**
 * The fixtures here are real tender bodies copied from the live IntakeItem table, because
 * the thing worth pinning is that these exact emails yield the fields a dispatcher would
 * otherwise type — particularly the ZIPs and the customer name the factoring queue needs.
 */
import { describe, it, expect } from 'vitest'
import { parseTender, parseAddressLine, parsePlanDate } from './intakeTender'

const E2OPEN = `This email was sent from an automated source. Please do not reply to this message as all replies are automatically deleted.

BATORY FOODS has tendered TMS ID 208663813 to this carrier.  This tender will expire at: 07/31/2026 11:00.

Load Report
-----------------------------------------
Ref #: TMS ID 208663813
      Shipments: SO-1732669

Shipper: BATORY FOODS
Mark Ronczkowski

mronczkowski@batoryfoods.com
Carrier: IVAN CARTAGE COMPANY (IVC1)
Ryne Bandolik

 ivancartage@bcatcorp.com

Load Information
-----------------------------------------
Comments: --
Weight: 42,952.56 lb
Priority: 2

-----------------------------------------
Pick
BATORY'S OAKLEY CHICAGO 2234 W 43RD STREET CHICAGO , IL 60609 
Contact: CONTACT 8472997776 0000
Instructions:  Appointments required  - https://na-app.tms.e2open.com
Plan: 08/04/2026 00:00 CDT - 08/04/2026 00:00 CDT
Appt: --
Actual: --
Distance: 0 mi
Weight: 42,952.56 lb
Shipments: SO-1732669

-----------------------------------------
Drop
EAGLE FOODS 3898 SUNSET AVENUE WAUKEGAN , IL 60087 
Contact: SANDRA/ CHIRSTINE/LYNN NAGGY 8472637000 0919
Instructions: 48 Hour Notice for delivery appointments required
Plan: 08/05/2026 00:00 CDT - 08/05/2026 00:00 CDT
Appt: --
Actual: --
Distance: 40 mi  (from last stop)
Weight: 42,952.56 lb
Shipments: SO-1732669



ID[3756488310] Type[0] Event[34] System[tm4sprd07]`

const E2OPEN_SUBJECT = 'Tender TMS ID 208663813: CHICAGO, IL(08/04) to WAUKEGAN, IL by BATORY FOODS'

const SCHNEIDER_SUBJECT = 'Fwd: Rate Confirmation for Route # 4010756658 - MESA, AZ – Tempe, AZ'

describe('parseTender on a real e2open tender', () => {
  const t = parseTender(E2OPEN_SUBJECT, E2OPEN)

  it('reads it as the structured format', () => {
    expect(t.format).toBe('E2OPEN')
  })

  it('pulls the reference, PU# and customer', () => {
    expect(t.reference).toBe('208663813')
    expect(t.pickupNumber).toBe('SO-1732669')
    expect(t.customer).toBe('BATORY FOODS')
  })

  it('pulls the weight as whole pounds', () => {
    expect(t.weightLb).toBe(42953)
  })

  it('pulls both stops in route order with full addresses', () => {
    expect(t.stops).toHaveLength(2)
    expect(t.stops[0]).toEqual({
      type: 'pickup',
      name: "BATORY'S OAKLEY CHICAGO",
      street: '2234 W 43RD STREET',
      city: 'CHICAGO',
      state: 'IL',
      zip: '60609',
      dateStr: '2026-08-04',
    })
    expect(t.stops[1]).toEqual({
      type: 'delivery',
      name: 'EAGLE FOODS',
      street: '3898 SUNSET AVENUE',
      city: 'WAUKEGAN',
      state: 'IL',
      zip: '60087',
      dateStr: '2026-08-05',
    })
  })

  it('gets the ZIPs the factoring queue stalls without', () => {
    // The whole reason this parser exists: origin and destination ZIP, typed by nobody.
    expect(t.stops[0].zip).toBe('60609')
    expect(t.stops[1].zip).toBe('60087')
  })
})

describe('parseAddressLine', () => {
  it('splits a name, street and city that run together', () => {
    // "CHICAGO" appears twice on this line — once inside the facility name.
    expect(parseAddressLine("BATORY'S OAKLEY CHICAGO 2234 W 43RD STREET CHICAGO , IL 60609")).toEqual({
      name: "BATORY'S OAKLEY CHICAGO",
      street: '2234 W 43RD STREET',
      city: 'CHICAGO',
      state: 'IL',
      zip: '60609',
    })
  })

  it('keeps a multi-word city whole', () => {
    expect(parseAddressLine('BCAT CORP 1193 E HIGGINS RD ELK GROVE VILLAGE , IL 60007')).toMatchObject({
      street: '1193 E HIGGINS RD',
      city: 'ELK GROVE VILLAGE',
      zip: '60007',
    })
  })

  it('takes a ZIP+4 without dragging the +4 along', () => {
    expect(parseAddressLine('SOMEWHERE 100 MAIN ST AURORA , IL 60502-1234')).toMatchObject({
      city: 'AURORA', zip: '60502',
    })
  })

  it('claims no street rather than guessing when there is no street type', () => {
    const a = parseAddressLine('PLAINFIELD TERMINAL JOLIET , IL 60431')
    expect(a.street).toBeUndefined()
    expect(a).toMatchObject({ city: 'JOLIET', state: 'IL', zip: '60431' })
  })

  it('returns nothing for a line that is not an address', () => {
    expect(parseAddressLine('Contact: SANDRA 8472637000 0919')).toEqual({})
    expect(parseAddressLine('')).toEqual({})
  })
})

describe('parsePlanDate', () => {
  it('takes the date and drops the placeholder midnight', () => {
    // 00:00 means "no appointment yet"; carrying it over would read as a booked time.
    expect(parsePlanDate('Plan: 08/04/2026 00:00 CDT - 08/04/2026 00:00 CDT')).toBe('2026-08-04')
  })

  it('pads a single-digit month and day', () => {
    expect(parsePlanDate('Plan: 1/5/2027 00:00 CST')).toBe('2027-01-05')
  })

  it('returns nothing for a dateless line', () => {
    expect(parsePlanDate('Appt: --')).toBeUndefined()
  })
})

describe('parseTender falling back to the subject', () => {
  it('reads a Schneider rate confirmation subject', () => {
    const t = parseTender(SCHNEIDER_SUBJECT, 'Thank you for booking. No load report here.')
    expect(t.format).toBe('SUBJECT')
    expect(t.reference).toBe('4010756658')
    expect(t.stops).toEqual([
      { type: 'pickup', city: 'MESA', state: 'AZ' },
      { type: 'delivery', city: 'Tempe', state: 'AZ' },
    ])
  })

  it('reads an e2open subject when the body never arrived', () => {
    const t = parseTender(E2OPEN_SUBJECT, '')
    expect(t.format).toBe('SUBJECT')
    expect(t.reference).toBe('208663813')
    expect(t.customer).toBe('BATORY FOODS')
    expect(t.stops.map((s) => s.city)).toEqual(['CHICAGO', 'WAUKEGAN'])
  })

  it('claims no ZIPs from a subject, because a subject has none', () => {
    // Better an empty ZIP the queue flags than one invented from a city name.
    const t = parseTender(SCHNEIDER_SUBJECT, '')
    expect(t.stops.every((s) => s.zip === undefined)).toBe(true)
  })

  it('prefers the structured body over the subject rather than merging them', () => {
    const t = parseTender('Tender TMS ID 999999999: NOWHERE, XX to ELSEWHERE, YY', E2OPEN)
    expect(t.reference).toBe('208663813')
    expect(t.stops[0].city).toBe('CHICAGO')
  })

  it('gives up cleanly on an email with nothing in it', () => {
    const t = parseTender('Untitled', '-- \n\nRuben Vargas\n\nwww.bcatcorp.com')
    expect(t).toEqual({ format: null, stops: [] })
  })

  it('gives up cleanly on a thin acceptance notice', () => {
    const t = parseTender(
      'Fwd: M2 Logistics, Inc. Rate Confirmation for 5859872',
      'M2 Logistics, Inc. Rate Confirmation for 5859872 has been Accepted.',
    )
    // No labelled reference and no city pair — nothing here is safe to put on a load.
    expect(t.stops).toEqual([])
  })
})
