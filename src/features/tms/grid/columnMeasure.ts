/**
 * A column's default width is the width of its header label: the label set in the grid's header
 * font (uppercased, letter-spaced) plus the cell padding and the sort and filter controls that
 * sit beside it. Measured once per label and font with a canvas, so no number is hard-coded
 * per column; a floor keeps a one-letter header usable.
 */

/** Never default narrower than this, whatever the label. */
export const HEADER_WIDTH_FLOOR = 72

/** Header cell padding (6 + 6), the resize grip and the border. */
const CELL_CHROME_PX = 12 + 6 + 1
/** The sort arrow and its gap. */
const SORT_ICON_PX = 11 + 3
/** The header filter button and its gap. */
const FILTER_ICON_PX = 18 + 2
/** Header letter-spacing (0.02em) at the header size. */
const LETTER_SPACING_EM = 0.02
/** Per-character estimate when no canvas exists (jsdom, SSR). */
const FALLBACK_CHAR_PX = 7.4
/** Safety slack so the last glyph never touches the sort arrow. */
const SLACK_PX = 4

const FALLBACK_FONT = '600 11px system-ui, sans-serif'

let canvas: HTMLCanvasElement | null = null
const cache = new Map<string, number>()

/** The font a grid header is drawn in, read off a mounted header cell when there is one. */
export function headerFont(): string {
  if (typeof document === 'undefined') return FALLBACK_FONT
  // Before the first header exists, the header style on the page's own font family.
  const th = document.querySelector('.tms-dg-table thead th')
  const style = window.getComputedStyle(th ?? document.body)
  if (!style.fontFamily) return FALLBACK_FONT
  return th ? `${style.fontWeight} ${style.fontSize} ${style.fontFamily}` : `600 11px ${style.fontFamily}`
}

function fontSizePx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font)
  return m ? Number.parseFloat(m[1]) : 11
}

function context(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return null
  // jsdom ships a canvas stub that logs "not implemented"; it can never measure.
  if (/jsdom/i.test(navigator.userAgent)) return null
  canvas ??= document.createElement('canvas')
  return canvas.getContext('2d')
}

/** The rendered width of `label` (uppercase, letter-spaced) in `font`, cached per label and font. */
export function measureHeaderText(label: string, font: string = headerFont()): number {
  const key = `${font}\u0000${label}`
  const hit = cache.get(key)
  if (hit != null) return hit
  const text = label.toUpperCase()
  const ctx = context()
  let width: number
  if (ctx) {
    ctx.font = font
    width = ctx.measureText(text).width + text.length * fontSizePx(font) * LETTER_SPACING_EM
  } else {
    width = text.length * FALLBACK_CHAR_PX
  }
  cache.set(key, width)
  return width
}

/** The default width of a header: label + padding + the controls it carries, never under the floor. */
export function headerDefaultWidth(
  label: string,
  controls: { sortable: boolean; filterable: boolean },
  font: string = headerFont(),
): number {
  const px =
    measureHeaderText(label, font) +
    CELL_CHROME_PX +
    SLACK_PX +
    (controls.sortable ? SORT_ICON_PX : 0) +
    (controls.filterable ? FILTER_ICON_PX : 0)
  return Math.max(HEADER_WIDTH_FLOOR, Math.ceil(px))
}
