import { describe, expect, it } from 'vitest'

import { FINAL_STAGE, LAST_MODEL_STAGE, MODEL_STAGE, PRODUCTION_MODELS, TTL_STAGE, modelPresent, parseSchemaStage } from './stages'

describe('parseSchemaStage', () => {
  it('unset, empty and >= final all mean the whole schema', () => {
    expect(parseSchemaStage(undefined)).toBe(FINAL_STAGE)
    expect(parseSchemaStage('')).toBe(FINAL_STAGE)
    expect(parseSchemaStage('99')).toBe(FINAL_STAGE)
    expect(parseSchemaStage('0')).toBe(0)
  })

  it('refuses a value that is not a non-negative integer rather than guessing a stage', () => {
    expect(() => parseSchemaStage('two')).toThrow()
    expect(() => parseSchemaStage('-1')).toThrow()
    expect(() => parseSchemaStage('1.5')).toThrow()
  })
})

describe('modelPresent', () => {
  it('production models exist at every stage', () => {
    expect(modelPresent('Load', 0)).toBe(true)
  })

  it('a listed model appears at its stage and not before', () => {
    expect(modelPresent('Shipment', MODEL_STAGE.Shipment - 1)).toBe(false)
    expect(modelPresent('Shipment', MODEL_STAGE.Shipment)).toBe(true)
  })

  it('a model nobody listed lands in the last table-creating stage, never in the TTL-only stage', () => {
    expect(modelPresent('SomeFutureModel', LAST_MODEL_STAGE - 1)).toBe(false)
    expect(modelPresent('SomeFutureModel', LAST_MODEL_STAGE)).toBe(true)
    expect(LAST_MODEL_STAGE).toBeLessThan(TTL_STAGE)
  })

  it('no production model is also staged', () => {
    expect(Object.keys(MODEL_STAGE).filter((m) => PRODUCTION_MODELS.has(m))).toEqual([])
  })
})
