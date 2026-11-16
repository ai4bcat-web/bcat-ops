import { describe, expect, it, vi } from 'vitest'
import { plainSaveError, runPendingSaves, type PendingSave } from './railSave'

describe('runPendingSaves', () => {
  it('saves in order and keeps going past a failure', async () => {
    const calls: string[] = []
    const save = (label: string, order: number, fail = false): PendingSave => ({ label, order, run: vi.fn(async () => { calls.push(label); if (fail) throw new Error('name must be a string') }) })
    const failures = await runPendingSaves(new Map([['charges', save('Charges', 60)], ['customer', save('Customer', 0, true)], ['ref', save('PO', 10)]]))
    expect(calls).toEqual(['Customer', 'PO', 'Charges'])
    expect([...failures.keys()]).toEqual(['customer'])
    expect(failures.get('customer')).toMatch(/^Customer could not be saved: a required field is missing/)
  })
})

describe('plainSaveError', () => {
  it('says what to do when someone else changed the record', () => {
    expect(plainSaveError('Stop 2 times', new Error('ConditionalCheckFailedException'))).toBe('Stop 2 times could not be saved because someone else changed it meanwhile. Re-check, then save again.')
  })
})
