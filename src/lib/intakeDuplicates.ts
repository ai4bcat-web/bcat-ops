/**
 * Read-time duplicate detection for the Intake queue: no new field, computed from the rows on screen. Two rows are the same load when
 * they are the same e-mail (`isSameEmail`) or the same tender (`isSameTender`: same reference from the same sender or customer, or the
 * same rate-confirmation file). A group's ORIGINAL is its earliest row; every row in a group of two or more is badged (a person may
 * decide to delete either one). A row someone marked "not a duplicate" is left out of grouping entirely.
 */
import { NOT_DUPLICATE_TOKEN, isDeletedIntake, isSameEmail, isSameTender } from './intakeDup'
import type { IntakeLoadRecord } from '../types/intake'

export interface DuplicateInfo {
  /** The earliest row of the group. */
  originalId: string
  originalLabel: string
  isOriginal: boolean
  /** How many rows are in the group. */
  count: number
  /** The other rows' ids (originals first). */
  otherIds: string[]
}

const asTender = (r: IntakeLoadRecord) => ({
  reference: r.fields?.reference, fromEmail: r.fromEmail, customerId: r.fields?.customerId, customerName: r.fields?.customerName,
  attachments: r.attachments,
})

export function sameLoad(a: IntakeLoadRecord, b: IntakeLoadRecord): boolean {
  return isSameEmail(a, b) || isSameTender(asTender(a), asTender(b))
}

/** Customer and reference when the row has them, else its subject or sender. */
export const intakeRowLabel = (row: IntakeLoadRecord): string =>
  [row.fields?.customerName, row.fields?.reference].filter(Boolean).join(' · ') || row.subject || row.fromEmail || row.id

export function duplicateGroups(rows: readonly IntakeLoadRecord[]): Map<string, DuplicateInfo> {
  const live = rows.filter((r) => !isDeletedIntake(r) && !(r.confirmed ?? []).includes(NOT_DUPLICATE_TOKEN))
  const parent = new Map<string, string>(live.map((r) => [r.id, r.id]))
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root) as string
    parent.set(id, root)
    return root
  }
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      if (sameLoad(live[i], live[j])) parent.set(find(live[i].id), find(live[j].id))
    }
  }
  const byRoot = new Map<string, IntakeLoadRecord[]>()
  for (const r of live) byRoot.set(find(r.id), [...(byRoot.get(find(r.id)) ?? []), r])
  const out = new Map<string, DuplicateInfo>()
  for (const group of byRoot.values()) {
    if (group.length < 2) continue
    const sorted = [...group].sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)) || a.id.localeCompare(b.id))
    const original = sorted[0]
    for (const r of group) {
      out.set(r.id, {
        originalId: original.id,
        originalLabel: intakeRowLabel(original),
        isOriginal: r.id === original.id,
        count: group.length,
        otherIds: sorted.filter((o) => o.id !== r.id).map((o) => o.id),
      })
    }
  }
  return out
}
