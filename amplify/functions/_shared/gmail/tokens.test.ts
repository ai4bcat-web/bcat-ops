import { beforeEach, describe, expect, it, vi } from 'vitest'

const params = new Map<string, string>()
vi.mock('@aws-sdk/client-ssm', () => {
  const nf = () => Object.assign(new Error('nf'), { name: 'ParameterNotFound' })
  class SSMClient {
    async send(cmd: { __t: string; input: { Name: string; Value?: string } }) {
      if (cmd.__t === 'put') params.set(cmd.input.Name, cmd.input.Value ?? '')
      if (cmd.__t === 'del') params.delete(cmd.input.Name)
      if (cmd.__t === 'get') {
        const v = params.get(cmd.input.Name)
        if (v === undefined) throw nf()
        return { Parameter: { Value: v } }
      }
      return {}
    }
  }
  const mk = (t: string) => class { __t = t; constructor(public input: unknown) {} }
  return { SSMClient, GetParameterCommand: mk('get'), PutParameterCommand: mk('put'), DeleteParameterCommand: mk('del') }
})

process.env.GMAIL_TOKEN_PARAM_PATH = '/bcat/gmail/pool/users'
process.env.INTEGRATION_PARAM_PATH = '/bcat/integrations/pool'

import { deleteRefreshToken, getAccessToken, getRefreshToken, putRefreshToken, readOAuthClient, resetTokenCache, tokenParamName } from './tokens'
import { NeedsReconnect } from './errors'

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })

describe('tokens', () => {
  beforeEach(() => {
    params.clear()
    resetTokenCache()
  })

  it('keeps refresh tokens under the gmail prefix, never the integrations one', async () => {
    await putRefreshToken('rep-1', { refreshToken: 'r1', scope: 's', googleEmail: 'a@b.test', obtainedAt: 'now' })
    expect([...params.keys()]).toEqual([tokenParamName('rep-1')])
    expect(tokenParamName('rep-1').startsWith('/bcat/gmail/pool/users/')).toBe(true)
    expect((await getRefreshToken('rep-1'))?.refreshToken).toBe('r1')
    await deleteRefreshToken('rep-1')
    expect(await getRefreshToken('rep-1')).toBeNull()
  })

  it('is not configured until both client keys exist, and never when neutered', async () => {
    expect(await readOAuthClient()).toBeNull()
    params.set('/bcat/integrations/pool/GMAIL_REP_OAUTH', JSON.stringify({ clientId: 'disabled-on-dev', clientSecret: 'x' }))
    resetTokenCache()
    expect(await readOAuthClient()).toBeNull()
  })

  async function connected() {
    params.set('/bcat/integrations/pool/GMAIL_REP_OAUTH', JSON.stringify({ clientId: 'cid', clientSecret: 'cs' }))
    await putRefreshToken('rep-1', { refreshToken: 'r1', scope: 's', googleEmail: 'a@b.test', obtainedAt: 'now' })
  }

  it('caches an access token until 50 minutes pass', async () => {
    await connected()
    const f = vi.fn(async () => json({ access_token: 'at' }))
    let t = 1_000
    expect(await getAccessToken('rep-1', f as unknown as typeof fetch, () => t)).toBe('at')
    t += 49 * 60_000
    await getAccessToken('rep-1', f as unknown as typeof fetch, () => t)
    expect(f).toHaveBeenCalledTimes(1)
    t += 2 * 60_000
    await getAccessToken('rep-1', f as unknown as typeof fetch, () => t)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('maps invalid_grant to NeedsReconnect', async () => {
    await connected()
    const f = vi.fn(async () => json({ error: 'invalid_grant' }, 400))
    await expect(getAccessToken('rep-1', f as unknown as typeof fetch)).rejects.toBeInstanceOf(NeedsReconnect)
  })
})
