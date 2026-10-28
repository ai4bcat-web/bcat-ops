import { describe, expect, it } from 'vitest'
import { phoneAssignmentWrites, phoneOf } from './companyPhones'

const phones = [
  { label: 'Ivan Cartage #1', assignedDriverId: null },
  { label: 'Ivan Cartage #2', assignedDriverId: 'amy' },
  { label: 'Ivan Cartage #3', assignedDriverId: 'john' },
]

describe('phoneAssignmentWrites', () => {
  it('hands a spare phone to a driver who has none', () => {
    expect(phoneAssignmentWrites(phones, 'bob', 'Ivan Cartage #1')).toEqual([{ label: 'Ivan Cartage #1', assignedDriverId: 'bob' }])
  })

  it('returns the old phone to the office when a driver switches', () => {
    expect(phoneAssignmentWrites(phones, 'john', 'Ivan Cartage #1')).toEqual([
      { label: 'Ivan Cartage #3', assignedDriverId: null },
      { label: 'Ivan Cartage #1', assignedDriverId: 'john' },
    ])
  })

  it('takes a phone from whoever had it — one write moves it', () => {
    expect(phoneAssignmentWrites(phones, 'bob', 'Ivan Cartage #2')).toEqual([{ label: 'Ivan Cartage #2', assignedDriverId: 'bob' }])
  })

  it('clears a driver back to no phone', () => {
    expect(phoneAssignmentWrites(phones, 'john', null)).toEqual([{ label: 'Ivan Cartage #3', assignedDriverId: null }])
  })

  it('writes nothing when nothing changes', () => {
    expect(phoneAssignmentWrites(phones, 'john', 'Ivan Cartage #3')).toEqual([])
  })
})

describe('phoneOf', () => {
  it('finds the phone a driver carries', () => {
    expect(phoneOf(phones, 'john')?.label).toBe('Ivan Cartage #3')
    expect(phoneOf(phones, 'bob')).toBeNull()
  })
})
