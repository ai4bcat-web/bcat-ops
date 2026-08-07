import { describe, it, expect } from 'vitest'
import { isTrailerFieldUndefined } from './apiClient'

/**
 * Regression guard: a missed detection here doesn't just disable the trailer picker —
 * listDrivers throws, initializeData bails on the first failure, and the whole driver
 * roster comes back empty (trucks still render from persisted local state). That is
 * exactly how the Files page ended up showing trucks and no drivers.
 *
 * The Amplify client surfaces a rejected selection set in several shapes, so the check
 * must catch all of them.
 */
describe('assignedTrailerId pre-deploy detection', () => {
  const FIELD_UNDEFINED =
    "Validation error of type FieldUndefined: Field 'assignedTrailerId' in type 'Driver' is undefined @ 'listDrivers/items/assignedTrailerId'"

  it('catches the standard GraphQL errors[] shape', () => {
    expect(isTrailerFieldUndefined({ errors: [{ message: FIELD_UNDEFINED }] })).toBe(true)
  })

  it('catches a bare Error whose text is only on .message', () => {
    // JSON.stringify(new Error(...)) is "{}" — message is not an own enumerable prop,
    // so a stringify-only check would silently miss this shape.
    expect(isTrailerFieldUndefined(new Error(FIELD_UNDEFINED))).toBe(true)
  })

  it('catches a partial response carrying both data and errors', () => {
    expect(isTrailerFieldUndefined({
      data: { listDrivers: null },
      errors: [{ message: FIELD_UNDEFINED, errorType: 'ValidationError' }],
    })).toBe(true)
  })

  it('catches a nested/wrapped error', () => {
    expect(isTrailerFieldUndefined({ cause: { errors: [{ message: FIELD_UNDEFINED }] } })).toBe(true)
  })

  it('ignores unrelated failures so real errors still surface', () => {
    expect(isTrailerFieldUndefined(new Error('NetworkError: Failed to fetch'))).toBe(false)
    expect(isTrailerFieldUndefined({ errors: [{ message: "Field 'sortOrder' in type 'Load' is undefined" }] })).toBe(false)
    expect(isTrailerFieldUndefined(null)).toBe(false)
    expect(isTrailerFieldUndefined(undefined)).toBe(false)
  })

  it('survives a circular error object without throwing', () => {
    const circular: Record<string, unknown> = { message: FIELD_UNDEFINED }
    circular.self = circular
    expect(isTrailerFieldUndefined(circular)).toBe(true)
  })
})

describe('a saved value must come back in the response', () => {
  it('the optimistic selection always asks for the newer fields', () => {
    // The write succeeding is only half of it: if the response selection omits
    // fleetGroup, the returned driver overwrites local state without it and a value
    // that WAS saved instantly reads as unsaved. That is what "it's not saving" was.
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const src = readFileSync('src/lib/apiClient.ts', 'utf8')
    const updateDriver = src.slice(src.indexOf('export async function updateDriver'))
    const run = updateDriver.slice(0, updateDriver.indexOf('export async function', 10))
    expect(run).toContain('assignedTrailerId fleetGroup')
    // And the fallback path must NOT ask for them, or it would fail the same way.
    expect(run).toContain('withNewFields')
  })
})
