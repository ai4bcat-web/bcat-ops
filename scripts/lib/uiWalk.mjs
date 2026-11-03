/**
 * Shared in-page audit + walk helpers for the dev verification scripts (S3, S4).
 * Moved out of devVerifyS3.mjs unchanged; only the per-script state (screenshot dir, allow-lists,
 * `--only` filter, report) is now supplied by `createWalk` instead of module constants.
 * Dev only: the callers refuse every non-dev origin before they launch a browser.
 */
import { join } from 'node:path'
import { auditInPage, auditFailures } from '../devVerifyS2.mjs'
import { pause } from './cdpBrowser.mjs'

/** Legacy colours that S3 bans on top of S2's list. Serialised into the page. */
export function extraAuditInPage(opts) {
  const TEXT_BANNED = new Set(opts.extraBanned)
  const SURFACE = new Set(opts.extraBannedSurface)
  const EXCLUDE = '.gm-style, iframe, [data-tms-paper], [data-user-color], [data-camera], .tms-chart-tip, #recharts_measurement_span, .tms-count-badge'
  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '')
    if (!m) return null
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
    return { r, g, b, a }
  }
  const norm = (c) => `rgb(${c.r}, ${c.g}, ${c.b})`
  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}`
  }
  const out = []
  for (const el of document.body.querySelectorAll('*')) {
    if (out.length >= 3) break
    if (el.closest(EXCLUDE)) continue
    const cs = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    if (!(rect.width > 0 && rect.height > 0) || cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.01) continue
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    const checks = []
    if (hasText) checks.push(['color', cs.color])
    const bg = parse(cs.backgroundColor)
    if (bg && bg.a > 0.5) checks.push(['background-color', cs.backgroundColor, 'bg'])
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (parseFloat(cs[`border-${side}-width`]) > 0 && cs[`border-${side}-style`] !== 'none') checks.push([`border-${side}-color`, cs[`border-${side}-color`]])
    }
    if (el instanceof SVGElement) { checks.push(['fill', cs.fill]); checks.push(['stroke', cs.stroke]) }
    for (const [prop, value, kind] of checks) {
      const c = parse(value)
      if (!c || c.a < 0.5) continue
      const key = norm(c)
      if (TEXT_BANNED.has(key) || (kind === 'bg' && SURFACE.has(key))) {
        // Driver/broker/unassigned palette colours (src/lib/driverColors.ts) are data, applied inline.
        const inline = el.getAttribute('style') || ''
        if (inline.includes(key) || inline.includes(`rgb(${c.r},${c.g},${c.b})`)) continue
        out.push(`${describe(el)} ${prop} ${key}`); break
      }
    }
  }
  return out
}

const rgbList = (list) => list.map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`)
export const EXTRA_BANNED = rgbList([
  [30, 168, 243], [59, 181, 245], [13, 143, 217], [11, 143, 217], [3, 105, 161], [230, 244, 253], [56, 189, 248], [125, 211, 252],
  [248, 250, 252], [241, 245, 249], [226, 232, 240], [203, 213, 225], [148, 163, 184], [100, 116, 139], [71, 85, 105], [51, 65, 85], [30, 41, 59], [15, 23, 42],
])
export const EXTRA_SURFACE = rgbList([[241, 244, 249], [231, 236, 244], [7, 18, 43], [11, 18, 32], [20, 31, 54], [28, 41, 66], [46, 61, 91], [6, 10, 18], [11, 19, 34]])

/** Shell geometry + structural parity facts, evaluated in the page. */
export const SHELL_FACTS = `(() => {
  const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map((v) => Math.round(v)); };
  return {
    sidebar: r('.tms-sidebar'), topbar: r('.tms-topbar'),
    asides: document.querySelectorAll('aside.tms-sidebar').length,
    legacyNodes: ['.sidebar', '.topbar', '.app', '.menu-btn'].filter((s) => document.querySelector(s)),
    toggle: !!document.querySelector('.tms-theme-toggle, [aria-label^="Switch to"]'),
    logout: !!document.querySelector('button[aria-label="Log out"]'),
    host: !!document.querySelector('.tms-legacy-host'),
    docH: document.documentElement.scrollHeight, winH: window.innerHeight,
    docW: document.documentElement.scrollWidth, winW: document.documentElement.clientWidth,
    themeAttr: document.documentElement.getAttribute('data-tms-theme'),
  };
})()`

export const TOKEN_PROBE = `(() => {
  const cs = getComputedStyle(document.documentElement);
  const shell = document.querySelector('.tms-shell, .tms-portal') ?? document.body;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;background:var(--tms-bg)';
  shell.appendChild(probe);
  const bg = getComputedStyle(probe).backgroundColor; probe.remove();
  return {
    tmsBg: cs.getPropertyValue('--tms-bg').trim(), dsT1: cs.getPropertyValue('--ds-t1').trim(),
    dsBg: cs.getPropertyValue('--ds-bg').trim(), shSm: cs.getPropertyValue('--sh-sm').trim(),
    probeBg: bg, bodyBg: getComputedStyle(document.body).backgroundColor,
  };
})()`

// width may differ by a classic scrollbar (<= 17px) depending on whether the page's own scroller shows one
export const sameRect = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= (i === 2 ? 17 : 1))

/**
 * Shell parity + token failures from SHELL_FACTS / TOKEN_PROBE results. `ref` = the /tms/dashboard
 * facts of the same theme (rect parity is skipped while it is empty). `legacyHost: false` for pages that
 * live under /tms and therefore have no `.tms-legacy-host` wrapper.
 */
export function shellFailures(f, t, ref = {}, { legacyHost = true } = {}) {
  const failures = []
  if (legacyHost && !f.host) failures.push('.tms-legacy-host missing')
  if (f.asides !== 1) failures.push(`aside.tms-sidebar count ${f.asides}`)
  if (f.legacyNodes.length) failures.push(`legacy shell nodes present: ${f.legacyNodes.join(', ')}`)
  if (!f.toggle) failures.push('theme toggle missing')
  if (!f.logout) failures.push('Log out button missing')
  if (ref.sidebar && !sameRect(f.sidebar, ref.sidebar)) failures.push(`.tms-sidebar rect ${JSON.stringify(f.sidebar)} != /tms/dashboard ${JSON.stringify(ref.sidebar)}`)
  if (ref.topbar && !sameRect(f.topbar, ref.topbar)) failures.push(`.tms-topbar rect ${JSON.stringify(f.topbar)} != /tms/dashboard ${JSON.stringify(ref.topbar)}`)
  if (f.docH > f.winH + 2) failures.push(`page scrolls vertically (${f.docH} > ${f.winH})`)
  if (f.docW > f.winW + 2) failures.push(`page overflows horizontally (${f.docW} > ${f.winW})`)
  if (!t.tmsBg) failures.push('--tms-bg empty on :root')
  if (t.dsT1 || t.dsBg || t.shSm) failures.push(`unmigrated tokens resolve on :root: ${['--ds-t1', '--ds-bg', '--sh-sm'].filter((k, i) => [t.dsT1, t.dsBg, t.shSm][i]).join(', ')}`)
  if (t.probeBg !== t.bodyBg) failures.push(`body background ${t.bodyBg} != --tms-bg ${t.probeBg}`)
  return failures
}

/**
 * Per-script walk state: report lines, screenshots written, and the helpers that depend on them.
 * @param {{ shots: string, allowProblems?: {pattern: RegExp, reason: string}[], hookClasses?: string[],
 *           skipAllowed?: Record<string,string>, only?: string }} options
 */
export function createWalk({ shots, allowProblems = [], hookClasses = [], skipAllowed = {}, only } = {}) {
  const matches = (id) => !only || id.includes(only)
  const report = []
  const written = []
  const line = (status, name, detail) => {
    report.push({ status, name, detail })
    console.log(`${status.padEnd(7)}${name}${detail ? ` — ${detail}` : ''}`)
  }
  const allowedProblem = (text) => allowProblems.some((a) => a.pattern.test(text))
  const skipLine = (id, theme, why, allowed) => {
    if (allowed || skipAllowed[id]) line('SKIPPED', `${id} ${theme}`, `(allowed: ${allowed ?? skipAllowed[id]}) ${why ?? ''}`)
    else line('SKIPPED', `${id} ${theme}`, `(no data: ${why})`)
  }

  const hookJson = JSON.stringify({ hookClasses, extraBanned: EXTRA_BANNED, extraBannedSurface: EXTRA_SURFACE })

  async function audit(b, theme, { wideOk = false, shell = true } = {}) {
    const base = await b.evaluate(`(${auditInPage})(${JSON.stringify({ theme, wideOk, hookClasses })})`)
    const extra = await b.evaluate(`(${extraAuditInPage})(${hookJson})`)
    // currentColor borders: tinted badges set border-[color:var(--tms-badge-*)] equal to their text on purpose
    const fails = auditFailures(base).filter((f) => !f.startsWith('currentColor borders'))
    if (!shell) return [...fails.filter((f) => !/^layout: \.tms-main/.test(f) && !/^layout: \.tms-shell/.test(f)), ...extra.map((x) => `legacy token: ${x}`)]
    return [...fails, ...extra.map((x) => `legacy token: ${x}`)]
  }

  async function shot(b, nn, slug, theme, clipToContent = true) {
    const file = join(shots, `${nn}-${slug}-${theme}.png`)
    await b.screenshot(file, { clipToContent })
    written.push(file)
  }

  function problemList(b) {
    const p = b.problems()
    return [
      ...p.exceptions.map((x) => `exception: ${x}`),
      ...p.consoleErrors.map((x) => `console error: ${x}`),
      ...p.httpErrors.map((x) => `HTTP ${x}`),
      ...p.failedRequests.map((x) => `request failed: ${x}`),
    ].filter((x) => !allowedProblem(x))
  }

  async function conclude(b, id, theme, nn, slug, failures, clip = true) {
    await shot(b, nn, slug, theme, clip).catch((e) => failures.push(`screenshot failed: ${e.message}`))
    if (failures.length) line('FAIL', `${id} ${theme}`, failures.slice(0, 3).join(' | '))
    else line('PASS', `${id} ${theme}`)
  }

  async function waitLoaded(b) {
    await b.poll(() => b.evaluate(`(() => {
      const main = document.querySelector('.tms-main');
      if (!main || !main.children.length || !main.innerText.trim()) return false;
      return !/(^|\\s)Loading(…|\\.\\.\\.)?(\\s|$)/.test(main.innerText);
    })()`), 'content without a Loading spinner', 30_000)
    await pause(300)
  }

  async function waitBody(b, ms = 20_000) {
    await b.poll(() => b.evaluate(`(() => {
      const t = document.body.innerText.trim();
      return t.length > 10 && !/(^|\\s)Loading(…|\\.\\.\\.)?(\\s|$)/.test(t);
    })()`), 'page content', ms).catch(() => {})
    await pause(1200)
  }

  async function setTheme(b, theme) {
    const current = await b.evaluate(`document.documentElement.getAttribute('data-tms-theme') === 'dark' ? 'dark' : 'light'`)
    if (current === theme) return
    const label = theme === 'dark' ? 'Switch to dark theme' : 'Switch to light theme'
    await b.click({ selector: `[aria-label="${label}"]` })
    await b.poll(() => b.evaluate(`(document.documentElement.getAttribute('data-tms-theme') === 'dark' ? 'dark' : 'light') === ${JSON.stringify(theme)}`), `theme ${theme}`, 10_000)
  }

  return { matches, line, report, written, skipLine, allowedProblem, hookJson, problemList, audit, waitLoaded, waitBody, setTheme, shot, conclude, SHELL_FACTS, TOKEN_PROBE, EXTRA_BANNED, EXTRA_SURFACE }
}
