/**
 * What an AppSync request to a TMS action router carries, and how each field is checked.
 *
 * These started inside `tms-shipment-actions/handler.ts`, moved out when step E added
 * `documents.ts`, and moved here when step F added `tms-finance-actions`: four modules
 * validate the same kinds of field, and a second set of near-identical validators would
 * be two places for one rule to drift. Nothing here reaches for a client or an
 * environment variable, so any module can call any of it without arranging anything.
 */
import type { Row } from './shipmentStore'

/** Element-validated JSON arrays are capped so one request cannot blow the item size. */
export const MAX_JSON_ELEMENTS = 100

/** Who is asking, as `authorize` resolved them from the Cognito identity. */
export interface Caller {
  email: string
  sub: string
  groups: string[]
  isAdmin: boolean
}

export function parseInput(input: string | Record<string, unknown> | null | undefined): Row {
  if (input == null) return {}
  if (typeof input === 'string') {
    if (!input.trim()) return {}
    const parsed: unknown = JSON.parse(input)
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('Invalid input: must be a JSON object')
    }
    return parsed as Row
  }
  if (Array.isArray(input) || typeof input !== 'object') throw new Error('Invalid input: must be an object')
  return input
}

export function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} cannot be empty`)
  return trimmed
}

export function optionalString(value: unknown, maxLen?: number): string | null {
  if (value == null) return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (maxLen != null && trimmed.length > maxLen) throw new Error(`Field exceeds maximum length of ${maxLen}`)
  return trimmed
}

export function optionalInteger(value: unknown, options?: { min?: number; max?: number; label?: string }): number | null {
  if (value == null) return null
  const label = options?.label ?? 'Value'
  let num: number
  if (typeof value === 'number') num = value
  else if (typeof value === 'string' && value.trim()) num = Number(value)
  else throw new Error(`${label} must be an integer`)
  if (!Number.isFinite(num) || !Number.isInteger(num)) throw new Error(`${label} must be an integer`)
  if (options?.min != null && num < options.min) throw new Error(`${label} must be at least ${options.min}`)
  if (options?.max != null && num > options.max) throw new Error(`${label} must be at most ${options.max}`)
  if (num < -2_147_483_648 || num > 2_147_483_647) throw new Error(`${label} exceeds GraphQL integer range`)
  return num
}

/** A coordinate, which is the one number in this router that is not an integer. */
export function optionalFloat(value: unknown, options: { min: number; max: number; label: string }): number | null {
  if (value == null || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) throw new Error(`${options.label} must be a number`)
  if (num < options.min || num > options.max) {
    throw new Error(`${options.label} must be between ${options.min} and ${options.max}`)
  }
  return num
}

export function optionalBoolean(value: unknown): boolean | null {
  if (value == null) return null
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('Value must be a boolean')
}

export function assertEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const v = assertString(value, label)
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`${label} must be one of ${allowed.join(', ')}`)
  return v as T
}

export function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T | null {
  const v = optionalString(value, 64)
  if (v == null) return null
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`${label} must be one of ${allowed.join(', ')}`)
  return v as T
}

export function assertRecord(value: unknown, label: string): Row {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Row
}

export function assertArrayOf<T>(
  value: unknown,
  label: string,
  validate: (item: unknown, index: number) => T,
  maxLen = MAX_JSON_ELEMENTS,
): T[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  if (value.length > maxLen) throw new Error(`${label} must have at most ${maxLen} entries`)
  return value.map(validate)
}

/** ISO-8601 is what every stop time, appointment and audit row in this system is. */
export function assertIso(value: unknown, label: string): string {
  const v = assertString(value, label)
  if (Number.isNaN(Date.parse(v))) throw new Error(`${label} must be an ISO timestamp`)
  return v
}

export function optionalIso(value: unknown, label: string): string | null {
  if (value == null || value === '') return null
  return assertIso(value, label)
}

export function assertExpectedUpdatedAt(input: Row): string {
  const value = input.expectedUpdatedAt
  if (value == null) throw new Error('expectedUpdatedAt is required')
  if (typeof value !== 'string') throw new Error('expectedUpdatedAt must be a string')
  return value
}
