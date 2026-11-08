/**
 * Pure comparison logic for the staged schema deploy (scripts/stageDeployCheck.mjs).
 *
 * A "template set" is Map<fileName, Resources> for every *.template.json of one synth: the root
 * stack and every nested stack. File names are derived from construct paths, so they are stable
 * between two synths of the same app.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse } from 'graphql'

export function readTemplates(outdir) {
  const sets = new Map()
  for (const name of readdirSync(outdir)) {
    if (!name.endsWith('.template.json')) continue
    sets.set(name, JSON.parse(readFileSync(join(outdir, name), 'utf8')).Resources ?? {})
  }
  return sets
}

/** The data stack's model-schema.graphql (the SDL Amplify hands to the transformer). */
export function readModelSchema(outdir) {
  for (const entry of readdirSync(outdir)) {
    if (!entry.startsWith('asset.')) continue
    try {
      return readFileSync(join(outdir, entry, 'model-schema.graphql'), 'utf8')
    } catch {
      /* not a directory asset */
    }
  }
  throw new Error(`no model-schema.graphql under ${outdir}`)
}

/** Stable JSON: key order must not read as a change. */
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Resources CloudFormation would create, update and delete going from `prev` to `next`.
 * A resource in a new template is created; in a vanished template, deleted; otherwise it is
 * matched by logical id and compared property for property.
 */
export function diffTemplates(prev, next) {
  const out = { created: 0, updated: 0, deleted: 0, byType: {}, changed: [] }
  const note = (kind, file, id, type) => {
    out[kind] += 1
    const key = `${kind} ${type}`
    out.byType[key] = (out.byType[key] ?? 0) + 1
    out.changed.push({ kind, file, id, type })
  }
  for (const [file, resources] of next) {
    const before = prev.get(file) ?? {}
    for (const [id, res] of Object.entries(resources)) {
      if (!(id in before)) note('created', file, id, res.Type)
      else if (canon(before[id]) !== canon(res)) note('updated', file, id, res.Type)
    }
  }
  for (const [file, resources] of prev) {
    const after = next.get(file) ?? {}
    for (const [id, res] of Object.entries(resources)) if (!(id in after)) note('deleted', file, id, res.Type)
  }
  out.total = out.created + out.updated + out.deleted
  return out
}

/** Amplify creates each model's table through a custom resource; plain tables are accepted too. */
export const TABLE_TYPES = new Set(['Custom::AmplifyDynamoDBTable', 'AWS::DynamoDB::Table'])

/** Index names of one table resource (the custom resource uses lower-case property names). */
export function indexNames(res) {
  const list = res.Properties?.GlobalSecondaryIndexes ?? res.Properties?.globalSecondaryIndexes ?? []
  return list.map((g) => g.IndexName ?? g.indexName)
}

/** Global secondary index names per DynamoDB table resource: Map<"file#logicalId", Set<indexName>>. */
export function tableIndexes(templates) {
  const out = new Map()
  for (const [file, resources] of templates) {
    for (const [id, res] of Object.entries(resources)) {
      if (!TABLE_TYPES.has(res.Type)) continue
      out.set(`${file}#${id}`, new Set(indexNames(res)))
    }
  }
  return out
}

/** Tables (existing in `prev`) that gain more than `max` indexes going to `next`. */
export function gsiAdditions(prev, next) {
  const before = tableIndexes(prev)
  const out = []
  for (const [key, names] of tableIndexes(next)) {
    const old = before.get(key)
    if (!old) continue
    const added = [...names].filter((n) => !old.has(n))
    if (added.length > 0) out.push({ table: key, added })
  }
  return out
}

/** SDL -> { models: Map<name, Map<field, signature>>, enums: Map<name, Set<value>> }. */
export function parseSchema(sdl) {
  const models = new Map()
  const enums = new Map()
  const doc = parse(sdl)
  const text = (node) => sdl.slice(node.loc.start, node.loc.end)
  for (const def of doc.definitions) {
    if (def.kind === 'ObjectTypeDefinition') {
      const isModel = def.directives?.some((d) => d.name.value === 'model')
      if (!isModel) continue
      const fields = new Map()
      for (const f of def.fields ?? []) {
        // type plus @index directives. @auth is allowed to change between stages (allow.resource grants).
        const idx = (f.directives ?? []).filter((d) => d.name.value === 'index').map(text).sort()
        fields.set(f.name.value, `${text(f.type)} ${idx.join(' ')}`.trim())
      }
      const typeIdx = (def.directives ?? []).filter((d) => d.name.value === 'index').map(text).sort()
      if (typeIdx.length > 0) fields.set('@@type-indexes', typeIdx.join(' '))
      models.set(def.name.value, fields)
    } else if (def.kind === 'EnumTypeDefinition') {
      enums.set(def.name.value, new Set((def.values ?? []).map((v) => v.name.value)))
    }
  }
  return { models, enums }
}

/** Everything in `prev` that is missing or different in `next`: [] when next is a strict superset. */
export function supersetViolations(prev, next, label = '') {
  const bad = []
  for (const [model, fields] of prev.models) {
    const now = next.models.get(model)
    if (!now) {
      bad.push(`${label}model ${model} removed`)
      continue
    }
    for (const [field, sig] of fields) {
      if (!now.has(field)) bad.push(`${label}${model}.${field} removed`)
      else if (now.get(field) !== sig) bad.push(`${label}${model}.${field} changed: ${sig} -> ${now.get(field)}`)
    }
  }
  for (const [name, values] of prev.enums) {
    const now = next.enums.get(name)
    if (!now) bad.push(`${label}enum ${name} removed`)
    else for (const v of values) if (!now.has(v)) bad.push(`${label}enum ${name}.${v} removed`)
  }
  return bad
}

/** Models and fields `next` has that `prev` lacks, for the report. */
export function schemaAdditions(prev, next) {
  const models = [...next.models.keys()].filter((m) => !prev.models.has(m))
  let fields = 0
  const perModel = {}
  for (const [m, f] of next.models) {
    const old = prev.models.get(m)
    if (!old) continue
    const n = [...f.keys()].filter((k) => !old.has(k)).length
    if (n > 0) {
      perModel[m] = n
      fields += n
    }
  }
  return { models, fields, perModel }
}

/** True when `sentinel` appears in any template (a staged-out table leaked into a template). */
export function sentinelLeaks(outdir, sentinel) {
  return readdirSync(outdir)
    .filter((n) => n.endsWith('.template.json'))
    .filter((n) => readFileSync(join(outdir, n), 'utf8').includes(sentinel))
}
