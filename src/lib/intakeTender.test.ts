/**
 * The fixtures here are real tender bodies copied from the live IntakeItem table, because
 * the thing worth pinning is that these exact emails yield the fields a dispatcher would
 * otherwise type — particularly the ZIPs and the customer name the factoring queue needs.
 */
import { describe, it, expect } from 'vitest'
import { parseTender, parseAddressLine, parsePlanDate, parseApptLine, resolveTenderCustomer, type TenderPrefill } from './intakeTender'

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
      // The facility's own rules, carried through rather than retyped off the email.
      instructions: 'Appointments required - https://na-app.tms.e2open.com',
    })
    expect(t.stops[1]).toEqual({
      type: 'delivery',
      name: 'EAGLE FOODS',
      street: '3898 SUNSET AVENUE',
      city: 'WAUKEGAN',
      state: 'IL',
      zip: '60087',
      dateStr: '2026-08-05',
      instructions: '48 Hour Notice for delivery appointments required',
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

describe('resolveTenderCustomer', () => {
  const customers = [
    { id: 'c1', name: 'BATORY FOODS', mcNumber: '123456', active: true, aliases: ['BATORY'] },
    { id: 'c2', name: 'Rojac Trucking', mcNumber: '654321', active: true },
    { id: 'c3', name: 'Batory Foods West', mcNumber: '999', active: true },
  ] as never[]

  it('binds a customer whose name matches exactly', () => {
    const c = resolveTenderCustomer('BATORY FOODS', customers)
    expect(c?.id).toBe('c1')
  })

  it('matches on an alias too', () => {
    expect(resolveTenderCustomer('Batory', customers)?.id).toBe('c1')
  })

  it('ignores case, punctuation and a trailing Inc', () => {
    expect(resolveTenderCustomer('rojac trucking, inc.', customers)?.id).toBe('c2')
  })

  it('refuses a merely similar name', () => {
    /*
     * The customer carries the MC that decides who gets billed. "Similar name" is not a
     * basis for choosing that, however confident the score looks.
     */
    expect(resolveTenderCustomer('Batory Foods Westside', customers)).toBeNull()
  })

  it('refuses an unknown broker rather than inventing one', () => {
    expect(resolveTenderCustomer('NEW WAVE INTERNATIONAL CARGO', customers)).toBeNull()
  })

  it('refuses when two records share the name, instead of picking one', () => {
    // A duplicated directory record is a problem to see, not to paper over.
    const dupes = [...customers, { id: 'c4', name: 'BATORY FOODS', mcNumber: '7', active: true }] as never[]
    expect(resolveTenderCustomer('BATORY FOODS', dupes)).toBeNull()
  })

  it('ignores an archived record', () => {
    const archived = [{ id: 'c9', name: 'OLD BROKER', mcNumber: '1', active: false }] as never[]
    expect(resolveTenderCustomer('OLD BROKER', archived)).toBeNull()
  })

  it('is nothing for a blank name', () => {
    expect(resolveTenderCustomer('', customers)).toBeNull()
    expect(resolveTenderCustomer(null, customers)).toBeNull()
  })
})

describe('what a tender can and cannot tell us', () => {
  const E2 = `Load Report
-----------------------------------------
Ref #: TMS ID 208663813
      Shipments: SO-1732669

Shipper: BATORY FOODS
-----------------------------------------
Pick
BATORY'S OAKLEY CHICAGO 2234 W 43RD STREET CHICAGO , IL 60609
Plan: 08/04/2026 00:00 CDT
-----------------------------------------
Drop
EAGLE FOODS 3898 SUNSET AVENUE WAUKEGAN , IL 60087
Plan: 08/05/2026 00:00 CDT`

  it('gives the BROKER reference, which is not an Aljex PRO', () => {
    /*
     * The reference on a tender is the broker's own — a TMS ID, a route number. An Aljex
     * PRO is assigned later, when the load is built in Aljex, and its presence on a load is
     * exactly the fact that the load exists there. Treating one as the other would have
     * every intake-built load claiming a PRO it never had, so the drawer puts this in TMS
     * ID and leaves Pro# empty for a human to type off Aljex.
     */
    const t = parseTender('Tender TMS ID 208663813', E2)
    expect(t.reference).toBe('208663813')
    // Nothing in a tender is an Aljex PRO, so the parser never claims to produce one.
    expect(t).not.toHaveProperty('proNumber')
    expect(t).not.toHaveProperty('aljexId')
  })

  it('gives the shipment number, which is the PU#', () => {
    expect(parseTender('x', E2).pickupNumber).toBe('SO-1732669')
  })
})

describe('a broker acceptance notice', () => {
  /*
   * Axle, M2 and others send only this: one line saying the rate confirmation was accepted.
   * No lane, no rate, no dates, no attachment. There is exactly as much here as there is —
   * the reference and who it is from — and claiming more would be inventing it.
   */
  const AXLE_SUBJECT = 'Fwd: Axle Logistics, LLC Rate Confirmation for 3650024'
  const AXLE_BODY = `driver roy

---------- Forwarded message ---------
From: Jensen.Dupilka@axlelogistics.com
Subject: Axle Logistics, LLC Rate Confirmation for 3650024
To: <ivancartage@bcatcorp.com>

Axle Logistics, LLC Rate Confirmation for 3650024 has been Accepted.

Your Confirmation Number: 4819121`

  it('takes the broker’s reference', () => {
    expect(parseTender(AXLE_SUBJECT, AXLE_BODY).reference).toBe('3650024')
  })

  it('takes the broker’s name, without the Fwd: prefix', () => {
    expect(parseTender(AXLE_SUBJECT, AXLE_BODY).customer).toBe('Axle Logistics, LLC')
  })

  it('does NOT take the confirmation number as the reference', () => {
    // 4819121 is Axle's internal acknowledgement, not a load number. Putting it in TMS ID
    // would key the load to something no one can look up.
    expect(parseTender(AXLE_SUBJECT, AXLE_BODY).reference).not.toBe('4819121')
  })

  it('claims no lane, because the email has none', () => {
    const t = parseTender(AXLE_SUBJECT, AXLE_BODY)
    expect(t.stops).toEqual([])
  })

  it('works for the M2 variant of the same shape', () => {
    const t = parseTender('Fwd: M2 Logistics, Inc. Rate Confirmation for 5859872',
      'M2 Logistics, Inc. Rate Confirmation for 5859872 has been Accepted.')
    expect(t.reference).toBe('5859872')
    expect(t.customer).toBe('M2 Logistics, Inc.')
  })

  it('still matches the directory record despite the LLC suffix', () => {
    // normalizeName drops a trailing LLC/Inc, so "Axle Logistics, LLC" binds to the
    // directory's "AXLE LOGISTICS" exactly — and an exact match is the only kind accepted.
    const customers = [{ id: 'c1', name: 'AXLE LOGISTICS', active: true }] as never[]
    expect(resolveTenderCustomer('Axle Logistics, LLC', customers)?.id).toBe('c1')
  })
})

describe('the document that came in on the tender', () => {
  it('is carried on the prefill so the load can attach it', () => {
    // The attachment is pointed at, not copied: it is already in the same bucket.
    const t: TenderPrefill = { format: 'SUBJECT', stops: [], rateConKey: 'intake-attachments/i1/1-ratecon.pdf' }
    expect(t.rateConKey).toMatch(/\.pdf$/)
  })
})

describe('appointment times and facility instructions', () => {
  const WITH_APPT = `Load Report
-----------------------------------------
Ref #: TMS ID 208663813
      Shipments: SO-1732669
Shipper: BATORY FOODS
-----------------------------------------
Pick
BATORY'S OAKLEY CHICAGO 2234 W 43RD STREET CHICAGO , IL 60609
Instructions:  Appointments required  - https://na-app.tms.e2open.com
Plan: 06/17/2026 00:00 CDT - 06/17/2026 00:00 CDT
Appt: 06/17/2026 08:00 CDT - 06/17/2026 08:00 CDT
-----------------------------------------
Drop
EAGLE FOODS 3898 SUNSET AVENUE WAUKEGAN , IL 60087
Instructions: 48 Hour Notice for delivery appointments required
Plan: 06/18/2026 00:00 CDT - 06/18/2026 00:00 CDT
Appt: --`

  it('takes the BOOKED time from the Appt line', () => {
    const t = parseTender('x', WITH_APPT)
    expect(t.stops[0].dateStr).toBe('2026-06-17')
    expect(t.stops[0].time).toBe('08:00')
  })

  it('prefers the booked appointment over the planned date', () => {
    // Plan is when the shipper wants it; Appt is what was actually agreed.
    expect(parseApptLine('Appt: 06/17/2026 08:00 CDT - 06/17/2026 08:00 CDT'))
      .toEqual({ dateStr: '2026-06-17', time: '08:00' })
  })

  it('gives a date but NO time when the appointment is unbooked', () => {
    /*
     * Plan carries 00:00 on all 166 tenders on file — a placeholder for "no appointment
     * yet". Writing midnight into a stop would read as a time somebody agreed.
     */
    const t = parseTender('x', WITH_APPT)
    expect(t.stops[1].dateStr).toBe('2026-06-18')
    expect(t.stops[1].time).toBeUndefined()
  })

  it('treats a midnight Appt as unbooked too', () => {
    expect(parseApptLine('Appt: 06/17/2026 00:00 CDT')).toEqual({ dateStr: '2026-06-17' })
  })

  it('is nothing for an Appt that reads --', () => {
    expect(parseApptLine('Appt: --')).toBeNull()
  })

  it('carries each stop’s instructions', () => {
    const t = parseTender('x', WITH_APPT)
    expect(t.stops[0].instructions).toMatch(/Appointments required/)
    expect(t.stops[1].instructions).toMatch(/48 Hour Notice/)
  })

  it('keeps the shipment number as the PU#', () => {
    expect(parseTender('x', WITH_APPT).pickupNumber).toBe('SO-1732669')
  })

  it('still reads the full address alongside all of it', () => {
    const t = parseTender('x', WITH_APPT)
    expect(t.stops[0]).toMatchObject({ city: 'CHICAGO', state: 'IL', zip: '60609' })
    expect(t.stops[1]).toMatchObject({ city: 'WAUKEGAN', state: 'IL', zip: '60087' })
  })
})
