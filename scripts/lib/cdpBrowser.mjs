import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import WebSocket from 'ws'

export const DEV_ORIGIN = 'https://dev.d3dejqzs77khq6.amplifyapp.com'
export const ALLOWED_ORIGINS = [DEV_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173']
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Isolated headless Chrome driven over CDP. Dev or the local dev server only; login
 * storage is injected for the allowed origin and the temp profile is removed on close().
 *
 * @param {object} options
 * @param {string} [options.origin]        must be one of ALLOWED_ORIGINS
 * @param {Record<string,string>} [options.storage]  localStorage entries injected for `origin` on every new document
 * @param {string} [options.screenshots]   directory for capture(name)
 * @param {string} [options.profilePrefix] temp profile dir prefix
 * @param {{width:number,height:number,deviceScaleFactor?:number}} [options.viewport]
 * @param {boolean} [options.collect]      enable Runtime/Log/Network collectors for problems()
 */
export async function launchBrowser({
  origin = DEV_ORIGIN,
  storage,
  screenshots,
  profilePrefix = 'bcat-s2-',
  viewport = { width: 1600, height: 1100, deviceScaleFactor: 1 },
  collect = true,
  purpose = 'Browser verification',
} = {}) {
  if (!ALLOWED_ORIGINS.includes(origin)) {
    throw new Error(`${purpose} only permits dev or the local development server`)
  }
  const profile = await mkdtemp(join(tmpdir(), profilePrefix))
  const executable = process.env.CHROME_BIN ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome')
  const chrome = spawn(executable, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', `--window-size=${viewport.width},${viewport.height}`, 'about:blank',
  ], { stdio: 'ignore' })
  let launchError
  chrome.on('error', (error) => { launchError = error })
  let socket
  const pending = new Map()
  let nextId = 0
  let sessionId
  let currentViewport = { ...viewport }

  const log = { exceptions: [], consoleErrors: [], httpErrors: [], failedRequests: [] }
  const markAt = { exceptions: 0, consoleErrors: 0, httpErrors: 0, failedRequests: 0 }
  const requestUrls = new Map()

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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  const argText = (a) => String(a.value ?? a.description ?? a.type ?? '')
  function onEvent(message) {
    if (!collect || message.sessionId !== sessionId) return
    const p = message.params ?? {}
    switch (message.method) {
      case 'Runtime.exceptionThrown':
        log.exceptions.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'exception')
        break
      case 'Runtime.consoleAPICalled':
        if (p.type === 'error') log.consoleErrors.push((p.args ?? []).map(argText).join(' ').slice(0, 500))
        break
      case 'Log.entryAdded':
        // Network failures also surface here; httpErrors/failedRequests cover them with a URL.
        if (p.entry?.level === 'error' && p.entry.source !== 'network') log.consoleErrors.push(`${p.entry.text} ${p.entry.url ?? ''}`.trim().slice(0, 500))
        break
      case 'Network.requestWillBeSent':
        requestUrls.set(p.requestId, p.request?.url)
        break
      case 'Network.responseReceived':
        if (p.response?.status >= 400) log.httpErrors.push(`${p.response.status} ${p.response.url}`)
        break
      case 'Network.loadingFailed':
        if (!p.canceled) log.failedRequests.push(`${p.errorText} ${requestUrls.get(p.requestId) ?? ''}`.trim())
        break
      default:
    }
  }

  async function close() {
    for (const request of pending.values()) request.reject(new Error('Browser verification closed'))
    socket?.close()
    if (chrome.exitCode == null && !launchError) {
      chrome.kill('SIGTERM')
      await Promise.race([new Promise((resolve) => chrome.once('exit', resolve)), pause(5000)])
      if (chrome.exitCode == null) chrome.kill('SIGKILL')
    }
    await rm(profile, { recursive: true, force: true })
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
        if (message.id == null) { onEvent(message); return }
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
    if (collect) {
      await command('Runtime.enable')
      await command('Log.enable')
      await command('Network.enable')
    }
    await command('Emulation.setDeviceMetricsOverride', { ...currentViewport, deviceScaleFactor: currentViewport.deviceScaleFactor ?? 1, mobile: false })
    if (storage) {
      await command('Page.addScriptToEvaluateOnNewDocument', {
        source: `if(location.origin===${JSON.stringify(origin)}){for(const [key,value] of Object.entries(${JSON.stringify(storage)}))localStorage.setItem(key,value)}`,
      })
    }

    const browser = {
      origin,
      command,
      evaluate,
      poll,
      pause,
      close,
      async navigate(url) {
        await command('Page.navigate', { url: /^(https?|data|about):/.test(url) ? url : `${origin}${url}` })
      },
      async reload() { await command('Page.reload') },
      /** Run `source` at the start of every new document (e.g. record data-tms-theme before paint). */
      async addInitScript(source) {
        await command('Page.addScriptToEvaluateOnNewDocument', { source })
      },
      async setViewport(width, height, deviceScaleFactor = 1) {
        currentViewport = { width, height, deviceScaleFactor }
        await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: width < 600 })
      },
      /** Start a new problems() window. */
      mark() { for (const key of Object.keys(markAt)) markAt[key] = log[key].length },
      /** Problems recorded since the last mark(). */
      problems() {
        return Object.fromEntries(Object.keys(markAt).map((key) => [key, log[key].slice(markAt[key])]))
      },
      async waitFor(selector, timeout = 30_000) {
        return poll(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector, timeout)
      },
      /** click(cssSelector) or click({ text, selector = 'button' }) — text is an exact trimmed match, or a RegExp source via { pattern }. */
      async click(target) {
        const spec = typeof target === 'string' ? { selector: target } : target
        const clicked = await evaluate(`(() => {
          const spec = ${JSON.stringify(spec)};
          const nodes = [...document.querySelectorAll(spec.selector ?? 'button')];
          const re = spec.pattern ? new RegExp(spec.pattern, spec.flags ?? 'i') : null;
          const el = nodes.find((n) => spec.text == null && !re ? true : re ? re.test(n.textContent.trim()) : n.textContent.trim() === spec.text);
          if (!el || el.disabled) return false;
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        })()`)
        if (!clicked) throw new Error(`Nothing clickable for ${JSON.stringify(spec)}`)
      },
      /** Press and release a named key (e.g. 'Escape', 'Enter'). */
      async press(key) {
        const code = key === 'Escape' ? 27 : key === 'Enter' ? 13 : 0
        const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }
        await command('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
        await command('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      },
      async grantClipboard() {
        await command('Browser.grantPermissions', {
          origin,
          permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
        }, null)
      },
      /** Save a screenshot at an absolute/relative path; clipToContent captures the page height (capped at 2400px). */
      async screenshot(path, { clipToContent = false } = {}) {
        await mkdir(dirname(path), { recursive: true })
        await pause(500)
        const params = { format: 'png', captureBeyondViewport: false }
        if (clipToContent) {
          const height = await evaluate('Math.ceil(Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0))')
          const clipHeight = Math.min(Math.max(height, currentViewport.height), 2400)
          Object.assign(params, {
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: currentViewport.width, height: clipHeight, scale: 1 },
          })
        }
        const image = await command('Page.captureScreenshot', params)
        await writeFile(path, Buffer.from(image.data, 'base64'))
        return path
      },
      /** Save into the `screenshots` directory under `name`; no-op when no directory was configured. */
      async capture(name) {
        if (!screenshots) return
        await browser.screenshot(join(screenshots, name))
      },
    }
    return browser
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}
