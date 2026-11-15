import { describe, it, expect } from 'vitest'
import { findLoadByPro, loadLabel } from './loadTarget'

const loads = [
  { id: 'a', proNumber: '20031', lane: 'El Paso, TX → Edwardsville, IL', customer: null, deliveryAppt: null },
  { id: 'b', proNumber: '014538', lane: 'X → Y', customer: null, deliveryAppt: null },
]

describe('loadTarget', () => {
  it('finds the driver load by PRO, ignoring padding and leading zeros', () => {
    expect(findLoadByPro(loads, ' 20031 ')?.id).toBe('a')
    expect(findLoadByPro(loads, '14538')?.id).toBe('b')
  })
  it('never matches a reference that is not one of their PROs', () => {
    expect(findLoadByPro(loads, '4011180493')).toBeUndefined()
    expect(findLoadByPro(loads, '')).toBeUndefined()
  })
  it('names the load by PRO and lane', () => {
    expect(loadLabel('20031', 'El Paso, TX → Edwardsville, IL')).toBe('PRO 20031 · El Paso, TX → Edwardsville, IL')
    expect(loadLabel('20031', null)).toBe('PRO 20031')
  })
})
