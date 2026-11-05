import { ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider'
import { cognito, DEV_POOL } from '/Users/adminoid/bcat-ops/scripts/lib/devIdentity.mjs'
export default async (ctx) => {
  const r = await cognito.send(new ListUsersCommand({ UserPoolId: DEV_POOL, Filter: 'email ^= "demo-"', Limit: 60 }))
  console.log('cognito demo-*', (r.Users ?? []).map((u) => u.Username + ' ' + u.UserStatus + ' ' + u.UserCreateDate?.toISOString()).join(' | '))
  const prof = (await ctx.gql('query { listUserProfiles(limit: 1000) { items { id name email role status } } }')).listUserProfiles.items
  console.log('profiles', JSON.stringify(prof.map((p) => [p.id.slice(0, 8), p.name, p.email, p.role, p.status])))
}
