import { describe, expect, it } from 'vitest'

import {
  FINAL_STAGE, LAST_MODEL_STAGE, MODEL_STAGE, PRODUCTION_MODELS, TRIGGER_MODELS, TTL_STAGE, VENDOR_AP_EXTRACT_RETIRED_STAGE,
  modelPresent, parseSchemaStage, pitrEnabled, triggerEnabled, vendorApExtractLegacy, type TriggerName,
} from './stages'

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

describe('triggerEnabled', () => {
  const expectedStage: Record<TriggerName, number> = {
    workflowSweep: 3,
    spotQuoterPoll: 1,
    mcpSync: 1,
    dataSafetyNightly: 3,
    trackingAutomation: 2,
  }

  it.each(Object.entries(expectedStage))('%s is off below stage %i and on from it', (name, stage) => {
    expect(triggerEnabled(name as TriggerName, stage - 1)).toBe(false)
    expect(triggerEnabled(name as TriggerName, stage)).toBe(true)
    expect(triggerEnabled(name as TriggerName, FINAL_STAGE)).toBe(true)
  })

  it('no trigger is created at stage 0 (every one reads a table that does not exist yet)', () => {
    for (const name of Object.keys(TRIGGER_MODELS) as TriggerName[]) expect(triggerEnabled(name, 0)).toBe(false)
  })
})

describe('vendorApExtractLegacy', () => {
  it('production extractor stays below the stage that creates WorkflowRun and goes from it', () => {
    expect(VENDOR_AP_EXTRACT_RETIRED_STAGE).toBe(MODEL_STAGE.WorkflowRun)
    expect(vendorApExtractLegacy(0)).toBe(true)
    expect(vendorApExtractLegacy(VENDOR_AP_EXTRACT_RETIRED_STAGE - 1)).toBe(true)
    expect(vendorApExtractLegacy(VENDOR_AP_EXTRACT_RETIRED_STAGE)).toBe(false)
    expect(vendorApExtractLegacy(FINAL_STAGE)).toBe(false)
  })
})

describe('pitrEnabled', () => {
  it('production main (no env) never flips PITR, at any stage', () => {
    for (const stage of [0, 1, LAST_MODEL_STAGE, FINAL_STAGE]) expect(pitrEnabled({}, stage)).toBe(false)
  })

  it('the dev stack turns it on only at the final stage', () => {
    expect(pitrEnabled({ BCAT_DEV_STACK: 'true' }, FINAL_STAGE)).toBe(true)
    expect(pitrEnabled({ BCAT_DEV_STACK: 'true' }, FINAL_STAGE - 1)).toBe(false)
  })

  it('an explicit false wins over the dev stack (staged rehearsal mirrors production)', () => {
    expect(pitrEnabled({ BCAT_DEV_STACK: 'true', BCAT_ENABLE_PITR: 'false' }, FINAL_STAGE)).toBe(false)
  })

  it('an explicit true turns it on anywhere', () => {
    expect(pitrEnabled({ BCAT_ENABLE_PITR: 'true' }, 0)).toBe(true)
  })
})
