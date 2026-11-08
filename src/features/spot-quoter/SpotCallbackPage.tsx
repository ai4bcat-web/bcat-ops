/**
 * Quotes › Spot inbox, OAuth return. Google sends the rep back here with `code` and the
 * single-use `state` the server issued; this page hands both to the server, which does the
 * exchange and keeps the token. Access is read-only: nothing is ever sent or drafted. The browser never sees a token or a client secret.
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { TmsAlert, TmsPage } from '@/features/tms/kit'
import { spotAction } from '@/lib/apiClient'
import { csOauthFinish, CS_SETTINGS_PATH, CS_STATE_PREFIX } from '@/features/tms/carrierSales/csClient'
import { apInboxOauthFinish, AP_SETTINGS_PATH, AP_STATE_PREFIX } from '@/features/ap/inbox/apInboxClient'
import { SPOT_CALLBACK_PATH, SPOT_INBOX_PATH } from './useSpotRequests'
import './spot.css'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function SpotCallbackPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const code = params.get('code')
  const state = params.get('state')
  const denied = params.get('error')
  const [failure, setFailure] = useState<string | null>(null)
  // `state` is single-use: a second exchange of it (a re-render, StrictMode) would be refused.
  const sent = useRef(false)

  const missing = !denied && (!code || !state)
  useEffect(() => {
    if (denied || missing || sent.current || !code || !state) return
    sent.current = true
    const redirectUri = `${window.location.origin}${SPOT_CALLBACK_PATH}`
    // Step AL: a carrier-sales mailbox consent carries `cs.<mailboxId>.<nonce>`; it returns to Settings › Carrier Sales.
    const isCarrierSales = state.startsWith(CS_STATE_PREFIX)
    // Step AG: the AP inbox consent carries `ap.<nonce>`; it returns to Settings › General & automation.
    const isApInbox = state.startsWith(AP_STATE_PREFIX)
    const finish: Promise<unknown> = isApInbox
      ? apInboxOauthFinish(code, state, redirectUri)
      : isCarrierSales ? csOauthFinish(code, state, redirectUri) : spotAction('SPOT_OAUTH_FINISH', { code, state, redirectUri })
    finish
      .then(() => navigate(isApInbox ? AP_SETTINGS_PATH : isCarrierSales ? CS_SETTINGS_PATH : SPOT_INBOX_PATH, { replace: true }))
      .catch((err: unknown) => setFailure(messageOf(err)))
  }, [code, state, denied, missing, navigate])

  const problem = denied
    ? `Google did not connect the mailbox (${denied}).`
    : missing
      ? 'This page is where Google sends you after you approve access; it was opened without that answer.'
      : failure

  return (
    <TmsPage title="Connecting Gmail">
      {problem ? (
        <TmsAlert tone="red" title="Gmail was not connected">
          <p data-testid="spot-callback-error">{problem}</p>
          <p className="tms-muted">Nothing was stored. You can try again from the Spot inbox.</p>
          <Link to={SPOT_INBOX_PATH} className="tms-btn tms-btn-secondary" data-testid="spot-callback-back">
            Back to the Spot inbox
          </Link>
        </TmsAlert>
      ) : (
        <>
          <p className="tms-muted" data-testid="spot-callback-working">Finishing the connection…</p>
          <p className="tms-muted">Read-only: BCAT Ops reads quote-request e-mails and never sends or drafts mail.</p>
        </>
      )}
    </TmsPage>
  )
}
