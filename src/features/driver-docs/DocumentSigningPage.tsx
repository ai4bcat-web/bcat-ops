import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { CheckCircle2, AlertTriangle, Loader2, PenLine } from 'lucide-react'
import { emptyICStatus, icStatusContractorComplete, IC_STATUS_TITLE, type ICStatusValues } from '@/lib/driverDocs'
import { ICStatusFields } from './ICStatusFields'
import { icStatusPdfBase64 } from './independentContractorPdf'
import { getSignatureRequest, submitSignature, type SignatureRequestState } from './signing'

type Phase = 'loading' | 'error' | 'form' | 'already' | 'done'

export function DocumentSigningPage() {
  const { token = '' } = useParams()
  const [phase, setPhase] = useState<Phase>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [req, setReq] = useState<SignatureRequestState | null>(null)
  const [v, setV] = useState<ICStatusValues>(emptyICStatus())
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    document.title = 'Sign document — Ivan Cartage'
    getSignatureRequest(token)
      .then((r) => {
        setReq(r)
        if (r.status === 'SIGNED') { setPhase('already'); return }
        setV({ ...emptyICStatus(), printName: r.driverName || '', ...(r.valuesJson ?? {}) })
        setPhase('form')
      })
      .catch((e) => { setErrMsg(e?.message || 'This signing link is invalid or has expired.'); setPhase('error') })
  }, [token])

  async function submit() {
    if (!icStatusContractorComplete(v)) return
    setSubmitting(true)
    try {
      await submitSignature(token, v, icStatusPdfBase64(v))
      setPhase('done')
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Could not submit — please try again.')
      setPhase('error')
    } finally {
      setSubmitting(false)
    }
  }

  const complete = icStatusContractorComplete(v)

  return (
    <div style={{ minHeight: '100vh', background: 'var(--ds-bg)', display: 'flex', flexDirection: 'column' }}>
      <header style={{ position: 'sticky', top: 0, zIndex: 20, background: '#0e1116', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 10, padding: '0 24px', height: 60 }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: 'linear-gradient(135deg, var(--ds-blue), var(--ds-blue-dark))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800 }}>IC</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>IVAN <span style={{ color: 'var(--ds-blue)' }}>CARTAGE</span></div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>Document signing</div>
          </div>
        </div>
      </header>

      <main style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
        <div style={{ width: '100%', maxWidth: 760, padding: '28px 24px 64px' }}>
          {phase === 'loading' && <Center><Loader2 className="animate-spin" size={26} style={{ color: 'var(--ds-t3)' }} /></Center>}

          {phase === 'error' && (
            <Card><AlertTriangle size={34} style={{ color: 'var(--ds-amber)' }} /><h1 style={h1}>This link can’t be opened</h1><p style={sub}>{errMsg}</p></Card>
          )}

          {phase === 'already' && (
            <Card><CheckCircle2 size={34} style={{ color: 'var(--ds-green)' }} /><h1 style={h1}>Already signed</h1><p style={sub}>This document has been signed and returned. No further action is needed.</p></Card>
          )}

          {phase === 'done' && (
            <Card><CheckCircle2 size={38} style={{ color: 'var(--ds-green)' }} /><h1 style={h1}>Thank you — you’re all set</h1><p style={sub}>Your signed {req?.documentTitle || IC_STATUS_TITLE} has been returned to Ivan Cartage. You can close this page.</p></Card>
          )}

          {phase === 'form' && (
            <>
              <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--ds-t1)', margin: '0 0 4px' }}>{req?.documentTitle || IC_STATUS_TITLE}</h1>
              <p style={{ color: 'var(--ds-t3)', marginTop: 0, marginBottom: 18, fontSize: 13.5 }}>Initial each statement below, fill in your details, then type your name to sign.</p>
              <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, padding: '20px 22px', boxShadow: 'var(--sh-sm)' }}>
                <ICStatusFields value={v} onChange={setV} />
              </div>
              <button
                onClick={submit}
                disabled={!complete || submitting}
                style={{ marginTop: 18, width: '100%', height: 46, borderRadius: 10, border: 'none', background: complete ? 'var(--ds-blue)' : 'var(--ds-border)', color: '#fff', fontSize: 15, fontWeight: 600, cursor: complete ? 'pointer' : 'not-allowed', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontFamily: 'inherit' }}
              >
                {submitting ? <Loader2 className="animate-spin" size={17} /> : <PenLine size={17} />}
                {submitting ? 'Submitting…' : 'Sign & submit'}
              </button>
              {!complete && <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--ds-t3)', marginTop: 8 }}>Initial all 14 statements and complete name, EIN, and signature to submit.</p>}
            </>
          )}
        </div>
      </main>
    </div>
  )
}

const h1: React.CSSProperties = { fontSize: 20, fontWeight: 700, color: 'var(--ds-t1)', margin: '14px 0 6px' }
const sub: React.CSSProperties = { color: 'var(--ds-t3)', fontSize: 14, margin: 0, maxWidth: 440 }
function Center({ children }: { children: React.ReactNode }) { return <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>{children}</div> }
function Card({ children }: { children: React.ReactNode }) {
  return <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', padding: '40px 28px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>{children}</div>
}
