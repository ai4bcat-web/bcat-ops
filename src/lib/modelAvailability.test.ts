import { describe, it, expect } from 'vitest'
import { modelAvailable, modelsAvailable, type AmplifyOutputsLike } from './modelAvailability'

const stage0: AmplifyOutputsLike = { data: { model_introspection: { models: { Load: {}, Customer: {} } } } }

describe('modelAvailability', () => {
  it('reports a model present in the deployed introspection and absent otherwise', () => {
    expect(modelAvailable('Load', stage0)).toBe(true)
    expect(modelAvailable('Shipment', stage0)).toBe(false)
  })

  it('needs every listed model for modelsAvailable', () => {
    expect(modelsAvailable(['Load', 'Customer'], stage0)).toBe(true)
    expect(modelsAvailable(['Load', 'Shipment'], stage0)).toBe(false)
    expect(modelsAvailable([], stage0)).toBe(true)
  })

  it('does not read inherited object keys as models', () => {
    expect(modelAvailable('toString', stage0)).toBe(false)
    expect(modelAvailable('constructor', stage0)).toBe(false)
  })

  it('assumes everything is deployed when the outputs carry no introspection', () => {
    for (const outputs of [{}, { data: {} }, { data: { model_introspection: {} } }, { data: { model_introspection: null } }]) {
      expect(modelAvailable('Shipment', outputs)).toBe(true)
      expect(modelsAvailable(['Shipment', 'Invoice'], outputs)).toBe(true)
    }
  })

  it('treats an empty deployed model list as a schema with nothing in it', () => {
    expect(modelAvailable('Load', { data: { model_introspection: { models: {} } } })).toBe(false)
  })
})
