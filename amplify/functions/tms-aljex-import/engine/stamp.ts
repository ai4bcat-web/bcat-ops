import type { EngineRow, EngineTable, TxCondition } from '../../../../src/types/tms'
import { INDEX_KEYS, MODEL_NAME } from './tables'

/** Every Amplify model row carries `__typename`, `createdAt` and `updatedAt`; direct writes must too. */
export function stampPut(table: EngineTable, item: EngineRow, now: string): EngineRow {
  return { ...item, __typename: MODEL_NAME[table], createdAt: item.createdAt ?? now, updatedAt: item.updatedAt ?? now }
}

/** A GSI key attribute may never be '' or NULL (DynamoDB refuses the whole write). */
export function assertIndexKeys(table: EngineTable, row: EngineRow): void {
  for (const key of INDEX_KEYS[table] ?? []) {
    const v = row[key]
    // `undefined` is dropped when the row is marshalled, so it is an absent key, not a violation.
    if (v === undefined) continue
    if (v === null || v === '') {
      throw new Error(`Index key ${table}.${key} is ${v === '' ? 'empty' : 'null'} on row ${String(row.id)}`)
    }
  }
}

const ATOM = /^\s*(?:(attribute_not_exists|attribute_exists)\(\s*([#\w]+)\s*\)|([#\w]+)\s*(=|<>|<=|>=|<|>)\s*(:\w+))\s*$/

/**
 * Evaluates the small condition grammar the engine uses (`attribute_[not_]exists(f)`, `f <op> :v`,
 * joined by OR / AND with no parentheses) against a stored row, for the in-memory store.
 */
export function evalCondition(cond: TxCondition | undefined, row: EngineRow | undefined): boolean {
  if (!cond) return true
  const resolveName = (n: string) => cond.names?.[n] ?? n
  const atomTrue = (atom: string): boolean => {
    const m = ATOM.exec(atom)
    if (!m) throw new Error(`Unsupported condition atom: ${atom}`)
    if (m[1]) {
      const exists = row !== undefined && row[resolveName(m[2])] !== undefined
      return m[1] === 'attribute_exists' ? exists : !exists
    }
    const left = row?.[resolveName(m[3])]
    const right = cond.values?.[m[5]]
    if (left === undefined) return false
    switch (m[4]) {
      case '=':
        return left === right
      case '<>':
        return left !== right
      case '<':
        return (left as number) < (right as number)
      case '<=':
        return (left as number) <= (right as number)
      case '>':
        return (left as number) > (right as number)
      default:
        return (left as number) >= (right as number)
    }
  }
  return cond.expression.split(/\s+OR\s+/).some((conj) => conj.split(/\s+AND\s+/).every(atomTrue))
}
