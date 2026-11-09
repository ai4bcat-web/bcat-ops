import { describe, expect, it } from 'vitest'
import { buildNavSections } from '@/lib/navSections'

const divs = (extra: Array<Record<string, unknown>>) => ([
  { id: 'ASSETS', code: 'ASSETS', name: 'Ivan Cartage', brand: null, parentId: null, sortOrder: 20, active: true },
  { id: 'BROKERAGE', code: 'BROKERAGE', name: 'BCAT Logistics', brand: null, parentId: null, sortOrder: 10, active: true },
  ...extra,
]) as never

const shown = (d: never) => {
  const { pinned, sections } = buildNavSections({ divisions: d, hasPageAccess: () => false, isOwner: true })
  const to: string[] = []
  const walk = (items: Array<{ to?: string; children?: unknown[] }> | undefined) => {
    for (const i of items ?? []) { if (i.to) to.push(i.to); walk(i.children as never) }
  }
  walk(pinned as never)
  for (const s of sections) walk(s.items as never)
  return to
}

describe('Company sidebar section does not depend on a Company division row', () => {
  it('shows Finances and Reddit Queue when the Company division is missing', () => {
    const to = shown(divs([]))
    expect(to).toContain('/finances')
    expect(to).toContain('/reddit-queue')
  })
  it('shows them when the Company division row is inactive (retired)', () => {
    const to = shown(divs([{ id: 'COMPANY', code: 'COMPANY', name: 'Company', brand: null, parentId: null, sortOrder: 99, active: false }]))
    expect(to).toContain('/finances')
    expect(to).toContain('/reddit-queue')
  })
})
