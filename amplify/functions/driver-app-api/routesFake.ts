/** In-memory DynamoDB expression evaluation for the driver-app-api route tests (same rules as handler.test.ts). */
function resolvePath(path: string, names: Record<string, string>): string[] {
  return path
    .split('.')
    .map((part) => (part.startsWith('#') ? names[part] ?? part : part))
}

function getPath(obj: Record<string, unknown>, path: string, names: Record<string, string>): unknown {
  const parts = resolvePath(path, names)
  let current: unknown = obj
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function setPath(obj: Record<string, unknown>, path: string, names: Record<string, string>, value: unknown) {
  const parts = resolvePath(path, names)
  let current: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!current[part] || typeof current[part] !== 'object') {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

function deletePath(obj: Record<string, unknown>, path: string, names: Record<string, string>) {
  const parts = resolvePath(path, names)
  let current: unknown = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!current || typeof current !== 'object') return
    current = (current as Record<string, unknown>)[part]
  }
  if (current && typeof current === 'object') {
    delete (current as Record<string, unknown>)[parts[parts.length - 1]]
  }
}

export function applyUpdateExpression(
  rec: Record<string, unknown>,
  expr: string,
  names: Record<string, string>,
  values: Record<string, unknown>,
) {
  if (!expr.trim()) throw new Error('UpdateExpression is empty')

  // Reject unbound or undefined value references like DynamoDB would.
  for (const ref of Array.from(new Set(expr.match(/:\w+/g) ?? []))) {
    if (!(ref in values)) throw new Error(`UpdateExpression references unbound value ${ref}`)
    if (values[ref] === undefined) throw new Error(`UpdateExpression references undefined value ${ref}`)
  }
  // Reject unbound name references.
  for (const ref of Array.from(new Set(expr.match(/#\w+/g) ?? []))) {
    if (!(ref in names)) throw new Error(`UpdateExpression references unbound name ${ref}`)
  }

  const clauses = Array.from(expr.matchAll(/(SET|REMOVE)\s+([^]*?)(?=\s*(?:SET|REMOVE)\s|$)/gi))
  for (const clause of clauses) {
    const action = (clause[1] as string).toUpperCase()
    const body = (clause[2] as string).trim()
    if (!body) continue
    const assignments = splitAssignments(body)
    for (const assignment of assignments) {
      const trimmed = assignment.trim()
      if (!trimmed) continue
      const eq = trimmed.indexOf('=')
      if (action === 'REMOVE' && eq < 0) {
        deletePath(rec, trimmed, names)
        continue
      }
      if (eq < 0) continue
      const lhs = trimmed.slice(0, eq).trim()
      const rhs = trimmed.slice(eq + 1).trim()
      if (action === 'SET') {
        const value = evaluateRhs(rhs, rec, names, values)
        setPath(rec, lhs, names, value)
      }
    }
  }
}

function splitAssignments(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      out.push(body.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(body.slice(start).trim())
  return out.filter(Boolean)
}

function evaluateRhs(
  rhs: string,
  rec: Record<string, unknown>,
  names: Record<string, string>,
  values: Record<string, unknown>,
): unknown {
  rhs = rhs.trim()
  if (rhs.startsWith(':')) return values[rhs]
  const listAppend = rhs.match(/^list_append\s*\(\s*if_not_exists\s*\(\s*([^,]+)\s*,\s*(:\w+)\s*\)\s*,\s*(:\w+)\s*\)$/i)
  if (listAppend) {
    const existing = getPath(rec, listAppend[1], names) as unknown[] | undefined
    const empty = values[listAppend[2]] as unknown[] | undefined
    const appended = values[listAppend[3]] as unknown[]
    return [...(existing ?? empty ?? []), ...appended]
  }
  return rhs
}

export function matchesFilterExpression(
  rec: Record<string, unknown>,
  filter: string,
  values: Record<string, unknown>,
  names: Record<string, string> = {},
): boolean {
  if (!filter) return true
  const clauses = filter.split(/\s+AND\s+/i)
  for (const clause of clauses) {
    const between = clause.match(/^\s*([\w]+)\s+BETWEEN\s+(:\w+)\s+AND\s+(:\w+)\s*$/i)
    if (between) {
      const field = between[1]
      const a = values[between[2]]
      const b = values[between[3]]
      const v = rec[field]
      if (typeof v !== 'string' || typeof a !== 'string' || typeof b !== 'string') return false
      if (v < a || v > b) return false
      continue
    }
    // DynamoDB compares strings lexicographically; the handler relies on that to bound a
    // pay week, so the fake must model >= / < rather than quietly ignoring them.
    const cmp = clause.match(/^\s*([\w]+)\s*(>=|<=|>|<)\s*(:\w+)\s*$/i)
    if (cmp) {
      const v = rec[cmp[1]]
      const bound = values[cmp[3]]
      if (typeof v !== 'string' || typeof bound !== 'string') return false
      if (cmp[2] === '>=' && !(v >= bound)) return false
      if (cmp[2] === '<=' && !(v <= bound)) return false
      if (cmp[2] === '>' && !(v > bound)) return false
      if (cmp[2] === '<' && !(v < bound)) return false
      continue
    }
    const eq = clause.match(/^\s*(#?[\w]+)\s*=\s*(:\w+)\s*$/i)
    if (eq) {
      const field = eq[1].startsWith('#') ? names[eq[1]] : eq[1]
      if (rec[field] !== values[eq[2]]) return false
      continue
    }
    // A clause this fake cannot parse must NOT quietly widen the result set — that is how
    // a scoping test goes green while the real query filters nothing.
    throw new Error(`matchesFilterExpression: unsupported clause ${JSON.stringify(clause)}`)
  }
  return true
}
