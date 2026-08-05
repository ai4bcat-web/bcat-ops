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
