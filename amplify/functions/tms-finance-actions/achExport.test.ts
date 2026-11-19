/**
 * The Chase ACH preview and export, against an in-memory store. Bank numbers are synthetic (a public Federal
 * Reserve routing number and made-up accounts); the KMS client is the in-memory fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeKms } from '../_shared/fakeKms'
import { encryptBankDetails, normalizeBankDetails } from '../_shared/bankVault'

type Row = Record<string, unknown>
const T = vi.hoisted(() => ({ rows: new Map<string, Map<string, Record<string, unknown>>>(), audits: [] as Record<string, unknown>[], settings: {} as Record<string, unknown> }))

vi.mock('./store', () => {
  const tbl = (name: string) => T.rows.get(name) ?? T.rows.set(name, new Map()).get(name)!
  return {
    CARRIER_BILL_TABLE_NAME: 'bills',
    CARRIER_PAYMENT_METHOD_TABLE_NAME: 'methods',
    CARRIER_TABLE_NAME: 'carriers',
    IDX_PAYMENT_METHODS_BY_CARRIER: 'byCarrier',
    SETTINGS_ID: 'default',
    SETTINGS_TABLE_NAME: 'settings',
    getById: async (table: string, id: string) => (table === 'settings' ? T.settings : tbl(table).get(id) ?? null),
    getSettings: async () => T.settings,
    nowIso: () => '2026-11-19T15:00:00.000Z',
    queryIndex: async (table: string, _index: string, key: string, value: string) => [...tbl(table).values()].filter((r) => r[key] === value),
    updateTx: (table: string, id: string, patch: Row, options: { remove?: string[] } = {}) => ({ table, id, patch, remove: options.remove ?? [] }),
    transact: async (items: { table: string; id: string; patch: Row; remove: string[] }[]) => {
      for (const { table, id, patch, remove } of items) {
        if (table === 'settings') { Object.assign(T.settings, patch); continue }
        const row = tbl(table).get(id)
        if (!row) throw new Error('missing')
        Object.assign(row, patch)
        for (const key of remove) delete row[key]
      }
    },
    writeAudit: async (entity: string, id: string, action: string, _caller: unknown, changes: Row) => { T.audits.push({ entity, id, action, changes }) },
  }
})

import { clearChaseAchMark, exportChaseAch, previewChaseAch, saveChaseAchSettings, setBankVaultForTests } from './achExport'

const ROUTING = '011000015'
const ACCOUNT = '000123456789'
const ADMIN = { email: 'ryne@bcatcorp.com', sub: 's', groups: ['ADMIN'], isAdmin: true }

const origin = { companyName: 'Test Company', companyId: '1234567890', odfiRouting: '021000021', secCode: 'CCD', entryDescription: 'CARRIERPAY' }

function put(table: string, row: Row) { (T.rows.get(table) ?? T.rows.set(table, new Map()).get(table)!).set(String(row.id), row) }

async function seedBill(n: number, opts: { method?: string; bank?: boolean; last4?: string; status?: string; selected?: boolean; exported?: boolean } = {}) {
  const carrierId = `car-${n}`
  const methodId = `pm-${n}`
  const deps = { kms: fakeKms(), carrierTable: 'Carrier-5ucwdyvwivelbo4k4jomvrwel4-NONE' }
  const cipher = opts.bank === false ? undefined : await encryptBankDetails(deps, { carrierId, methodId }, normalizeBankDetails({ routingNumber: ROUTING, accountNumber: `${ACCOUNT.slice(0, 8)}${String(1000 + n)}`, accountType: 'CHECKING' }))
  put('carriers', { id: carrierId, name: `Fake Carrier ${n}`, factorPaymentMethodId: null })
  put('methods', {
    id: methodId, carrierId, method: opts.method ?? 'ACH', recipientType: 'CARRIER', isPreferred: true, status: 'ACTIVE',
    accountLast4: opts.last4 ?? String(1000 + n), ...(cipher ? { bankCipher: cipher } : {}),
  })
  put('bills', {
    id: `bill-${n}`, carrierId, carrierName: `Fake Carrier ${n}`, shipmentNumber: `${14500 + n}-1`, status: opts.status ?? 'TO_BE_PAID',
    selectedForPayment: opts.selected ?? true, balanceCents: 100_000 + n, version: 1, payeeKind: 'CARRIER', paymentMethodId: methodId,
    remitTo: { name: `Fake Carrier ${n}`, method: opts.method ?? 'ACH' }, ...(opts.exported ? { achExportedAt: '2026-11-18T10:00:00.000Z' } : {}),
  })
}

beforeEach(() => {
  // Pin the clock: the effective dates below must be a business day after "today".
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-19T15:00:00.000Z'))
  T.rows.clear()
  T.audits.length = 0
  T.settings = { id: 'default', chaseAch: origin }
  setBankVaultForTests({ kms: fakeKms(), carrierTable: 'Carrier-5ucwdyvwivelbo4k4jomvrwel4-NONE' })
})

describe('PREVIEW_CHASE_ACH', () => {
  it('classifies each bill and never returns a number', async () => {
    await seedBill(1)
    await seedBill(2, { method: 'CHECK' })
    await seedBill(3, { bank: false })
    await seedBill(4, { last4: '9999' })
    await seedBill(5, { selected: false })
    const out = await previewChaseAch({ billIds: ['bill-1', 'bill-2', 'bill-3', 'bill-4', 'bill-5'], effectiveDate: '2026-11-23' })
    const byId = Object.fromEntries((out.rows as Row[]).map((r) => [r.billId, r]))
    expect(byId['bill-1']).toMatchObject({ status: 'READY', last4: '1001', pro: '14501' })
    expect(byId['bill-2']).toMatchObject({ status: 'SKIPPED' })
    expect(byId['bill-3']).toMatchObject({ status: 'BLOCKED' })
    expect(String(byId['bill-3'].reason)).toContain('No bank details')
    expect(byId['bill-4']).toMatchObject({ status: 'BLOCKED' })
    expect(byId['bill-5']).toMatchObject({ status: 'SKIPPED' })
    expect(out).toMatchObject({ settingsReady: true, readyCount: 1, blockedCount: 2, skippedCount: 2 })
    const text = JSON.stringify(out)
    expect(text).not.toContain(ROUTING)
    expect(text).not.toContain(ACCOUNT)
  })

  it('says when the Chase settings are not set up', async () => {
    T.settings = { id: 'default' }
    await seedBill(1)
    const out = await previewChaseAch({ billIds: ['bill-1'] })
    expect(out.settingsReady).toBe(false)
    expect(String(out.settingsProblem)).toContain('not set up')
  })
})

describe('EXPORT_CHASE_ACH', () => {
  it('builds a NACHA file for the ready ACH bills, marks them, and audits without numbers', async () => {
    await seedBill(1)
    await seedBill(2)
    await seedBill(3, { method: 'WIRE' })
    const out = await exportChaseAch({ billIds: ['bill-1', 'bill-2', 'bill-3'], effectiveDate: '2026-11-23' }, ADMIN)
    expect(out.entryCount).toBe(2)
    expect(out.totalCents).toBe(100_001 + 100_002)
    expect(out.exportedBillIds).toEqual(['bill-1', 'bill-2'])
    const lines = String(out.fileText).split('\r\n').filter(Boolean)
    expect(lines.every((l) => l.length === 94)).toBe(true)
    expect(lines.filter((l) => l[0] === '6')).toHaveLength(2)
    expect(String(out.fileText)).toContain(ROUTING)
    expect(String(out.fileText)).toContain('000123451001')
    expect(String(out.fileName)).toMatch(/^BCAT-ACH-\d{8}-\d{4}A\.ach$/)

    const bill = T.rows.get('bills')!.get('bill-1')!
    expect(bill.achExportedAt).toBe('2026-11-19T15:00:00.000Z')
    expect(bill.achExportedBy).toBe('ryne@bcatcorp.com')
    expect(T.rows.get('bills')!.get('bill-3')!.achExportedAt).toBeUndefined()
    // no payment recorded, bill still selected and unpaid
    expect(bill.selectedForPayment).toBe(true)
    expect(bill.status).toBe('TO_BE_PAID')

    const audits = JSON.stringify(T.audits)
    expect(audits).toContain('EXPORT_CHASE_ACH')
    expect(audits).toContain('1001')
    expect(audits).not.toContain(ROUTING)
    expect(audits).not.toContain(ACCOUNT)
  })

  it('counts the files made the same day with the modifier', async () => {
    await seedBill(1)
    await exportChaseAch({ billIds: ['bill-1'], effectiveDate: '2026-11-23' }, ADMIN)
    await seedBill(2)
    const second = await exportChaseAch({ billIds: ['bill-2'], effectiveDate: '2026-11-23' }, ADMIN)
    expect(String(second.fileName)).toMatch(/B\.ach$/)
  })

  it('leaves out bills already exported unless asked', async () => {
    await seedBill(1, { exported: true })
    await seedBill(2)
    const out = await exportChaseAch({ billIds: ['bill-1', 'bill-2'], effectiveDate: '2026-11-23' }, ADMIN)
    expect(out.exportedBillIds).toEqual(['bill-2'])
    expect((out.notExported as Row[]).some((r) => r.billId === 'bill-1')).toBe(true)
    const again = await exportChaseAch({ billIds: ['bill-1'], effectiveDate: '2026-11-23', includeAlreadyExported: true }, ADMIN)
    expect(again.exportedBillIds).toEqual(['bill-1'])
  })

  it('refuses with no settings, a past or weekend date, or nothing ready', async () => {
    await seedBill(1)
    T.settings = { id: 'default' }
    await expect(exportChaseAch({ billIds: ['bill-1'], effectiveDate: '2026-11-23' }, ADMIN)).rejects.toThrow('not set up')
    T.settings = { id: 'default', chaseAch: origin }
    await expect(exportChaseAch({ billIds: ['bill-1'], effectiveDate: '2026-11-21' }, ADMIN)).rejects.toThrow('business day')
    await expect(exportChaseAch({ billIds: ['bill-1'], effectiveDate: '2020-01-02' }, ADMIN)).rejects.toThrow('after today')
    await seedBill(2, { bank: false })
    await expect(exportChaseAch({ billIds: ['bill-2'], effectiveDate: '2026-11-23' }, ADMIN)).rejects.toThrow('No bill is ready')
    expect(T.rows.get('bills')!.get('bill-2')!.achExportedAt).toBeUndefined()
  })

  it('undoes the mark without touching the bill otherwise', async () => {
    await seedBill(1)
    await exportChaseAch({ billIds: ['bill-1'], effectiveDate: '2026-11-23' }, ADMIN)
    const out = await clearChaseAchMark({ billIds: ['bill-1'] }, ADMIN)
    expect(out.cleared).toEqual(['bill-1'])
    const bill = T.rows.get('bills')!.get('bill-1')!
    expect(bill.achExportedAt).toBeUndefined()
    expect(bill.selectedForPayment).toBe(true)
  })
})

describe('SAVE_CHASE_ACH_SETTINGS', () => {
  it('validates the origin and keeps the file counter', async () => {
    T.settings = { id: 'default', chaseAch: { ...origin, fileSeq: { date: '2026-11-19', n: 2 } } }
    await expect(saveChaseAchSettings({ ...origin, companyId: '123' }, ADMIN)).rejects.toThrow('10 digits')
    await expect(saveChaseAchSettings({ ...origin, odfiRouting: '011000015' }, ADMIN)).rejects.toThrow('Chase')
    const out = await saveChaseAchSettings({ ...origin, companyName: 'New Name' }, ADMIN)
    expect((out.chaseAch as Row).companyName).toBe('New Name')
    expect(((T.settings.chaseAch as Row).fileSeq as Row).n).toBe(2)
  })
})
