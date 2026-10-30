import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const DEV_ORIGIN = 'https://dev.d3dejqzs77khq6.amplifyapp.com'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Exercise the real dev UI in an isolated Chrome profile; never persist login tokens. */
export async function verifyTrackingUi({ storage, shipmentIds, origin = DEV_ORIGIN, screenshots }) {
  if (![DEV_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin)) {
    throw new Error('Tracking UI verification only permits dev or the local development server')
  }
  const profile = await mkdtemp(join(tmpdir(), 'bcat-p8-ui-'))
  const executable = process.env.CHROME_BIN ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome')
  const chrome = spawn(executable, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1600,1100', 'about:blank',
  ], { stdio: 'ignore' })
  let launchError
  chrome.on('error', (error) => { launchError = error })
  let socket
  const pending = new Map()
  let nextId = 0
  let sessionId
  async function poll(run, label, timeout = 60_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const result = await run()
      if (result) return result
      await pause(200)
    }
    throw new Error(`Timed out waiting for ${label}`)
  }
  function command(method, params = {}, session = sessionId) {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)) }, 30_000)
      pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }))
    })
  }
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  try {
    const portFile = await poll(async () => {
      if (launchError) throw launchError
      if (chrome.exitCode != null) throw new Error(`Chrome exited with ${chrome.exitCode}`)
      return readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => null)
    }, 'Chrome startup', 20_000)
    const [port, endpoint] = portFile.trim().split('\n')
    socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`)
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    socket.on('message', (raw) => {
      try {
        let message
        try {
          message = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
        } catch {
          return
        }
        const request = pending.get(message.id)
        if (!request) return
        pending.delete(message.id)
        if (message.error) request.reject(new Error(String(message.error.message ?? message.error)))
        else request.resolve(message.result)
      } catch (err) {
        console.error('[CDP] resolver error:', err?.message)
      }
    })
    const { targetId } = await command('Target.createTarget', { url: 'about:blank' })
    ;({ sessionId } = await command('Target.attachToTarget', { targetId, flatten: true }))
    await command('Page.enable')
    await command('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false })
    await command('Page.addScriptToEvaluateOnNewDocument', {
      source: `if(location.origin===${JSON.stringify(origin)}){for(const [key,value] of Object.entries(${JSON.stringify(storage)}))localStorage.setItem(key,value)}`,
    })
    async function capture(name) {
      if (!screenshots) return
      await mkdir(screenshots, { recursive: true })
      await pause(500)
      const image = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      await writeFile(join(screenshots, name), Buffer.from(image.data, 'base64'))
    }
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
    await command('Page.navigate', { url: `${origin}/tms/tracking?tab=inbox` })
    let inboxRows
    try {
      inboxRows = await poll(() => evaluate(`(() => {
        const rows = [...document.querySelectorAll('[data-testid="inbox-thread-row"]')];
        return rows.length >= 2 ? rows.map(row => row.dataset.shipmentId) : null;
      })()`), 'at least two inbox conversation rows')
    } catch (err) {
      const snapshot = await evaluate(`(() => ({ url: location.href, body: document.body?.innerText?.slice(0, 4000) ?? '' }))()`)
      console.error('INBOX ROW SNAPSHOT:', JSON.stringify(snapshot, null, 2))
      console.error('INBOX BROWSER LOGS:\n', logs.join('\n'))
      await capture('P8-UI-inbox-failed.png')
      throw err
    }
    const selectedInbox = inboxRows[0]
    const secondInbox = inboxRows[1]
    await command('Page.navigate', { url: `${origin}/tms/tracking?tab=inbox&shipment=${selectedInbox}` })
    await poll(() => evaluate(`(() => {
      const chat = document.querySelector('[data-testid="inbox-conversation"]');
      return chat && /Agent|Person|No messages/.test(chat.innerText) && document.querySelector('[data-testid="inbox-composer"]');
    })()`), 'Inbox tracking conversation and composer')
    await capture('P8-UI-inbox-conversation.png')
    await evaluate(`document.querySelector('[data-testid="inbox-thread-row"][data-shipment-id="${secondInbox}"]').click()`)
    await poll(() => evaluate(`new URLSearchParams(location.search).get('shipment') === ${JSON.stringify(secondInbox)} && !!document.querySelector('[data-testid="inbox-conversation"]')`), 'Inbox selection deep link')
    await command('Page.reload')
    await poll(() => evaluate(`new URLSearchParams(location.search).get('shipment') === ${JSON.stringify(secondInbox)} && !!document.querySelector('[data-testid="inbox-conversation"]')`), 'Inbox deep link after reload')
    await command('Page.navigate', { url: `${origin}/tms/tracking/links` })
    await poll(() => evaluate(`!!document.querySelector('[data-testid="customer-links-page"]')`), 'Manage Customer Links page')
    await capture('P8-UI-manage-customer-links.png')
    await command('Page.navigate', { url: `${origin}/tms/tracking?tab=tracking&shipment=${selected}` })
    await poll(() => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Create Customer URL'); if (!button || button.disabled) return false; button.click(); return true; })()`), 'Create Customer URL action')
    await poll(() => evaluate(`!!document.querySelector('[data-testid="customer-link-dialog"]')`), 'Create Customer URL dialog')
    await capture('P8-UI-create-customer-url.png')
    return { inTransitRows: rows.length, selected, inboxDeepLinkReload: true, eta: detail.eta }
  } finally {
    for (const request of pending.values()) request.reject(new Error('Browser verification closed'))
    socket?.close()
    if (chrome.exitCode == null && !launchError) {
      chrome.kill('SIGTERM')
      await Promise.race([new Promise((resolve) => chrome.once('exit', resolve)), pause(5000)])
      if (chrome.exitCode == null) chrome.kill('SIGKILL')
    }
    await rm(profile, { recursive: true, force: true })
  }
}
