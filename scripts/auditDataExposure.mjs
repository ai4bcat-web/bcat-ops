#!/usr/bin/env node
/**
 * READ-ONLY audit of decision D1 (Step AI): which AppSync models can ANY signed-in user read directly, whatever the dashboards
 * feature filters. Signs in as a temporary identity with NO group at all (`zz-ai-audit-<ts>`), lists every model the GraphQL
 * schema exposes (introspection: `list<Model>` fields without a sort key) and reads each one page by page selecting only
 * `__typename`, so the output is AGGREGATES ONLY: readable yes/no and a row count. No value of any row is read into the report,
 * printed or stored (the coverage section selects the three owner/team/rep columns only to count empty ones).
 *
 *   node scripts/auditDataExposure.mjs [--inventory] [--write] [--only=<Model,Model>] [--pages=<n>]
 *
 *   --inventory  no network: prove the schema parser and the markdown renderer on the repo (does amplify/data/resource.ts parse,
 *                how many models declare an authenticated read) and exit.
 *   --write      write Docs/tms-build/AI-exposure-audit.md (default: print the table only).
 *   --only=      audit just these models. --pages=  page cap per model (default 25 pages of 1,000 rows; a capped count prints "≥ N").
 *
 * Dev only: refuses any AppSync endpoint but the dev one and any pool but the dev pool. It never calls a mutation and never writes
 * a table; the only write is the temporary Cognito user, which is deleted (and proven gone) in `finally`. Passwords and tokens are
 * never printed. Counts are DEV counts; the exposure (which models are readable) is a property of the schema and is the same on
 * `main` — re-run against production only by an operator who owns that decision.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql } from './lib/devIdentity.mjs'

const DEV_APPSYNC = /^https:\/\/f5iqzdpidzalvjys7yxijn5ave\.appsync-api\.us-east-1\.amazonaws\.com\/graphql$/
const OUT = resolve('Docs/tms-build/AI-exposure-audit.md')
const PAGE_SIZE = 1000
export const DEFAULT_PAGES = 25
const CONCURRENCY = 6

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

// ───────────────────────────── pure helpers (unit-tested) ─────────────────────────────

/**
 * The authorization each model declares in amplify/data/resource.ts, read as text:
 * { Model: { authenticatedRead: boolean, authenticatedWrite: boolean, groups: string[], operations: string[] } }.
 * Only top-level `Name: a\n    .model({` blocks count (the file indents models by two spaces).
 */
export function parseSchemaAuth(source) {
  const out = {}
  const starts = [...source.matchAll(/^ {2}([A-Z][A-Za-z0-9]*):\s*a\s*\n\s*\.model\(/gm)]
  for (let i = 0; i < starts.length; i++) {
    const body = source.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : source.length)
    const auth = /\.authorization\(\s*\(allow\)\s*=>\s*\[([\s\S]*?)\]\)\s*,?\s*(?:\n|$)/.exec(body)?.[1] ?? ''
    const auths = auth.split(/\n/).join(' ')
    const authRule = /allow\.authenticated\(\)((?:\.to\(\[[^\]]*\]\))?)/.exec(auths)
    const toList = (s) => [...s.matchAll(/'([a-z]+)'/g)].map((m) => m[1])
    const authenticated = authRule ? (authRule[1] ? toList(authRule[1]) : ['create', 'read', 'update', 'delete']) : []
    out[starts[i][1]] = {
      authenticatedRead: authenticated.includes('read'),
      authenticatedWrite: authenticated.some((o) => o !== 'read'),
      groups: [...auths.matchAll(/allow\.groups?\(\[([^\]]*)\]\)/g)].flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])),
      operations: [...(/\.disableOperations\(\[([^\]]*)\]\)/.exec(body)?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]),
    }
  }
  return out
}

/** "1,234" or "≥ 25,000" (a capped count) or "?" */
export function countText(count, capped) {
  if (count == null) return '?'
  const n = count.toLocaleString('en-US')
  return capped ? `≥ ${n}` : n
}

/** Is a GraphQL error text an authorization refusal (as opposed to an operational error)? */
export const isDenied = (message) => /not authorized|unauthorized|access denied|forbidden/i.test(String(message))

/** Markdown for the audit: rows = [{ model, readable: 'yes'|'no'|'error', count, capped, auth }]. */
export function renderMarkdown({ rows, generatedAt, pages, coverage, schemaOnly }) {
  const readable = rows.filter((r) => r.readable === 'yes')
  const denied = rows.filter((r) => r.readable === 'no')
  const errored = rows.filter((r) => r.readable === 'error')
  const declared = rows.filter((r) => r.readable === 'declared')
  const total = readable.reduce((a, r) => a + (r.count ?? 0), 0)
  const lines = []
  lines.push('# Step AI — data exposure audit (decision D1)')
  lines.push('')
  lines.push(`Generated ${generatedAt} by \`node scripts/auditDataExposure.mjs --write\` against the **dev** stack. Read-only: it signs in as a temporary identity that belongs to **no group** and lists each model, selecting only \`__typename\` — so this file holds readable yes/no and row counts, never a value. Counts are dev counts (capped at ${pages} pages of ${PAGE_SIZE} rows per model, a capped count prints "≥"); which models are readable is a property of the schema and is the same on \`main\`.`)
  lines.push('')
  lines.push('## What it means')
  lines.push('')
  lines.push(`**${readable.length} of ${rows.length} models are readable by any signed-in user straight from AppSync**${declared.length ? ` (plus ${declared.length} that the schema declares readable but have no list query to probe)` : ''} (${readable.length ? `${total.toLocaleString('en-US')}+ rows in total on dev` : 'no rows'}). The dashboards feature filters what **its own** dashboards show to the viewer's customers (server-side, in the Lambda), but it cannot stop a hand-written GraphQL query such as \`listShipments\` / \`listInvoices\` / \`listLaneRateSamples\` / \`listCustomers\`: those return every row to any logged-in person, whatever their role or claims. "Showing only the customers you own or your team covers" is therefore a view rule, **not** an access boundary, until the model-level reads below are closed (decision D1, a separate costed step: replace \`allow.authenticated().to(['read'])\` with group rules and route every list through a Lambda).`)
  lines.push('')
  if (schemaOnly) {
    lines.push('> Schema-only run (`--inventory`): the readable column below is what `amplify/data/resource.ts` **declares**, not a live probe.')
    lines.push('')
  }
  lines.push('## Per model')
  lines.push('')
  lines.push('| Model | Readable by a user with no group | Rows (dev, count only) | Schema says |')
  lines.push('|---|---|---|---|')
  for (const r of [...rows].sort((a, b) => (b.count ?? -1) - (a.count ?? -1) || a.model.localeCompare(b.model))) {
    const readableText = r.readable === 'yes' ? '**yes**' : r.readable === 'no' ? 'no' : r.readable === 'declared' ? 'declared readable, not probed (no list query found in the schema)' : `unknown (${r.note ?? 'error'})`
    lines.push(`| ${r.model} | ${readableText} | ${r.readable === 'yes' ? countText(r.count, r.capped) : '—'} | ${r.auth ?? '—'} |`)
  }
  lines.push('')
  lines.push(`Readable (probed): ${readable.length} · refused: ${denied.length} · could not tell: ${errored.length} · declared readable but not probed: ${declared.length}.`)
  if (coverage) {
    lines.push('')
    lines.push('## Visibility coverage (what a rep would actually see through dashboards; counts and percentages only)')
    lines.push('')
    lines.push('| Measure | Value |')
    lines.push('|---|---|')
    for (const [k, v] of coverage) lines.push(`| ${k} | ${v} |`)
  }
  lines.push('')
  return lines.join('\n')
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)} % (${n.toLocaleString('en-US')} of ${d.toLocaleString('en-US')})` : 'n/a (no rows)')

// ───────────────────────────── probing ─────────────────────────────
/** A model's own list has only these arguments (models with a custom `id` add `id` + `sortDirection`); a key-index list adds its key. */
const BASE_LIST_ARGS = new Set(['id', 'filter', 'limit', 'nextToken', 'sortDirection'])

async function listModels(token) {
  const data = await gql(token, '{ __schema { queryType { fields { name args { name } type { name } } } } }')
  return data.__schema.queryType.fields
    .filter((f) => /^list[A-Z]/.test(f.name) && /^Model.+Connection$/.test(f.type?.name ?? '') && f.args.every((a) => BASE_LIST_ARGS.has(a.name)) && f.args.some((a) => a.name === 'limit'))
    .map((f) => ({ field: f.name, model: /^Model(.+)Connection$/.exec(f.type.name)[1] }))
}

/** Reads pages selecting `selection` per item; returns { readable, count, capped, note, pages: items[] when keep } */
async function probe(token, field, { model, pages, selection = '__typename', keep = false, filter = null }) {
  let next = null
  let count = 0
  const kept = []
  for (let i = 0; i < pages; i++) {
    let r
    try {
      r = (await gql(token, `query($n: String${filter ? `, $f: Model${model}FilterInput` : ''}) { ${field}(limit: ${PAGE_SIZE}, nextToken: $n${filter ? ', filter: $f' : ''}) { items { ${selection} } nextToken } }`, { n: next, f: filter }))[field]
    } catch (err) {
      const message = String(err?.message ?? err)
      if (isDenied(message)) return { readable: 'no', count: 0, capped: false }
      return { readable: 'error', count: count || null, capped: false, note: message.replace(/\s+/g, ' ').slice(0, 60) }
    }
    // A field the caller may not read can come back as null (partial data) instead of an error.
    if (!r) return { readable: 'no', count: 0, capped: false }
    count += r.items.length
    if (keep) kept.push(...r.items)
    next = r.nextToken
    if (!next) return { readable: 'yes', count, capped: false, kept }
  }
  return { readable: 'yes', count, capped: true, kept }
}

async function pool(items, size, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k) }
  }))
  return out
}

async function coverageReport(token, pages) {
  const rows = []
  const customers = await probe(token, 'listCustomers', { model: 'Customer', pages, selection: 'accountOwnerIds defaultSalesRepId teamKey', keep: true })
  if (customers.readable === 'yes') {
    const n = customers.kept.length
    const unowned = customers.kept.filter((c) => !(c.accountOwnerIds ?? []).some(Boolean) && !c.defaultSalesRepId && !c.teamKey).length
    rows.push(['Customers with no owner, no default rep and no team (invisible to every non-viewAll user)', pct(unowned, n)])
    rows.push(['Customers with a team', pct(customers.kept.filter((c) => c.teamKey).length, n)])
  }
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
  const ships = await probe(token, 'listShipments', { model: 'Shipment', pages, selection: 'salesRepId customerId', keep: true, filter: { pickupAppt: { ge: since } } })
  if (ships.readable === 'yes') {
    const n = ships.kept.length
    rows.push([`Shipments picked up in the last 90 days with no salesRepId${ships.capped ? ' (first pages only)' : ''}`, pct(ships.kept.filter((s) => !s.salesRepId).length, n)])
    rows.push(['Those shipments with no customerId (visible only through a direct rep field)', pct(ships.kept.filter((s) => !s.customerId).length, n)])
  }
  return rows
}

async function main() {
  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('auditDataExposure refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== 'us-east-1_UKhMNVAG1') throw new Error('auditDataExposure refuses any pool other than the dev pool')
  const auth = parseSchemaAuth(await readFile(join(process.cwd(), 'amplify/data/resource.ts'), 'utf8'))
  const declared = Object.keys(auth)
  const authText = (m) => {
    const a = auth[m]
    if (!a) return '—'
    const parts = []
    if (a.authenticatedRead) parts.push(a.authenticatedWrite ? 'authenticated: read+write' : 'authenticated: read')
    else if (a.authenticatedWrite) parts.push('authenticated: write only')
    if (a.groups.length) parts.push(`groups: ${a.groups.join(', ')}`)
    if (a.operations.length) parts.push(`disabled: ${a.operations.join('/')}`)
    return parts.join('; ') || 'no authenticated rule'
  }
  if (flag('inventory')) {
    const readable = declared.filter((m) => auth[m].authenticatedRead)
    console.log(`PASS   schema parsed — ${declared.length} models, ${readable.length} declare an authenticated read (${declared.length - readable.length} do not)`)
    const rows = declared.map((model) => ({ model, readable: auth[model].authenticatedRead ? 'yes' : 'no', count: null, auth: authText(model) }))
    const md = renderMarkdown({ rows, generatedAt: new Date().toISOString(), pages: DEFAULT_PAGES, schemaOnly: true })
    console.log(`PASS   markdown rendered — ${md.split('\n').length} lines`)
    return
  }

  const pages = Number(opt('pages') ?? DEFAULT_PAGES)
  const onlyModels = opt('only')?.split(',').map((s) => s.trim()).filter(Boolean)
  const email = `zz-ai-audit-${Date.now()}@example.invalid`
  try {
    const ident = await mintIdentity(email, [])
    console.log('identity: temporary audit identity created (no groups)')
    const models = (await listModels(ident.token)).filter((m) => !onlyModels || onlyModels.includes(m.model))
    console.log(`schema: ${models.length} listable models`)
    const rows = await pool(models, CONCURRENCY, async (m) => {
      const r = await probe(ident.token, m.field, { model: m.model, pages })
      console.log(`  ${m.model.padEnd(34)} ${r.readable.padEnd(6)} ${r.readable === 'yes' ? countText(r.count, r.capped) : ''}`)
      return { model: m.model, readable: r.readable, count: r.count, capped: r.capped, note: r.note, auth: authText(m.model) }
    })
    const listed = new Set(models.map((m) => m.model))
    if (!onlyModels) {
      for (const m of declared.filter((x) => !listed.has(x) && auth[x].authenticatedRead && !auth[x].operations.includes('queries'))) {
        rows.push({ model: m, readable: 'declared', count: null, auth: authText(m) })
      }
    }
    const coverage = onlyModels ? null : await coverageReport(ident.token, pages)
    const md = renderMarkdown({ rows, generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), pages, coverage })
    if (flag('write')) {
      await mkdir(dirname(OUT), { recursive: true })
      await writeFile(OUT, md)
      console.log(`wrote ${OUT.replace(`${process.cwd()}/`, '')}`)
    } else console.log(`\n${md}`)
    const readable = rows.filter((r) => r.readable === 'yes').length
    console.log(`summary: ${JSON.stringify({ models: rows.length, readable, refused: rows.filter((r) => r.readable === 'no').length, unknown: rows.filter((r) => r.readable === 'error').length })}`)
  } finally {
    const gone = await deleteIdentity(email)
    console.log(`cleanup: temporary audit identity ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
    if (!gone) process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`auditDataExposure failed: ${err?.message ?? err}`); process.exit(1) })
}
