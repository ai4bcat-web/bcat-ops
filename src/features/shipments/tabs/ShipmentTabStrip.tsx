import { useState, type MouseEvent } from 'react'
import { useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom'
import { X } from 'lucide-react'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { useShipmentTabs } from './shipmentTabsContext'
import { parseShipmentList } from '@/lib/shipmentLists'
import { neighbourAfterClose, tabLabel } from './tabsModel'
import './tabs.css'

const BOARD = '/tms/shipments'
const SECTIONS = [
  { key: 'active', label: 'Active', to: BOARD },
  { key: 'all', label: 'All', to: `${BOARD}?list=all` },
  { key: 'voided', label: 'Voided', to: `${BOARD}?list=voided` },
] as const

/**
 * The tab strip above the Shipments board and the shipment form (Ryne 2026-11-11): Active, All and Voided are the permanent first tabs, every shipment
 * opened for editing is another. Each open shipment keeps its form (and so its draft and its edit lock) until its tab is closed, it is
 * saved and exited, or discarded. Middle-click closes a tab; a dot marks unsaved edits. Create shipment is in the board toolbar.
 * The strip belongs to View only (Ryne 2026-11-12): Intake is the whole Build page, with no tabs of its own.
 */
export function ShipmentTabStrip() {
  const tabsApi = useShipmentTabs()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const editMatch = useMatch('/tms/shipments/:id/edit')
  const [params] = useSearchParams()
  const [confirmId, setConfirmId] = useState<string | null>(null)
  if (!tabsApi) return null
  const path = pathname.replace(/\/+$/, '')
  const onBoard = path === BOARD
  if (!onBoard && !editMatch) return null
  const section = onBoard ? parseShipmentList(params.get('list')) : null
  const activeId = editMatch?.params.id ?? null
  const { tabs, dirty, close } = tabsApi

  const closeNow = (id: string) => {
    const next = id === activeId ? neighbourAfterClose(tabs, id) : activeId
    close(id)
    if (id === activeId) navigate(next ? `${BOARD}/${next}/edit` : BOARD)
  }
  const requestClose = (id: string) => (dirty.has(id) ? setConfirmId(id) : closeNow(id))
  const aux = (e: MouseEvent, id: string) => { if (e.button === 1) { e.preventDefault(); requestClose(id) } }
  const confirming = tabs.find((t) => t.id === confirmId) ?? null

  return (
    <>
      <div className="tms-ship-tabs-row">
        <div className="tms-ship-tabs" role="tablist" aria-label="Open shipments" data-testid="ship-tabs">
          {SECTIONS.map((sec) => (
            <button
              key={sec.key} type="button" role="tab" aria-selected={section === sec.key}
              className={`tms-ship-tab tms-ship-tab-board${section === sec.key ? ' tms-ship-tab-on' : ''}`}
              data-testid={`ship-tab-section-${sec.key}`} onClick={() => navigate(sec.to)}
            >
              {sec.label}
            </button>
          ))}
          {tabs.map((t) => {
            const on = t.id === activeId
            return (
              <span key={t.id} className={`tms-ship-tab${on ? ' tms-ship-tab-on' : ''}`} onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }} onAuxClick={(e) => aux(e, t.id)}>
                <button type="button" role="tab" aria-selected={on} className="tms-ship-tab-main" data-testid={`ship-tab-${t.id}`} title={tabLabel(t)} onClick={() => navigate(`${BOARD}/${t.id}/edit`)}>
                  {dirty.has(t.id) ? <span className="tms-ship-tab-dot" role="img" aria-label="Unsaved changes" data-testid={`ship-tab-dirty-${t.id}`} /> : null}
                  <span className="tms-ship-tab-label">{tabLabel(t)}</span>
                </button>
                <button type="button" className="tms-ship-tab-x" aria-label={`Close ${tabLabel(t)}`} data-testid={`ship-tab-close-${t.id}`} onClick={() => requestClose(t.id)}>
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            )
          })}
        </div>
      </div>
      <TmsDialog
        open={confirming != null}
        onOpenChange={(open) => { if (!open) setConfirmId(null) }}
        title={confirming ? `Close ${tabLabel(confirming)}?` : 'Close tab'}
        description="This shipment has unsaved changes. Closing the tab throws them away and lets go of its edit lock."
        footer={(
          <>
            <TmsButton variant="ghost" onClick={() => setConfirmId(null)}>Keep editing</TmsButton>
            <TmsButton variant="primary" data-testid="ship-tab-confirm-close" onClick={() => { if (confirmId) closeNow(confirmId); setConfirmId(null) }}>Close and discard</TmsButton>
          </>
        )}
      >
        <p className="text-sm">Save it first if you want to keep your edits.</p>
      </TmsDialog>
    </>
  )
}
