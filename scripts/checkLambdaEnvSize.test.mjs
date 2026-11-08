import { describe, expect, it } from 'vitest'
import { LIMIT_BYTES, lambdaEnvSizes, ssmSecretNames } from './checkLambdaEnvSize.mjs'

const fn = (variables) => ({ Resources: { F: { Type: 'AWS::Lambda::Function', Properties: { Environment: { Variables: variables } } } } })

describe('lambdaEnvSizes', () => {
  it('counts plain strings exactly and only scales CloudFormation tokens', () => {
    const [size] = lambdaEnvSizes(fn({ PLAIN: 'x'.repeat(100), TOKEN: { 'Fn::GetAtt': ['R', 'Outputs.XTableArn'] } }))
    // 5 + 100 exact; the ARN token is estimated at 120 B and counted at 0.8 + the key
    expect(size.raw).toBe(5 + 100 + 5 + 120)
    expect(size.bytes).toBeLessThan(size.raw)
    expect(size.bytes).toBeGreaterThanOrEqual(5 + 100 + 5)
  })

  it('does not hide a string-heavy environment behind a whole-total discount', () => {
    // tms-directory-actions on main: ~3.8 KB of exact strings. A 0.9 x total factor passed it at 3.8 KB while Lambda counted over 4,096.
    const [size] = lambdaEnvSizes(fn({ BIG: 'y'.repeat(LIMIT_BYTES + 10) }))
    expect(size.bytes).toBeGreaterThan(LIMIT_BYTES)
  })

  it('lists Amplify secrets, not resource references, from AMPLIFY_SSM_ENV_CONFIG', () => {
    const config = JSON.stringify({
      SLACK_BOT_TOKEN: { path: '/amplify/a/b/SLACK_BOT_TOKEN', sharedPath: '/amplify/shared/a/SLACK_BOT_TOKEN' },
      VENDOR_AP_INTAKE_SECRET: { path: '/amplify/a/b/INTAKE_WEBHOOK_SECRET', sharedPath: '/amplify/shared/a/INTAKE_WEBHOOK_SECRET' },
      AMPLIFY_DATA_DEFAULT_NAME: { path: '/amplify/resource_reference/a/b/AMPLIFY_DATA_DEFAULT_NAME' },
    })
    expect(ssmSecretNames(config)).toEqual([
      { key: 'SLACK_BOT_TOKEN', ssm: 'SLACK_BOT_TOKEN' },
      { key: 'VENDOR_AP_INTAKE_SECRET', ssm: 'INTAKE_WEBHOOK_SECRET' },
    ])
    expect(ssmSecretNames({ 'Fn::Join': [] })).toEqual([])
  })
})
