/**
 * The carrier's tax ID, as the encrypted vault allows it to be seen (AW_TAXID_DESIGN §6).
 *
 * Everyone sees "on file ••••1234" from the Carrier row's mirror fields. An ADMIN also gets Set,
 * Reveal and Clear. A revealed number lives in this component's state only: no store, cache,
 * storage, URL, toast, log or clipboard button; it disappears after 30 seconds, when the window
 * loses focus, on a route change and on unmount.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { TmsButton, TmsCard, TmsDialog, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { clearTaxId, revealTaxId, setTaxId } from '@/lib/apiClient'
import type { CarrierRecord } from '@/types/tms'

const MIN_REASON = 8
const REVEAL_SECONDS = 30

type Dialog = 'set' | 'reveal' | 'clear' | null

interface TaxIdCardProps {
  carrier: CarrierRecord
  isAdmin: boolean
  /** Called after a Set or Clear so the parent reloads the Carrier row's mirror fields. */
  onChanged: () => void
}

const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback)

export function TaxIdCard({ carrier, isAdmin, onChanged }: TaxIdCardProps) {
  const location = useLocation()
  const [dialog, setDialog] = useState<Dialog>(null)
  // A revealed value belongs to one carrier on one route; navigating anywhere else makes it invisible at once (and the
  // unmount that usually follows drops it for good).
  const scope = `${location.pathname}${location.search}#${carrier.id}`
  const [reveal, setReveal] = useState<{ value: string; scope: string } | null>(null)
  const revealed = reveal !== null && reveal.scope === scope ? reveal.value : null
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  const onFile = Boolean(carrier.taxIdLast4)
  const hide = useCallback(() => { setReveal(null); setSecondsLeft(0) }, [])

  // 30-second countdown; the value is dropped the moment it reaches zero.
  useEffect(() => {
    if (revealed === null) return undefined
    const timer = window.setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) { setReveal(null); return 0 }
        return s - 1
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [revealed])

  // Hide on window blur / tab hidden, route change and unmount.
  useEffect(() => {
    window.addEventListener('blur', hide)
    const onVisibility = () => { if (document.hidden) hide() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', hide)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [hide])

  const finish = (message: string) => {
    setDialog(null)
    setNotice(message)
    onChanged()
  }

  const summary = onFile
    ? `on file ••••${carrier.taxIdLast4}${carrier.taxIdType ? ` (${carrier.taxIdType}${carrier.taxIdOnFileAt ? `, since ${carrier.taxIdOnFileAt.slice(0, 10)}` : ''})` : ''}`
    : 'not on file'

  return (
    <TmsCard
      title="Tax ID"
      actions={isAdmin ? (
        <div className="flex gap-2">
          <TmsButton size="sm" variant="ghost" onClick={() => { setNotice(null); setDialog('set') }}>{onFile ? 'Replace' : 'Set'}</TmsButton>
          {onFile && <TmsButton size="sm" variant="ghost" onClick={() => { setNotice(null); setDialog('reveal') }}>Reveal</TmsButton>}
          {onFile && <TmsButton size="sm" variant="ghost" onClick={() => { setNotice(null); setDialog('clear') }}>Clear</TmsButton>}
        </div>
      ) : undefined}
    >
      <div className="flex flex-col gap-1" data-testid="tax-id-card">
        <p>
          <span className="tms-muted">Tax ID: </span>
          <span data-testid="tax-id-summary">{summary}</span>
        </p>
        {revealed !== null && (
          <p data-testid="tax-id-revealed">
            <span className="font-mono">{revealed}</span>
            <span className="tms-muted text-xs"> · hides in {secondsLeft}s</span>
          </p>
        )}
        {notice && <p className="tms-muted text-xs">{notice}</p>}
      </div>

      {isAdmin && dialog === 'set' && (
        <SetDialog carrierId={carrier.id} onClose={() => setDialog(null)} onDone={() => finish('Tax ID saved.')} />
      )}
      {isAdmin && dialog === 'reveal' && (
        <ReasonDialog
          title="Reveal tax ID"
          confirm="Reveal"
          onClose={() => setDialog(null)}
          run={async (reason) => {
            const out = await revealTaxId(carrier.id, reason)
            setReveal({ value: out.value, scope })
            setSecondsLeft(Math.min(out.expiresInSeconds || REVEAL_SECONDS, REVEAL_SECONDS))
            setDialog(null)
          }}
          placeholder="1099 prep / factor setup / ..."
          blurb="Every reveal is logged with your name and this reason."
        />
      )}
      {isAdmin && dialog === 'clear' && (
        <ReasonDialog
          title="Clear tax ID"
          confirm="Clear tax ID"
          onClose={() => setDialog(null)}
          run={async (reason) => {
            await clearTaxId(carrier.id, reason)
            hide()
            finish('Tax ID cleared.')
          }}
          placeholder="Why is it being removed?"
          blurb="Deletes the stored number for this carrier."
        />
      )}
    </TmsCard>
  )
}

function ReasonDialog({ title, confirm, placeholder, blurb, onClose, run }: {
  title: string
  confirm: string
  placeholder: string
  blurb: string
  onClose: () => void
  run: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ok = reason.trim().length >= MIN_REASON

  const submit = async () => {
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await run(reason.trim())
    } catch (err) {
      setError(errorText(err, 'Request failed'))
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(v) => { if (!v) onClose() }}
      title={title}
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={submit} disabled={busy || !ok}>{busy ? 'Working…' : confirm}</TmsButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="tms-muted text-xs">{blurb}</p>
        <TmsField label={`Reason * (at least ${MIN_REASON} characters)`} htmlFor="tax-id-reason">
          <TmsInput
            id="tax-id-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={placeholder}
            maxLength={250}
            autoComplete="off"
          />
        </TmsField>
        {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
      </div>
    </TmsDialog>
  )
}

function SetDialog({ carrierId, onClose, onDone }: { carrierId: string; onClose: () => void; onDone: () => void }) {
  // The typed number is held here only until the request returns, then wiped.
  const [value, setValue] = useState('')
  const [type, setType] = useState<'' | 'EIN' | 'SSN'>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const out = await setTaxId(carrierId, value.trim(), type || undefined)
      setValue('')
      if (out.ok) { onDone(); return }
      setError('That number is already on file for another carrier.')
    } catch (err) {
      setError(errorText(err, 'Could not save the tax ID'))
    }
    if (mounted.current) setBusy(false)
  }

  return (
    <TmsDialog
      open
      onOpenChange={(v) => { if (!v) { setValue(''); onClose() } }}
      title="Set tax ID"
      footer={
        <>
          <TmsButton variant="ghost" onClick={() => { setValue(''); onClose() }} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={submit} disabled={busy || value.replace(/\D/g, '').length !== 9}>{busy ? 'Saving…' : 'Save'}</TmsButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TmsField label="Tax ID (9 digits)" htmlFor="tax-id-value">
          <TmsInput
            id="tax-id-value"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            maxLength={16}
            data-lpignore="true"
          />
        </TmsField>
        <TmsField label="Type" htmlFor="tax-id-type">
          <TmsSelect id="tax-id-type" value={type} onChange={(e) => setType(e.target.value as '' | 'EIN' | 'SSN')}>
            <option value="">Detect from format</option>
            <option value="EIN">EIN</option>
            <option value="SSN">SSN</option>
          </TmsSelect>
        </TmsField>
        {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
      </div>
    </TmsDialog>
  )
}
