import { launchBrowser, DEV_ORIGIN } from './cdpBrowser.mjs'

/** Exercise the real dev UI in an isolated Chrome profile; never persist login tokens. */
export async function verifyTrackingUi({ storage, shipmentIds, origin = DEV_ORIGIN, screenshots }) {
  const browser = await launchBrowser({
    origin, storage, screenshots, profilePrefix: 'bcat-p8-ui-', collect: false,
    purpose: 'Tracking UI verification',
  })
  const { command, evaluate, poll, capture } = browser
  try {
    await command('Page.navigate', { url: `${origin}/tms/tracking?tab=tracking` })
    const rows = await poll(() => evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-testid="tracking-row"][data-status="DEPARTED"]')];
      const seeded = rows.map(row => row.dataset.shipmentId).filter(id => ${JSON.stringify(shipmentIds)}.includes(id));
      return seeded.length >= 5 ? seeded : null;
    })()`), 'at least five seeded in-transit tracking rows')
    const bookingTab = await evaluate(`[...document.querySelectorAll('[role="tab"]')].some(tab => /^Booking$/.test(tab.textContent.trim()))`)
    if (bookingTab) throw new Error('Tracking still exposes offers through a Booking tab')
    await capture('P8-UI-tracking-table.png')
    const selected = rows[0]
    await evaluate(`document.querySelector('[data-testid="tracking-row"][data-shipment-id="${selected}"]').click()`)
    await poll(() => evaluate(`(() => {
      const detail = document.querySelector('[data-testid="tracking-detail"]');
      return detail?.dataset.shipmentId === ${JSON.stringify(selected)} &&
        location.pathname.includes('/tms/shipments/') &&
        /estimate|Google|Distance Matrix/i.test(detail.querySelector('[data-testid="tracking-eta"]')?.innerText ?? '') &&
        !!detail.querySelector('[data-testid="tracking-thread"]');
    })()`), 'shipment Tracking tab with computed ETA and thread')
    const detail = await evaluate(`(() => {
      const root = document.querySelector('[data-testid="tracking-detail"]');
      return { map: !!root.querySelector('[data-testid="tracking-detail-map"]'),
        cadence: !!root.querySelector('[data-testid="tracking-cadence"]'),
        eta: root.querySelector('[data-testid="tracking-eta"]')?.innerText };
    })()`)
    if (!detail.map || !detail.cadence) throw new Error('Shipment tracking is missing map or cadence')
    await capture('P8-UI-shipment-tracking.png')
    await command('Page.navigate', { url: `${origin}/tms/tracking/links` })
    await poll(() => evaluate(`!!document.querySelector('[data-testid="customer-links-page"]')`), 'Manage Customer Links page')
    await capture('P8-UI-manage-customer-links.png')
    // `?shipment=` is a legacy Inbox bookmark that now redirects to the shipment page, so the
    // action is driven from the table itself: the seeded row's own menu (and the toolbar button).
    await command('Page.navigate', { url: `${origin}/tms/tracking?assignee=all` })
    await poll(() => evaluate(`!!document.querySelector('[data-testid="tracking-row"][data-shipment-id="${selected}"]')`), 'seeded shipment row on the Tracking table')
    const toolbarEnabled = await poll(() => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Create Customer URL'); return button ? !button.disabled : false })()`), 'Create Customer URL toolbar button enabled')
    if (!toolbarEnabled) throw new Error('Create Customer URL toolbar action is disabled although rows are listed')
    // The row menu is hover-only CSS; the item stays in the DOM, so click it directly.
    await poll(() => evaluate(`(() => { const item = [...document.querySelectorAll('[data-testid="tracking-row"][data-shipment-id="${selected}"] .tms-tracking-rowmenu-item')].find(b => b.textContent.trim() === 'Create customer URL'); if (!item || item.disabled) return false; item.click(); return true; })()`), 'Create customer URL row action')
    await poll(() => evaluate(`!!document.querySelector('[data-testid="customer-link-dialog"]')`), 'Create Customer URL dialog')
    await capture('P8-UI-create-customer-url.png')
    return { inTransitRows: rows.length, selected, eta: detail.eta }
  } finally {
    await browser.close()
  }
}
