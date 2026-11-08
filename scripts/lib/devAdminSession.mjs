/**
 * An ADMIN session for the dev harnesses that used to need BCAT_EMAIL / BCAT_PASSWORD.
 *
 * With those variables set, nothing changes: the named user signs in. Without them the
 * harness gets a throwaway ADMIN + page-tms login minted in the DEV pool (same as
 * devVerifyEmail / devVerifyR2), signs it in again on demand after a temporary login has
 * taken over the Amplify session, and deletes it at the end. A minted admin is not the
 * owner, so owner-only actions still refuse; that is the real behavior and is reported as such.
 */
import { DEV_API, mintIdentity, deleteIdentity, outputs } from './devIdentity.mjs'
import { authenticateTmsUser } from './tmsAuth.mjs'

export async function devAdminSession(label) {
  if (process.env.BCAT_EMAIL && process.env.BCAT_PASSWORD) {
    const first = await authenticateTmsUser(outputs)
    if (first.endpoint !== DEV_API) throw new Error('refusing to run against a non-dev API')
    return {
      minted: false, email: process.env.BCAT_EMAIL, token: first.token,
      relogin: async () => (await authenticateTmsUser(outputs)).token,
      cleanup: async () => true,
    }
  }
  const email = `zz-${label}-admin-${Date.now()}@example.invalid`
  const identity = await mintIdentity(email, ['ADMIN', 'page-tms'])
  return {
    minted: true, email, token: identity.token,
    relogin: async () => {
      const { signOut, signIn, fetchAuthSession } = await import('aws-amplify/auth')
      await signOut().catch(() => {})
      await signIn({ username: email, password: identity.password })
      return (await fetchAuthSession({ forceRefresh: true })).tokens.idToken.toString()
    },
    cleanup: () => deleteIdentity(email),
  }
}
