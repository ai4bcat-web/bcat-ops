/**
 * AWS Cognito sign-in used by TMS migration scripts.
 *
 * aws-amplify/auth is imported dynamically so scripts can print --help without
 * loading Amplify (which is browser/SSR-oriented) in plain Node.
 */

/**
 * Sign in with BCAT_EMAIL / BCAT_PASSWORD and return AppSync auth details.
 * @param {Record<string, unknown>} outputs
 * @returns {Promise<{token: string, endpoint: string, outputs: Record<string, unknown>}>}
 */
export async function authenticateTmsUser(outputs) {
  const { Amplify } = await import('aws-amplify');
  Amplify.configure(outputs);
  const email = process.env.BCAT_EMAIL;
  const password = process.env.BCAT_PASSWORD;
  if (!email || !password) {
    throw new Error('Set BCAT_EMAIL and BCAT_PASSWORD environment variables');
  }
  const { signIn, fetchAuthSession } = await import('aws-amplify/auth');
  const { isSignedIn } = await signIn({ username: email, password });
  if (!isSignedIn) {
    throw new Error('TMS sign-in failed');
  }
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) {
    throw new Error('No idToken returned from Auth session');
  }
  const endpoint = outputs?.data?.url;
  if (!endpoint) {
    throw new Error('amplify_outputs.json missing data.url');
  }
  return { token, endpoint, outputs };
}
