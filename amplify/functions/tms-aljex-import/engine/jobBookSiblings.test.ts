import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adoptJobFromSiblings, JobBook, siblingJobBooks } from './cli'

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'jobbook-'))
  const own = join(root, 'own', 'aljex-cli-jobs.json')
  const other = join(root, 'var', 'aa', 'bb', 'T', 'aljex-cli-jobs.json')
  mkdirSync(join(root, 'own'), { recursive: true })
  mkdirSync(join(root, 'var', 'aa', 'bb', 'T'), { recursive: true })
  return { root, own, other }
}

describe('job book of an earlier session', () => {
  it('finds the job in another temp dir book, adopts it into this one, and a missing id stays missing', () => {
    const sb = sandbox()
    writeFileSync(sb.other, JSON.stringify([{ id: 'aljexrun:A', kind: 'IMPORT', status: 'APPLIED', options: { sourcePath: '/x.csv' } }]))
    const siblings = siblingJobBooks(sb.own, join(sb.root, 'var'), [])
    expect(siblings).toEqual([sb.other])
    const book = new JobBook(sb.own)
    expect(adoptJobFromSiblings(book, 'aljexrun:A', sb.own, siblings)?.status).toBe('APPLIED')
    expect(book.get(['aljexrun:A'])).toHaveLength(1)
    expect((JSON.parse(readFileSync(sb.own, 'utf8')) as Array<{ id: string }>).map((r) => r.id)).toEqual(['aljexrun:A'])
    expect(adoptJobFromSiblings(book, 'aljexrun:NOPE', sb.own, siblings)).toBeNull()
  })

  it('never lists the own book as a sibling and ignores an unreadable one', () => {
    const sb = sandbox()
    writeFileSync(sb.other, 'not json')
    writeFileSync(sb.own, '[]')
    expect(siblingJobBooks(sb.other, join(sb.root, 'var'), [])).toEqual([])
    expect(adoptJobFromSiblings(new JobBook(sb.own), 'x', sb.own, siblingJobBooks(sb.own, join(sb.root, 'var'), []))).toBeNull()
  })
})
