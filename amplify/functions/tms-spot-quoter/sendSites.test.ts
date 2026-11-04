/**
 * Safety property, asserted at source level on purpose: a reply may be sent from exactly
 * two places — `sendNow` (the rep's confirmed button) and `autoSendReply` (the gated
 * auto path). Any other call site is a way to send mail nobody approved.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = __dirname
const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'testkit.ts')

function enclosingFunction(text: string, index: number): string {
  const before = text.slice(0, index)
  const found = [...before.matchAll(/export async function (\w+)/g)].pop()
  return found?.[1] ?? '(top level)'
}

describe('send door', () => {
  it('calls sendDraft / sendReply only from sendNow and autoSendReply', () => {
    const sites: string[] = []
    for (const file of sources) {
      const text = readFileSync(join(dir, file), 'utf8')
      for (const m of text.matchAll(/\.(sendDraft|sendReply)\(/g)) {
        sites.push(`${file}:${enclosingFunction(text, m.index ?? 0)}.${m[1]}`)
      }
    }
    expect(sites.sort()).toEqual(['actions.ts:sendNow.sendDraft', 'autoSend.ts:autoSendReply.sendReply'])
  })
})
