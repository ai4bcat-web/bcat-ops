/**
 * Every staff prefix must be readable by a signed-in staff member, not only by ADMIN and
 * DISPATCHER.
 *
 * This is a source-shape guard rather than a behaviour test, because the thing it
 * protects cannot be caught any other way: `defineStorage` compiles fine either way, the
 * app builds, every test passes, and the failure only appears in production as
 *
 *   AccessDenied … not authorized to perform: s3:GetObject … because no identity-based
 *   policy allows the s3:GetObject action
 *
 * for one person and not another. That is what happened to `driver-docs/*`: it granted
 * the ADMIN and DISPATCHER groups only. Staff whose Cognito groups are just the `page-*`
 * permission groups have no group ROLE, so Cognito hands them the plain authenticated
 * role — which had no grant on that prefix. Someone the app had already let onto the
 * loads page could not open the POD on it.
 *
 * So: a prefix granted to the staff groups must also be granted to authenticated. Write
 * and delete may stay narrower; read may not.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dirname, 'resource.ts'), 'utf8')

/** Each `'prefix/*': [ … ]` block, with comments stripped so prose cannot fake a grant. */
function accessBlocks(): Array<{ prefix: string; grants: string }> {
  /*
   * Only comments that START a line are stripped. A blanket `/\*…*\/` strip also eats
   * the prefixes themselves — every one of them ends in `/*` — which silently reduced
   * this whole file to one block and made the guard vacuous.
   */
  const body = source
    .replace(/\n[ \t]*\/\*[\s\S]*?\*\//g, '\n')
    .replace(/\n[ \t]*\/\/[^\n]*/g, '\n')
  /*
   * Each block runs from its own prefix to the next one (or to the end), rather than to
   * the first `]` — a non-greedy match stops inside `.to(['read', 'write'])` and reports
   * one prefix with a truncated grant list, which is how this guard first lied to me.
   */
  const starts: Array<{ prefix: string; at: number }> = []
  const re = /'([^']+\/\*)'\s*:\s*\[/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) starts.push({ prefix: m[1], at: m.index + m[0].length })
  return starts.map((s, i) => ({
    prefix: s.prefix,
    grants: body.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : body.length),
  }))
}

const grantsTo = (grants: string, who: string, verb: string): boolean =>
  new RegExp(`allow\\.${who}[^\\n]*\\.to\\(\\[[^\\]]*'${verb}'`).test(grants)

describe('storage access rules', () => {
  const blocks = accessBlocks()

  it('finds the prefixes at all, so a parse failure cannot pass this file silently', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(10)
    expect(blocks.map((b) => b.prefix)).toContain('driver-docs/*')
  })

  it.each(['driver-docs/*'])('grants authenticated staff read on %s', (prefix) => {
    const block = blocks.find((b) => b.prefix === prefix)
    expect(block).toBeDefined()
    expect(grantsTo(block!.grants, 'authenticated', 'read')).toBe(true)
  })

  it('never grants the staff groups a read that authenticated staff do not also have', () => {
    const broken = blocks
      .filter((b) => grantsTo(b.grants, 'groups', 'read') && !grantsTo(b.grants, 'authenticated', 'read'))
      .map((b) => b.prefix)
    expect(broken).toEqual([])
  })

  it('lets staff upload a POD on a driver behalf', () => {
    // Staff upload goes straight to S3 from the browser (uploadDriverDocFile), so a
    // read-only grant would move the same AccessDenied onto the upload button.
    const block = blocks.find((b) => b.prefix === 'driver-docs/*')!
    expect(grantsTo(block.grants, 'authenticated', 'write')).toBe(true)
  })

  it('keeps delete on driver-docs with the staff groups', () => {
    // Nothing in the browser deletes these; removing a POD clears the DynamoDB rows and
    // leaves the file as the record of what arrived at a dock.
    const block = blocks.find((b) => b.prefix === 'driver-docs/*')!
    expect(grantsTo(block.grants, 'authenticated', 'delete')).toBe(false)
    expect(grantsTo(block.grants, 'groups', 'delete')).toBe(true)
  })
})
