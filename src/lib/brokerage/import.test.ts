import { describe, expect, it } from 'vitest'
import {
  IMPORT_ENTITIES,
  planImport,
  suggestMapping,
  validateImportJob,
  validateRows,
} from './import'

describe('IMPORT_ENTITIES', () => {
  it('contains exactly the seven directory entities', () => {
    expect(IMPORT_ENTITIES).toEqual([
      'CUSTOMER',
      'LOCATION',
      'CARRIER',
      'CARRIER_FACTOR',
      'CHARGE_CODE',
      'PAYMENT_TERM',
      'VENDOR_CONTACT',
    ])
  })
})

describe('validateImportJob', () => {
  it('accepts a valid job', () => {
    const job = validateImportJob({
      entity: 'CUSTOMER',
      fileName: 'customers.csv',
      fileHash: 'abc123',
      mapping: { Company: 'name' },
      createdBy: 'ryne@bcatcorp.com',
    })
    expect(job.entity).toBe('CUSTOMER')
    expect(job.fileHash).toBe('abc123')
  })

  it('refuses a non-directory entity', () => {
    expect(() => validateImportJob({
      entity: 'SHIPMENT',
      fileName: 'x.csv',
      fileHash: 'abc',
      mapping: {},
      createdBy: 'x',
    })).toThrow('Only directory entities may be imported')
  })

  it('refuses an unmapped required column', () => {
    expect(() => validateImportJob({
      entity: 'CUSTOMER',
      fileName: 'x.csv',
      fileHash: 'abc',
      mapping: { mcNumber: 'mcNumber' },
      createdBy: 'x',
    })).toThrow('Required column "name" is not mapped')
  })
})

describe('suggestMapping', () => {
  it('maps exact and case-insensitive headers', () => {
    const mapping = suggestMapping(['Name', 'MC Number', 'City'], 'CUSTOMER')
    expect(mapping['Name']).toBe('name')
    expect(mapping['MC Number']).toBe('mcNumber')
  })

  it('maps aliases', () => {
    const mapping = suggestMapping(['Company', 'MC#'], 'CUSTOMER')
    expect(mapping['Company']).toBe('name')
    expect(mapping['MC#']).toBe('mcNumber')
  })
})

describe('validateRows', () => {
  it('validates required fields and reports line and column', () => {
    const { ok, errors } = validateRows(
      [{ name: 'Batory Foods' }, { name: '' }],
      { name: 'name' },
      'CUSTOMER',
    )
    expect(ok).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toEqual({ line: 2, column: 'name', message: 'name is required.' })
  })

  it('validates email fields', () => {
    const { errors } = validateRows(
      [{ name: 'X', email: 'bad' }],
      { name: 'name', email: 'email' },
      'VENDOR_CONTACT',
    )
    expect(errors[0].message).toContain('not an e-mail')
  })

  it('validates integer fields', () => {
    const { errors } = validateRows(
      [{ key: 'net-30', name: 'Net 30', days: 'abc' }],
      { key: 'key', name: 'name', days: 'days' },
      'PAYMENT_TERM',
    )
    expect(errors[0].message).toContain('whole number')
  })

  it('validates money fields', () => {
    const { ok, errors } = validateRows(
      [{ code: 'FSC', label: 'Fuel', defaultAmountCents: '1.50' }],
      { code: 'code', label: 'label', defaultAmountCents: 'defaultAmountCents' },
      'CHARGE_CODE',
    )
    expect(errors).toHaveLength(0)
    expect(ok[0].fields.defaultAmountCents).toBe(150)
  })
})

describe('planImport', () => {
  it('matches an existing customer on normalizedName', () => {
    const ok = [{ line: 1, fields: { name: 'Batory Foods, Inc.' } }]
    const existingByKey = { 'batory foods': { id: 'c1', name: 'Batory Foods' } }
    const plan = planImport(ok, existingByKey, 'CUSTOMER')
    expect(plan.create).toHaveLength(0)
    expect(plan.update).toHaveLength(1)
  })

  it('plans a create for a new customer', () => {
    const ok = [{ line: 1, fields: { name: 'New Customer LLC' } }]
    const plan = planImport(ok, {}, 'CUSTOMER')
    expect(plan.create).toHaveLength(1)
    expect(plan.update).toHaveLength(0)
    expect(plan.skip).toHaveLength(0)
  })

  it('matches a carrier on mcNumber first', () => {
    const ok = [{ line: 1, fields: { name: 'Axle Logistics LLC', mcNumber: '123456' } }]
    const existingByKey = { 'mc:123456': { id: 'c1', name: 'Axle Logistics', mcNumber: '123456' } }
    const plan = planImport(ok, existingByKey, 'CARRIER')
    expect(plan.update).toHaveLength(1)
  })

  it('skips identical rows on a second run', () => {
    const ok = [{ line: 1, fields: { name: 'Batory Foods' } }]
    const existingByKey = { 'batory foods': { id: 'c1', name: 'Batory Foods' } }
    const first = planImport(ok, existingByKey, 'CUSTOMER')
    expect(first.skip).toHaveLength(1)
  })

  it('refuses entities outside the seven', () => {
    expect(() => planImport([], {}, 'SHIPMENT')).toThrow('Only directory entities may be imported')
  })
})
