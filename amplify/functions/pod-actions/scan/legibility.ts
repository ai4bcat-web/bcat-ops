/**
 * Can this page actually be READ?
 *
 * Enhancement makes a photo look better; it cannot put back detail the camera never
 * captured. A POD shot in a dark cab, at arm's length, out of focus, or of a page folded
 * in half comes out of the cleanup looking crisp and white and is still unreadable — and
 * nobody finds out until a broker rejects the invoice a fortnight later, by which time the
 * driver is three states away and the paper is gone.
 *
 * So the page is scored while the driver is still standing at the dock, for Ivan's drivers
 * and the owner operators alike. Three things are measured, because they fail
 * independently and a driver can act on each one differently:
 *
 *   FOCUS     variance of the Laplacian. Flat response = nothing in focus. This is the
 *             one that catches a moving-truck photo.
 *   INK       fraction of pixels that are neither paper nor noise. Near zero means a
 *             blank or blown-out page; very high means a shadow, a thumb, or a photo of
 *             the dark side of a clipboard.
 *   DETAIL    pixels across the page's short edge. A POD photographed from two feet away
 *             has plenty of focus and plenty of ink and still cannot resolve a signature.
 *
 * Scored on the GREYSCALE, POST-cleanup page, which is what a reader actually receives.
 * Pure: no Jimp, no I/O, no clock — a width, a height, and the bytes.
 */

export type Legibility = 'OK' | 'LOW' | 'UNREADABLE' | 'UNKNOWN'

export interface LegibilityResult {
  legibility: Legibility
  /** 0-100. The lowest of the three sub-scores: a page is only as readable as its worst axis. */
  score: number
  /** Plain words for the driver. Empty when the page is fine. */
  notes: string
  detail: { focus: number; ink: number; resolution: number }
}

/*
 * Thresholds.
 *
 * Calibrated to be QUIET. A false "unreadable" trains a driver to ignore the warning and
 * re-shoot a page that was fine, so the bar for complaining is deliberately low: these
 * numbers flag the photo nobody could read, not the merely mediocre one. Every POD in this
 * system is a printed form photographed on a phone, which is a narrow enough class of
 * image to put absolute numbers on.
 */

/** Laplacian variance on a well-shot page runs in the hundreds; a blurred one in the low tens. */
const FOCUS_BAD = 12
const FOCUS_GOOD = 90

/** A POD covers a few percent of its page in ink. Below a half percent there is nothing there. */
const INK_MIN_BAD = 0.004
const INK_MIN_GOOD = 0.02
/** Past about a third the frame is a shadow or an obstruction, not writing. */
const INK_MAX_GOOD = 0.34
const INK_MAX_BAD = 0.55

/*
 * Short edge of the finished page, in pixels.
 *
 * A deliberately low bar. Raw page size is only a proxy for the thing that matters —
 * whether the TEXT resolves — and the two come apart: a 700px scan of a form set in large
 * type reads fine, while a 2000px photo of a page covered in 6pt print does not. An
 * earlier, stricter version of this failed the pipeline's own 1000x700 and 800x600 test
 * pages, which are perfectly readable. So this catches only what is unambiguously too
 * small to resolve handwriting, and focus and ink carry the rest of the judgement.
 */
const RES_BAD = 320
const RES_GOOD = 640

/** Linear 0-100 ramp between a failing and a passing value, clamped. */
function ramp(value: number, bad: number, good: number): number {
  if (good === bad) return value >= good ? 100 : 0
  const t = (value - bad) / (good - bad)
  return Math.max(0, Math.min(100, Math.round(t * 100)))
}

/**
 * Variance of the 4-neighbour Laplacian — the standard focus measure.
 *
 * Sampled on a grid rather than every pixel: a POD is multi-megapixel, this runs inside
 * the upload path, and focus is a property of the whole page. The step is chosen to take
 * roughly 200k samples whatever the image size, so the number means the same thing for a
 * phone photo and a flatbed scan.
 */
export function laplacianVariance(gray: Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0
  const interior = (width - 2) * (height - 2)
  const step = Math.max(1, Math.floor(Math.sqrt(interior / 200_000)))

  let n = 0
  let sum = 0
  let sumSq = 0
  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < width - 1; x += step) {
      const p = y * width + x
      const lap =
        4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - width] - gray[p + width]
      sum += lap
      sumSq += lap * lap
      n += 1
    }
  }
  if (n === 0) return 0
  const mean = sum / n
  return Math.max(0, sumSq / n - mean * mean)
}

/**
 * Fraction of the page that is ink.
 *
 * Measured against the page's own paper level rather than a fixed cut: the cleanup leaves
 * paper near white but not AT white, and a fixed threshold would read a slightly grey scan
 * as entirely covered in ink. The paper level is the 90th percentile — the same statistic
 * the illumination pass uses — and ink is anything meaningfully darker than it.
 */
export function inkFraction(gray: Uint8Array): number {
  if (gray.length === 0) return 0
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1

  const target = gray.length * 0.9
  let seen = 0
  let paper = 255
  for (let v = 0; v < 256; v += 1) {
    seen += hist[v]
    if (seen >= target) {
      paper = v
      break
    }
  }

  // 30 levels below paper: past the cleanup's residual noise, short of light pencil.
  const cut = Math.max(0, paper - 30)
  let ink = 0
  for (let v = 0; v <= cut; v += 1) ink += hist[v]
  return ink / gray.length
}

export function scoreLegibility(
  gray: Uint8Array,
  width: number,
  height: number,
): LegibilityResult {
  if (!width || !height || gray.length < width * height) {
    return {
      legibility: 'UNKNOWN',
      score: 0,
      notes: '',
      detail: { focus: 0, ink: 0, resolution: 0 },
    }
  }

  const variance = laplacianVariance(gray, width, height)
  const ink = inkFraction(gray)
  const shortEdge = Math.min(width, height)

  const focusScore = ramp(variance, FOCUS_BAD, FOCUS_GOOD)
  const resolutionScore = ramp(shortEdge, RES_BAD, RES_GOOD)
  // Ink is two-sided: too little and too much are both unreadable.
  const inkScore =
    ink < INK_MIN_GOOD
      ? ramp(ink, INK_MIN_BAD, INK_MIN_GOOD)
      : ink > INK_MAX_GOOD
        ? ramp(ink, INK_MAX_BAD, INK_MAX_GOOD)
        : 100

  const score = Math.min(focusScore, inkScore, resolutionScore)

  /*
   * The note names what to DO, in the order worth doing it. A driver who is told "score
   * 31" re-sends the same photo; one told "hold the phone still" takes a different one.
   */
  const reasons: string[] = []
  if (focusScore < 50) reasons.push('the photo is blurry — hold still and tap to focus')
  if (inkScore < 50 && ink <= INK_MIN_GOOD) reasons.push('the page looks blank or washed out')
  if (inkScore < 50 && ink >= INK_MAX_GOOD) reasons.push('something is covering the page, or it is in shadow')
  if (resolutionScore < 50) reasons.push('get closer so the whole page fills the frame')

  const legibility: Legibility = score < 35 ? 'UNREADABLE' : score < 60 ? 'LOW' : 'OK'

  return {
    legibility,
    score,
    notes: legibility === 'OK' ? '' : reasons.join('; '),
    detail: { focus: focusScore, ink: inkScore, resolution: resolutionScore },
  }
}
