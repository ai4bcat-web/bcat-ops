/**
 * Shared kit for the QAFlows sweep (scripts/devQaFlows.mjs): result log, token helpers, a fetch/XHR
 * recorder injected into every document, and a text-wait helper. Dev only; the caller guards the endpoints.
 * Nothing here prints a password, a token or a person's name.
 */
import { DEV_CLIENT } from './devIdentity.mjs'

export const results = []
export function record(status, id, name, detail = '') {
  results.push({ status, id, name, detail })
  console.log(`${status.padEnd(7)} ${id} ${name}${detail ? `: ${String(detail).slice(0, 400)}` : ''}`)
}
export const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ')
export const expect = (cond, message) => { if (!cond) throw new Error(message) }

/** The ACCESS token of a minted identity (the browser sends this one to AppSync, never the ID token). */
export function accessTokenOf(storage) {
  const key = Object.keys(storage).find((k) => k.startsWith(`CognitoIdentityServiceProvider.${DEV_CLIENT}.`) && k.endsWith('.accessToken'))
  return storage[key]
}
export function tokenUse(jwt) {
  try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).token_use } catch { return null }
}

/** Records every GraphQL / router response body that carries an error, and the token_use of each request. */
export const RECORDER = `(() => {
  if (window.__qa) return
  const qa = window.__qa = { errors: [], tokenUse: {}, calls: 0 }
  const use = (auth) => { try { return JSON.parse(atob(String(auth).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).token_use } catch { return null } }
  const note = (url, auth, text) => {
    if (!/appsync-api|lambda-url/.test(url)) return
    qa.calls++
    const u = use(auth); if (u) qa.tokenUse[u] = (qa.tokenUse[u] || 0) + 1
    if (u === 'id') (qa.idCalls = qa.idCalls || []).push(url.split('/')[2] + ' ' + (url.split('/')[3] || ''))
    if (/"errors"\\s*:\\s*\\[|errorType|Unauthorized|could not resolve caller|Forbidden/i.test(text)) {
      const found = [...text.matchAll(/"(?:message|errorType)"\\s*:\\s*"([^"]{0,160})"/g)].map((m) => m[1])
      qa.errors.push({ url: url.replace(/^https?:\\/\\/[^/]+/, '').slice(0, 40), found: found.slice(0, 3) })
    }
  }
  const f = window.fetch
  window.fetch = async function (input, init) {
    const url = String(typeof input === 'string' ? input : (input.url || input.href || input))
    const headers = new Headers((init && init.headers) || (typeof input !== 'string' ? input.headers : undefined) || {})
    const res = await f.apply(this, arguments)
    try { const clone = res.clone(); clone.text().then((t) => note(url, headers.get('authorization') || '', t)).catch(() => {}) } catch {}
    return res
  }
})()`

export async function installRecorder(b) { await b.addInitScript(RECORDER) }

/** Wait until the page has rendered something and its text stops changing for `quietMs`. */
export async function settle(b, { min = 80, quietMs = 1500, timeout = 45_000 } = {}) {
  const deadline = Date.now() + timeout
  let last = ''; let since = Date.now()
  while (Date.now() < deadline) {
    const text = await b.evaluate('document.body ? document.body.innerText : ""').catch(() => '')
    if (text !== last) { last = text; since = Date.now() } else if (text.length >= min && Date.now() - since >= quietMs) return text
    await b.pause(300)
  }
  return last
}
