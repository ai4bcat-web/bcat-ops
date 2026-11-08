/**
 * In-memory stand-in for the lib-dynamodb DocumentClient, covering exactly the command
 * and expression shapes `crmStore.ts` and `tms-crm-actions` use. Test support only.
 */
import type { Db, Row } from './crmStore'

type Names = Record<string, string>
type Values = Record<string, unknown>

const SORT_KEY: Record<string, string> = {
  crmActivitiesByCustomerIdAndAt: 'at',
  crmActivitiesByOwnerIdAndAt: 'at',
  crmActivitiesByAssigneeIdAndDueAt: 'dueAt',
  quotesByCustomerIdAndQuoteDate: 'quoteDate',
  shipmentsByCustomerIdAndPickupAppt: 'pickupAppt',
}

function conditionalFailure(): Error {
  return Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' })
}

function resolve(token: string, names: Names): string {
  return token.startsWith('#') ? (names[token] ?? token) : token
}

function operand(token: string, item: Row, names: Names, values: Values): unknown {
  const t = token.trim()
  if (t.startsWith(':')) return values[t]
  return item[resolve(t, names)]
}

function evalTerm(term: string, item: Row, names: Names, values: Values): boolean {
  const t = term.trim()
  let m = t.match(/^attribute_not_exists\(([^)]+)\)$/)
  if (m) return item[resolve(m[1].trim(), names)] === undefined
  m = t.match(/^attribute_exists\(([^)]+)\)$/)
  if (m) return item[resolve(m[1].trim(), names)] !== undefined
  m = t.match(/^(\S+)\s*(<=|>=|=|<|>)\s*(\S+)$/)
  if (!m) throw new Error(`crmFakeDb: unsupported condition term "${t}"`)
  const left = operand(m[1], item, names, values)
  const right = operand(m[3], item, names, values)
  if (left === undefined || left === null) return false
  switch (m[2]) {
    case '=': return left === right
    case '<=': return (left as string | number) <= (right as string | number)
    case '>=': return (left as string | number) >= (right as string | number)
    case '<': return (left as string | number) < (right as string | number)
    default: return (left as string | number) > (right as string | number)
  }
}

function evalCondition(expr: string | undefined, item: Row, names: Names = {}, values: Values = {}): boolean {
  if (!expr) return true
  return expr.split(/\s+OR\s+/).some((orPart) => orPart.split(/\s+AND\s+/).every((t) => evalTerm(t, item, names, values)))
}

function splitTop(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) parts.push(cur)
  return parts
}

function evalValue(expr: string, item: Row, names: Names, values: Values): unknown {
  const plus = expr.split(/\s\+\s/)
  if (plus.length > 1) return plus.map((p) => Number(evalValue(p, item, names, values))).reduce((a, b) => a + b, 0)
  const m = expr.trim().match(/^if_not_exists\(([^,]+),\s*([^)]+)\)$/)
  if (m) {
    const current = item[resolve(m[1].trim(), names)]
    return current !== undefined ? current : values[m[2].trim()]
  }
  return operand(expr, item, names, values)
}

function applyUpdate(item: Row, expr: string, names: Names = {}, values: Values = {}): Row {
  const out: Row = { ...item }
  const sections = expr.split(/\b(SET|REMOVE|ADD)\b/).map((s) => s.trim())
  for (let i = 1; i < sections.length; i += 2) {
    const verb = sections[i]
    const body = sections[i + 1] ?? ''
    for (const part of splitTop(body)) {
      if (verb === 'SET') {
        const [lhs, ...rest] = part.split('=')
        out[resolve(lhs.trim(), names)] = evalValue(rest.join('='), item, names, values)
      } else if (verb === 'REMOVE') {
        delete out[resolve(part.trim(), names)]
      } else {
        const [attr, val] = part.trim().split(/\s+/)
        const key = resolve(attr, names)
        out[key] = Number(out[key] ?? 0) + Number(values[val])
      }
    }
  }
  return out
}

export class CrmFakeDb implements Db {
  /** table name → id → row */
  readonly tables = new Map<string, Map<string, Row>>()
  readonly log: { op: string; table: string }[] = []

  private table(name: string): Map<string, Row> {
    let t = this.tables.get(name)
    if (!t) {
      t = new Map()
      this.tables.set(name, t)
    }
    return t
  }

  seed(table: string, row: Row): void {
    this.table(table).set(String(row.id), structuredClone(row))
  }

  rows(table: string): Row[] {
    return [...this.table(table).values()].map((r) => structuredClone(r))
  }

  get(table: string, id: string): Row | undefined {
    const r = this.table(table).get(id)
    return r ? structuredClone(r) : undefined
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(command: any): Promise<any> {
    const input = command.input as Row & {
      TableName: string
      Key?: { id: string }
      Item?: Row
      ConditionExpression?: string
      FilterExpression?: string
      UpdateExpression?: string
      KeyConditionExpression?: string
      IndexName?: string
      ScanIndexForward?: boolean
      Limit?: number
      ExpressionAttributeNames?: Names
      ExpressionAttributeValues?: Values
      ReturnValues?: string
      ProjectionExpression?: string
    }
    const op = command.constructor.name as string
    this.log.push({ op, table: input.TableName })
    const t = this.table(input.TableName)
    const names = input.ExpressionAttributeNames
    const values = input.ExpressionAttributeValues
    switch (op) {
      case 'GetCommand': {
        const r = t.get(input.Key!.id)
        return { Item: r ? structuredClone(r) : undefined }
      }
      case 'PutCommand': {
        const id = String(input.Item!.id)
        if (!evalCondition(input.ConditionExpression, t.get(id) ?? {}, names, values)) throw conditionalFailure()
        t.set(id, structuredClone(input.Item!))
        return {}
      }
      case 'DeleteCommand':
        t.delete(input.Key!.id)
        return {}
      case 'UpdateCommand': {
        const current = t.get(input.Key!.id)
        if (!evalCondition(input.ConditionExpression, current ?? {}, names, values)) throw conditionalFailure()
        const next = applyUpdate(current ?? { id: input.Key!.id }, input.UpdateExpression!, names, values)
        t.set(input.Key!.id, next)
        return { Attributes: input.ReturnValues === 'ALL_NEW' ? structuredClone(next) : undefined }
      }
      case 'QueryCommand': {
        let items = [...t.values()].filter((r) => evalCondition(input.KeyConditionExpression, r, names, values))
        const sortKey = input.IndexName ? SORT_KEY[input.IndexName] : undefined
        if (sortKey) {
          items.sort((a, b) => String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? '')))
          if (input.ScanIndexForward === false) items.reverse()
        }
        items = items.filter((r) => evalCondition(input.FilterExpression, r, names, values))
        if (input.Limit) items = items.slice(0, input.Limit)
        return { Items: items.map((r) => structuredClone(r)) }
      }
      case 'ScanCommand': {
        const items = [...t.values()].filter((r) => evalCondition(input.FilterExpression, r, names, values))
        return { Items: items.map((r) => structuredClone(r)) }
      }
      default:
        throw new Error(`crmFakeDb: unsupported command ${op}`)
    }
  }
}
