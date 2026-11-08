/**
 * Spreadsheet import for directory entities (Step L).
 *
 * Preview / dry-run only: validateRows and planImport return what would happen,
 * but they write nothing. The seven directory entities are whitelisted; anything
 * that mints a PRO (shipment, invoice, carrier bill) is refused by name.
 *
 * Pure: no store, no clock, no network. Imports are relative because the
 * tmsDirectoryActions Lambda bundles this file by path.
 */
import { isActiveDirectoryRecord, normalizeName } from '../tmsDirectory'

export type ImportEntity =
  | 'CUSTOMER'
  | 'LOCATION'
  | 'CARRIER'
  | 'CARRIER_FACTOR'
  | 'CHARGE_CODE'
  | 'PAYMENT_TERM'
  | 'VENDOR_CONTACT'

export const IMPORT_ENTITIES: readonly ImportEntity[] = [
  'CUSTOMER',
  'LOCATION',
  'CARRIER',
  'CARRIER_FACTOR',
  'CHARGE_CODE',
  'PAYMENT_TERM',
  'VENDOR_CONTACT',
]

export interface ImportField {
  name: string
  required: boolean
  max?: number
  kind?: 'string' | 'integer' | 'email' | 'money'
}

export interface ImportEntityDef {
  entity: ImportEntity
  label: string
  fields: ImportField[]
  naturalKey: (row: Record<string, unknown>) => string | null
}

export interface ImportRowError {
  line: number
  column: string
  message: string
}

export interface ImportRowResult {
  line: number
  fields: Record<string, unknown>
}

export interface ImportPlan {
  create: Record<string, unknown>[]
  update: { existing: Record<string, unknown>; changes: Record<string, unknown> }[]
  skip: Record<string, unknown>[]
}

export interface ImportJobInput {
  entity: ImportEntity
  fileName: string
  fileHash: string
  mapping: Record<string, string>
  rowCount?: number | null
  dryRun?: boolean | null
  note?: string | null
  createdBy: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_FILE_NAME = 255
const MAX_FILE_HASH = 128
const MAX_NOTE = 2000

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function text(value: unknown, max?: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return max != null ? trimmed.slice(0, max) : trimmed
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '').trim()
}

const aliasTable: Record<string, Record<string, string>> = {
  CUSTOMER: {
    company: 'name',
    'companyname': 'name',
    'company name': 'name',
    'mc#': 'mcNumber',
    'mc num': 'mcNumber',
    'mc number': 'mcNumber',
    'dot#': 'dotNumber',
    'dot num': 'dotNumber',
    'dot number': 'dotNumber',
  },
  LOCATION: {
    company: 'name',
    'companyname': 'name',
    'company name': 'name',
    address: 'street',
    'streetaddress': 'street',
    'zip code': 'zip',
    postalcode: 'zip',
  },
  CARRIER: {
    company: 'name',
    'companyname': 'name',
    'company name': 'name',
    'mc#': 'mcNumber',
    'mc num': 'mcNumber',
    'mc number': 'mcNumber',
    'dot#': 'dotNumber',
    'dot num': 'dotNumber',
    'dot number': 'dotNumber',
  },
  CARRIER_FACTOR: {
    company: 'name',
    'companyname': 'name',
    'company name': 'name',
  },
  CHARGE_CODE: {
    'charge code': 'code',
    'chargecode': 'code',
    'calc by': 'calculatedBy',
    'calculated by': 'calculatedBy',
    amount: 'defaultAmountCents',
    'default amount': 'defaultAmountCents',
  },
  PAYMENT_TERM: {
    'term name': 'name',
    'quick pay fee': 'quickPayFeeBps',
    'quickpay fee': 'quickPayFeeBps',
    'ap only': 'apOnly',
    'do not use': 'doNotUse',
  },
  VENDOR_CONTACT: {
    'contact name': 'name',
    'vendor name': 'name',
    'vendor type': 'vendorType',
  },
}

/**
 * Suggest a mapping from sheet headers to entity field names. Matches exact,
 * case/space-insensitive, then the small alias table.
 */
export function suggestMapping(headers: string[], entity: ImportEntity): Record<string, string> {
  const def = ENTITY_DEFS[entity]
  if (!def) throw new Error(`"${entity}" is not an importable entity.`)
  const fieldNames = def.fields.map((f) => f.name)
  const normalizedFields: Record<string, string> = {}
  for (const name of fieldNames) normalizedFields[normalizeKey(name)] = name

  const mapping: Record<string, string> = {}
  const aliases = aliasTable[entity] ?? {}

  for (const header of headers) {
    const raw = header.trim()
    if (!raw) continue
    const key = normalizeKey(raw)
    // exact by normalized header
    if (normalizedFields[key]) {
      mapping[raw] = normalizedFields[key]
      continue
    }
    // alias table (case-insensitive, space-insensitive)
    const aliasKey = Object.keys(aliases).find((k) => normalizeKey(k) === key)
    if (aliasKey) {
      mapping[raw] = aliases[aliasKey]
      continue
    }
  }
  return mapping
}

function integerValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) && Number.isInteger(value) ? value : null
  const parsed = Number(String(value).replace(/[$,\s]/g, ''))
  return Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : null
}

function moneyCents(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return Number.isInteger(value) ? value : Math.round(value * 100)
  }
  const text = String(value).replace(/[$,\s]/g, '')
  if (/^\d+\.\d{1,2}$/.test(text)) {
    const [whole, fraction = ''] = text.split('.')
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  }
  if (/^\d+$/.test(text)) return Number(text) * 100
  return null
}

const ENTITY_DEFS: Record<ImportEntity, ImportEntityDef> = {
  CUSTOMER: {
    entity: 'CUSTOMER',
    label: 'Customer',
    fields: [
      { name: 'name', required: true, max: 200 },
      { name: 'mcNumber', required: false, max: 50 },
      { name: 'dotNumber', required: false, max: 50 },
      { name: 'phone', required: false, max: 32 },
      { name: 'billingEmail', required: false, max: 200, kind: 'email' },
      { name: 'billingContactName', required: false, max: 120 },
    ],
    naturalKey: (row) => normalizeName(String(row.name ?? '')) || null,
  },
  LOCATION: {
    entity: 'LOCATION',
    label: 'Location',
    fields: [
      { name: 'name', required: true, max: 200 },
      { name: 'street', required: false, max: 200 },
      { name: 'city', required: false, max: 100 },
      { name: 'state', required: false, max: 50 },
      { name: 'zip', required: false, max: 20 },
      { name: 'country', required: false, max: 50 },
    ],
    naturalKey: (row) => normalizeName(String(row.name ?? '')) || null,
  },
  CARRIER: {
    entity: 'CARRIER',
    label: 'Carrier',
    fields: [
      { name: 'name', required: true, max: 200 },
      { name: 'mcNumber', required: false, max: 50 },
      { name: 'dotNumber', required: false, max: 50 },
      { name: 'scac', required: false, max: 20 },
      { name: 'phone', required: false, max: 32 },
    ],
    naturalKey: (row) => {
      const mc = String(row.mcNumber ?? '').trim()
      if (mc) return `mc:${mc.toLowerCase()}`
      const name = normalizeName(String(row.name ?? ''))
      return name || null
    },
  },
  CARRIER_FACTOR: {
    entity: 'CARRIER_FACTOR',
    label: 'Carrier factor',
    fields: [
      { name: 'name', required: true, max: 200 },
      { name: 'phone', required: false, max: 32 },
      { name: 'email', required: false, max: 200, kind: 'email' },
    ],
    naturalKey: (row) => normalizeName(String(row.name ?? '')) || null,
  },
  CHARGE_CODE: {
    entity: 'CHARGE_CODE',
    label: 'Charge code',
    fields: [
      { name: 'code', required: true, max: 50 },
      { name: 'label', required: true, max: 120 },
      { name: 'category', required: false, max: 100 },
      { name: 'calculatedBy', required: false, max: 50 },
      { name: 'defaultAmountCents', required: false, kind: 'money' },
    ],
    naturalKey: (row) => String(row.code ?? '').trim().toUpperCase() || null,
  },
  PAYMENT_TERM: {
    entity: 'PAYMENT_TERM',
    label: 'Payment term',
    fields: [
      { name: 'key', required: true, max: 40 },
      { name: 'name', required: true, max: 120 },
      { name: 'days', required: true, kind: 'integer' },
      { name: 'description', required: false, max: 500 },
      { name: 'quickPayFeeBps', required: false, kind: 'integer' },
      { name: 'apOnly', required: false },
      { name: 'doNotUse', required: false },
    ],
    naturalKey: (row) => String(row.key ?? '').trim().toLowerCase() || null,
  },
  VENDOR_CONTACT: {
    entity: 'VENDOR_CONTACT',
    label: 'Vendor contact',
    fields: [
      { name: 'name', required: true, max: 120 },
      { name: 'email', required: true, max: 200, kind: 'email' },
      { name: 'phone', required: false, max: 32 },
      { name: 'vendorType', required: false, max: 50 },
    ],
    naturalKey: (row) => String(row.email ?? '').trim().toLowerCase() || null,
  },
}

/** Validate the import job metadata, not the rows. */
export function validateImportJob(input: unknown): ImportJobInput {
  const row = asRecord(input)
  if (!row) throw new Error('Import job input must be an object.')

  const entity = typeof row.entity === 'string' ? row.entity.trim().toUpperCase() : ''
  if (!IMPORT_ENTITIES.includes(entity as ImportEntity)) {
    throw new Error(`"${entity}" is not an importable entity. Only directory entities may be imported.`)
  }

  const fileName = text(row.fileName, MAX_FILE_NAME)
  if (!fileName) throw new Error('File name is required.')

  const fileHash = text(row.fileHash, MAX_FILE_HASH)
  if (!fileHash) throw new Error('File hash is required.')

  const mappingRaw = asRecord(row.mapping)
  if (!mappingRaw) throw new Error('Mapping must be an object.')
  if (Object.keys(mappingRaw).length === 0) throw new Error('Mapping cannot be empty.')

  const mapping: Record<string, string> = {}
  for (const [header, target] of Object.entries(mappingRaw)) {
    if (typeof target !== 'string' || !target.trim()) {
      throw new Error(`Mapping for "${header}" must name a field.`)
    }
    mapping[header] = target.trim()
  }

  const def = ENTITY_DEFS[entity as ImportEntity]
  for (const field of def.fields) {
    if (!field.required) continue
    const mapped = Object.entries(mapping).some(([, target]) => target === field.name)
    if (!mapped) throw new Error(`Required column "${field.name}" is not mapped.`)
  }

  const note = row.note === null || row.note === undefined ? null : text(row.note, MAX_NOTE)

  return {
    entity: entity as ImportEntity,
    fileName,
    fileHash,
    mapping,
    rowCount: typeof row.rowCount === 'number' && Number.isInteger(row.rowCount) ? row.rowCount : null,
    dryRun: typeof row.dryRun === 'boolean' ? row.dryRun : null,
    note,
    createdBy: text(row.createdBy, 200) || 'unknown',
  }
}

/**
 * Validate sheet rows against the entity's field catalog using the supplied mapping.
 * Returns the rows translated to field names and any per-cell errors.
 */
export function validateRows(
  rows: Record<string, unknown>[],
  mapping: Record<string, string>,
  entity: ImportEntity,
): { ok: ImportRowResult[]; errors: ImportRowError[] } {
  if (!IMPORT_ENTITIES.includes(entity)) {
    throw new Error(`"${entity}" is not an importable entity. Only directory entities may be imported.`)
  }
  const def = ENTITY_DEFS[entity]
  const ok: ImportRowResult[] = []
  const errors: ImportRowError[] = []

  for (let i = 0; i < rows.length; i++) {
    const line = i + 1
    const rawRow = rows[i]
    const fields: Record<string, unknown> = {}

    // Apply mapping.
    for (const [header, fieldName] of Object.entries(mapping)) {
      fields[fieldName] = rawRow[header]
    }

    let rowValid = true
    for (const field of def.fields) {
      const raw = fields[field.name]
      if (field.required) {
        const value = typeof raw === 'string' ? raw.trim() : raw
        if (value === null || value === undefined || value === '') {
          errors.push({ line, column: field.name, message: `${field.name} is required.` })
          rowValid = false
          continue
        }
      }
      if (raw == null || raw === '') continue

      if (field.kind === 'email') {
        const value = String(raw).trim()
        if (value && !EMAIL_RE.test(value)) {
          errors.push({ line, column: field.name, message: `"${value}" is not an e-mail address.` })
          rowValid = false
        }
        fields[field.name] = value || null
      } else if (field.kind === 'integer') {
        const value = integerValue(raw)
        if (raw !== '' && raw != null && value === null) {
          errors.push({ line, column: field.name, message: `${field.name} must be a whole number.` })
          rowValid = false
        } else {
          fields[field.name] = value
        }
      } else if (field.kind === 'money') {
        const value = moneyCents(raw)
        if (raw !== '' && raw != null && value === null) {
          errors.push({ line, column: field.name, message: `${field.name} must be a money amount.` })
          rowValid = false
        } else {
          fields[field.name] = value
        }
      } else {
        const value = String(raw).trim()
        if (field.max && value.length > field.max) {
          errors.push({ line, column: field.name, message: `${field.name} is too long.` })
          rowValid = false
        }
        fields[field.name] = value || null
      }
    }

    if (rowValid) ok.push({ line, fields })
  }

  return { ok, errors }
}

function recordKey(record: Record<string, unknown>, entity: ImportEntity): string | null {
  return ENTITY_DEFS[entity].naturalKey(record)
}

/**
 * Plan what would happen if the validated rows were applied against the existing
 * directory. Matches on the entity's natural key; rows whose key already exist are
 * updates, new keys are creates, and identical rows are skips.
 */
export function planImport(
  ok: ImportRowResult[],
  existingByKey: Record<string, Record<string, unknown>>,
  entity: ImportEntity,
): ImportPlan {
  if (!IMPORT_ENTITIES.includes(entity)) {
    throw new Error(`"${entity}" is not an importable entity. Only directory entities may be imported.`)
  }
  const plan: ImportPlan = { create: [], update: [], skip: [] }
  const seenKeys: Record<string, true> = {}

  for (const row of ok) {
    const key = recordKey(row.fields, entity)
    if (!key) continue
    if (seenKeys[key]) {
      plan.skip.push(row.fields)
      continue
    }
    seenKeys[key] = true

    const existing = existingByKey[key]
    if (!existing) {
      plan.create.push(row.fields)
      continue
    }

    // Active merged records are skipped; treat them as existing but do not update.
    if (isActiveDirectoryRecord(existing as { active?: boolean | null; mergedIntoId?: string | null; mergeJobId?: string | null })) {
      const changes: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row.fields)) {
        if (v !== (existing[k] ?? null)) changes[k] = v
      }
      if (Object.keys(changes).length === 0) {
        plan.skip.push(row.fields)
      } else {
        plan.update.push({ existing, changes })
      }
    } else {
      plan.skip.push(row.fields)
    }
  }

  return plan
}
