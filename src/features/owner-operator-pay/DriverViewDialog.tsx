/**
 * The driver's settlement screen, on a desktop, inside a phone.
 *
 * Staff answering "what is the driver seeing?" were asking the driver — someone on a truck
 * describing a screen to someone looking at a different one. This renders the driver's OWN
 * components (StatementCard, which draws ShipmentRows) at phone width, so what is on screen
 * here is what is on screen there.
 *
 * It is a preview, not a login, and it says so. The data comes through the staff session
 * rather than the driver's, which is the useful property: if this and the driver's phone
 * ever disagree, the fault is upstream of both rather than in one of them.
 *
 * What it deliberately does NOT do is act. There are no upload or remove controls here —
 * paperwork belongs to the driver and to the Loads page, and a staff member clicking
 * "Remove" inside something labelled as the driver's view is a trap.
 */
import { X, Smartphone } from 'lucide-react'
import { StatementCard } from '@/features/driver-app/settlement/StatementCard'
import { previewSettlement } from './driverPreview'
import type { OwnerOperatorPayRow } from '@/hooks/useOwnerOperatorPay'

/** iPhone 14 at CSS pixels. Wide enough to be honest, narrow enough to catch a clip. */
const PHONE_WIDTH = 390
const PHONE_HEIGHT = 780

export function DriverViewDialog({
  row,
  periodStart,
  onClose,
}: {
  row: OwnerOperatorPayRow
  periodStart: string
  onClose: () => void
}) {
  const settlement = previewSettlement(row, periodStart)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${row.driver.name}'s driver app view`}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(15,23,42,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'flex', flexDirection: 'column', maxHeight: '94vh',
          borderRadius: 14, overflow: 'hidden',
          background: 'var(--ds-surface)', border: '1px solid var(--ds-border)',
          boxShadow: '0 24px 60px rgba(15,23,42,0.35)',
        }}
      >
        <header
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '12px 14px', borderBottom: '1px solid var(--ds-border)',
          }}
        >
          <Smartphone size={16} style={{ color: 'var(--ds-t2)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--ds-t1)' }}>
              {row.driver.name} — driver app
            </p>
            <p style={{ margin: '2px 0 0', fontSize: 11.5, color: 'var(--ds-t3)' }}>
              {settlement.weekLabel} · what their settlement screen shows
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the driver view"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: 6, cursor: 'pointer',
              border: '1px solid var(--ds-border)', background: 'var(--ds-bg)',
              color: 'var(--ds-t2)',
            }}
          >
            <X size={15} />
          </button>
        </header>

        {/*
          * The phone. A fixed width rather than a responsive one on purpose: the point is
          * to see the driver's layout at the size they have, including anything that
          * clips at 390px.
          */}
        <div
          style={{
            width: PHONE_WIDTH, height: PHONE_HEIGHT, maxHeight: '78vh',
            overflowY: 'auto', background: 'var(--ds-bg)',
            borderLeft: '1px solid var(--ds-border)', borderRight: '1px solid var(--ds-border)',
            margin: '0 auto',
          }}
        >
          <div className="mx-auto w-full max-w-md px-4 py-5">
            <StatementCard settlement={settlement} readOnly />
          </div>
        </div>

        <footer
          style={{
            padding: '9px 14px', borderTop: '1px solid var(--ds-border)',
            fontSize: 11.5, color: 'var(--ds-t3)', textAlign: 'center',
          }}
        >
          A preview, read through your own session — not a sign-in as {row.driver.name}.
          Paperwork is uploaded from the Loads page or by the driver.
        </footer>
      </div>
    </div>
  )
}
