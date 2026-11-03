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
    await command('Page.navigate', { url: `${origin}/tms/tracking?tab=tracking&shipment=${selected}` })
    await poll(() => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Create Customer URL'); if (!button || button.disabled) return false; button.click(); return true; })()`), 'Create Customer URL action')
    await poll(() => evaluate(`!!document.querySelector('[data-testid="customer-link-dialog"]')`), 'Create Customer URL dialog')
    await capture('P8-UI-create-customer-url.png')
    return { inTransitRows: rows.length, selected, eta: detail.eta }
  } finally {
    await browser.close()
  }
}
