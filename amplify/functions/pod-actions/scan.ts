import { createWorker, type Worker } from 'tesseract.js'
import { imageSize } from 'image-size'
import { Jimp } from 'jimp'
import { mkdirSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { POD_SCAN_VERSION } from './scan-version.js'
import { scoreLegibility, type LegibilityResult } from './scan/legibility'
import {
  applyIlluminationCleanup,
  detectSkewAngle,
  findDocumentBoundary,
  jimpFromGray,
  jimpToGray,
  orthogonalRotate,
  rotateBilinear,
  warpPerspective,
  type JimpImage,
  type Point,
  type Quad,
} from './scan/geometry.js'

export { POD_SCAN_VERSION }

const MAX_INPUT_BYTES = 20 * 1024 * 1024
const MAX_PIXELS = 24_000_000
const MAX_EDGE = 2200
const MAX_PROCESS_EDGE = 1600
const MAX_OSD_EDGE = 1200
// A rotation must read at least this many real words, and score this many times
// higher than the next-best rotation, before the page is rotated on its evidence.
// Upside-down text still yields some plausible words (measured 14 vs 25 on a
// printed page) but at far lower confidence, so the score weighs both.
const MIN_ORIENTATION_WORDS = 6
const ORIENTATION_MARGIN = 2
// A document crop is kept only if it reads at least this share of the words the
// full frame read (a crop must never lose text), reads a few real words itself
// (so a logo or a label is never mistaken for the document) and covers at least
// this much of the frame.
const CROP_KEEP_RATIO = 0.9
const MIN_CROP_WORDS = 4
const MIN_CROP_AREA_SHARE = 0.04

export type PodScanReviewFlag =
  | 'ORIENTATION_UNCERTAIN'
  | 'GEOMETRY_UNCERTAIN'
  | 'TEXT_UNCERTAIN'
  | 'PERSPECTIVE_CLAMPED'
  // The cleanup worked and the page still cannot be read. A different kind of problem
  // from the others here: re-running the scan will not fix it, only a new photo will.
  | 'ILLEGIBLE'

export interface PodScanOrientation {
  /** Clockwise rotation detected by OSD prior to correction. */
  detectedDegrees: number | null
  /** Rotation actually applied to make text upright. */
  appliedCorrection: number
  confidence: number | null
  source: 'EXIF' | 'OCR_VOTE' | 'NONE'
}

export interface PodScanGeometry {
  confidence: 'high' | 'low' | 'none'
  skewAngleDeg: number | null
  /** Page corners in final output coordinates, in original-pixel scale. */
  cornerPoints: Point[] | null
  perspectiveCorrected: boolean
}

export interface PodScanResult {
  bytes: Buffer
  contentType: 'image/jpeg'
  scanVersion: number
  orientation: PodScanOrientation
  geometry: PodScanGeometry
  /** Every condition the pipeline noticed; for logs and tests. */
  flags: PodScanReviewFlag[]
  /** Plain-language reason a person should compare this copy with the original, or null. */
  scanReviewReason: string | null
  /*
   * Whether the finished page can be READ. Scored on the image a reader actually
   * receives — after cleanup, after resize — because that is the one that has to be
   * legible. Enhancement cannot add detail the camera never captured, and a page nobody
   * can read is worth saying so about while the driver is still at the dock.
   */
  legibility: LegibilityResult
}

function cloneJimp(image: JimpImage): JimpImage {
  return new Jimp({
    width: image.width,
    height: image.height,
    data: Buffer.from(image.bitmap.data),
  }) as JimpImage
}

// Lambda assets live in the layer under /opt (configured in amplify/podScanner.ts);
// local development and tests resolve the same packages from node_modules.
// A configured path that does not exist is a packaging error, never a CDN fallback.
function requireConfiguredPath(name: string, resolveLocal: () => string, check: (p: string) => string): string {
  const envPath = process.env[name]
  if (envPath) {
    const target = check(envPath)
    if (!existsSync(target)) throw new Error(`${name} points to a missing scanner asset: ${target}`)
    return envPath
  }
  return resolveLocal()
}

const localRequire = createRequire(import.meta.url)

function resolveEngLangPath(): string {
  return requireConfiguredPath(
    'POD_SCAN_ENG_PATH',
    () => join(dirname(localRequire.resolve('@tesseract.js-data/eng/package.json')), '4.0.0'),
    (p) => join(p, 'eng.traineddata.gz'),
  )
}

function resolveWorkerPath(): string {
  // The Node worker entry; the browser worker.min.js does not run under Node.
  return requireConfiguredPath(
    'POD_SCAN_WORKER_PATH',
    () => localRequire.resolve('tesseract.js/src/worker-script/node/index.js'),
    (p) => p,
  )
}

function resolveCorePath(): string {
  return requireConfiguredPath(
    'POD_SCAN_CORE_PATH',
    () => dirname(localRequire.resolve('tesseract.js-core/package.json')),
    (p) => join(p, 'package.json'),
  )
}

function resolveCachePath(): string {
  const envPath = process.env.POD_SCAN_CACHE_PATH
  if (envPath) {
    mkdirSync(envPath, { recursive: true })
    return envPath
  }
  return mkdtempSync(join(tmpdir(), 'tesseract-cache-'))
}

function isJpegOrPng(bytes: Buffer): { jpeg: boolean; png: boolean } {
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const png =
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  return { jpeg, png }
}

/**
 * Orientation is decided by OCR-ing the page at each of the four orthogonal
 * rotations and keeping the one that reads best. Tesseract's OSD module was
 * measured on a real BCAT bill of lading: it returned no orientation at all
 * ("Too few characters") for the upright page and a 3-6% confidence Katakana
 * guess for the sideways copies, so it cannot be trusted on phone photos.
 * OCR at the right rotation reads ~10x more real words than at the wrong one.
 */
interface OrientationReading {
  rotation: 0 | 90 | 180 | 270
  /** Real-looking words read at or above WORD_CONFIDENCE; background noise reads at ~20. */
  words: number
  confidence: number
}

// Pavement/floor texture OCRs into dozens of garbage tokens at ~20% confidence;
// genuine printed words on a page read at 60-95%. Counting only confident words
// makes "how much text is here" robust to noisy backgrounds.
const WORD_CONFIDENCE = 60

function countConfidentWords(blocks: Array<{ paragraphs: Array<{ lines: Array<{ words: Array<{ text: string; confidence: number }> }> }> }> | null): number {
  let words = 0
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          if (word.confidence >= WORD_CONFIDENCE && /^[A-Za-z][A-Za-z'&.,:-]{2,}$/.test(word.text)) words += 1
        }
      }
    }
  }
  return words
}

async function readOrientations(worker: Worker, image: JimpImage): Promise<OrientationReading[]> {
  const copy = cloneJimp(image)
  // Normalise to the OCR working size in both directions: a small MMS-compressed
  // crop reads far better upscaled (Tesseract wants ~30 px glyphs), and large
  // frames only need this much detail to count words.
  copy.scaleToFit({ w: MAX_OSD_EDGE, h: MAX_OSD_EDGE })
  // Read the cleaned page, not the raw photo: on a real bill of lading the
  // shadowed photo reads 18 words either way up while the cleaned copy reads
  // 125 upright vs 12 sideways. The output image is cleaned separately later.
  applyIlluminationCleanup(copy)
  const readings: OrientationReading[] = []
  for (const rotation of [0, 90, 180, 270] as const) {
    const candidate = rotation === 0 ? copy : orthogonalRotate(copy, rotation)
    const rec = await worker.recognize(await candidate.getBuffer('image/png'), {}, { text: false, blocks: true })
    readings.push({
      rotation,
      words: countConfidentWords(rec.data.blocks),
      confidence: rec.data.confidence ?? 0,
    })
  }
  return readings
}

/**
 * A crop is kept only when it cannot have lost text: it must read a few real words
 * itself and at least CROP_KEEP_RATIO of what the whole frame read. Measured on
 * real PODs: a sheared clipboard crop read 43 vs 82 (rejected); a small receipt on
 * pavement read 46 vs 0 confident frame words (kept).
 */
export function shouldKeepCrop(frameWords: number, cropWords: number): boolean {
  return cropWords >= MIN_CROP_WORDS && cropWords >= CROP_KEEP_RATIO * frameWords
}

const bestWords = (readings: OrientationReading[]): number => Math.max(...readings.map((r) => r.words))

/**
 * The reason a person should look at a scan, in their words - or null when the
 * copy needs no attention. Only conditions that change what staff will see are
 * reasons: geometry fallbacks still yield a clean, upright, uncropped photo, and
 * illumination cleanup is applied to every image, so neither is a reason.
 */
export function describeReviewReason(flags: PodScanReviewFlag[]): string | null {
  /*
   * Order is by how much the message tells someone, not by severity.
   *
   * TEXT_UNCERTAIN stays first: a page with no readable text at all is also illegible, but
   * that message says so AND explains why the page was left unrotated, which the
   * legibility one does not.
   *
   * ILLEGIBLE then outranks the geometry warnings, which say "we could not be sure we
   * straightened this", resolvable by looking at it. A page that cannot be read is not
   * fixable by looking — it needs a new photo.
   */
  if (flags.includes('TEXT_UNCERTAIN')) {
    return 'No readable text was found, so this may not be a document; the photo was cleaned but not rotated or cropped.'
  }
  if (flags.includes('ILLEGIBLE')) {
    return 'This page may not be readable. Check it against the original and ask for a new photo if needed.'
  }
  if (flags.includes('ORIENTATION_UNCERTAIN')) {
    return 'Could not confirm which way is up, so the photo was left as taken.'
  }
  return null
}

/**
 * Picks the upright rotation from the four readings. `applied` is the
 * counter-clockwise rotation to apply; `confident` is false when no rotation
 * reads clearly better than the runner-up, in which case nothing is rotated.
 */
export function chooseOrientation(readings: OrientationReading[]): {
  detectedDegrees: number | null
  applied: number
  confident: boolean
  sawText: boolean
} {
  const score = (r: OrientationReading) => r.words * Math.max(r.confidence, 1)
  const ranked = [...readings].sort((a, b) => score(b) - score(a))
  const best = ranked[0]
  const runnerUp = ranked[1]
  const sawText = best.words >= MIN_ORIENTATION_WORDS
  const confident = sawText && score(best) >= score(runnerUp) * ORIENTATION_MARGIN
  if (!confident) return { detectedDegrees: null, applied: 0, confident: false, sawText }
  // Reading best after rotating by R means the source was rotated by -R.
  const detectedDegrees = (360 - best.rotation) % 360
  return { detectedDegrees, applied: best.rotation, confident: true, sawText }
}

function applyOrthogonalRotation(image: JimpImage, correction: number): JimpImage {
  if (correction === 0) return image
  return orthogonalRotate(image, correction)
}

async function detectAndApplyDeskew(image: JimpImage): Promise<{
  image: JimpImage
  skewAngleDeg: number | null
  confidence: 'high' | 'low' | 'none'
}> {
  const copy = cloneJimp(image)
  if (Math.max(copy.width, copy.height) > MAX_PROCESS_EDGE) {
    copy.scaleToFit({ w: MAX_PROCESS_EDGE, h: MAX_PROCESS_EDGE })
  }
  const { width: w, height: h } = copy.bitmap
  const gray = jimpToGray(copy)
  const { angleDeg, confidence } = detectSkewAngle(gray, w, h)
  if (confidence === 'none' || Math.abs(angleDeg) < 0.25) {
    return { image, skewAngleDeg: confidence === 'none' ? null : angleDeg, confidence }
  }

  // Apply the same correction to the full-resolution image.
  const fullGray = jimpToGray(image)
  const rotated = rotateBilinear(fullGray, image.bitmap.width, image.bitmap.height, angleDeg)
  return {
    image: jimpFromGray(rotated.data, rotated.width, rotated.height),
    skewAngleDeg: angleDeg,
    confidence,
  }
}

function detectBoundary(image: JimpImage): {
  corners: Quad | null
  confidence: 'high' | 'low' | 'none'
} {
  const maxEdge = Math.min(MAX_PROCESS_EDGE, Math.max(image.bitmap.width, image.bitmap.height))
  const copy = cloneJimp(image)
  if (Math.max(copy.width, copy.height) > maxEdge) {
    copy.scaleToFit({ w: maxEdge, h: maxEdge })
  }
  const scaleX = image.bitmap.width / copy.width
  const scaleY = image.bitmap.height / copy.height
  const scale = Math.max(scaleX, scaleY)
  const { width: w, height: h } = copy.bitmap
  const gray = jimpToGray(copy)
  return findDocumentBoundary(gray, w, h, scale)
}

/** Detected edges land on the page border; a thin margin of background beats losing the outer characters. */
const CROP_PAD_SHARE = 0.02

function padQuad(quad: Quad, w: number, h: number): Quad {
  const pts = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft]
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4
  const pad = (p: Point): Point => ({
    x: Math.min(w - 1, Math.max(0, cx + (p.x - cx) * (1 + CROP_PAD_SHARE))),
    y: Math.min(h - 1, Math.max(0, cy + (p.y - cy) * (1 + CROP_PAD_SHARE))),
  })
  return { topLeft: pad(quad.topLeft), topRight: pad(quad.topRight), bottomRight: pad(quad.bottomRight), bottomLeft: pad(quad.bottomLeft) }
}

async function applyPerspectiveCorrection(image: JimpImage, detected: Quad): Promise<JimpImage> {
  const fullW = image.bitmap.width
  const fullH = image.bitmap.height
  const quad = padQuad(detected, fullW, fullH)
  const { topLeft, topRight, bottomRight, bottomLeft } = quad
  const topW = Math.hypot(topLeft.x - topRight.x, topLeft.y - topRight.y)
  const bottomW = Math.hypot(bottomLeft.x - bottomRight.x, bottomLeft.y - bottomRight.y)
  const leftH = Math.hypot(topLeft.x - bottomLeft.x, topLeft.y - bottomLeft.y)
  const rightH = Math.hypot(topRight.x - bottomRight.x, topRight.y - bottomRight.y)
  const dstW = Math.max(1, Math.round(Math.max(topW, bottomW)))
  const dstH = Math.max(1, Math.round(Math.max(leftH, rightH)))

  const fullGray = jimpToGray(image)
  const warped = warpPerspective(fullGray, fullW, fullH, quad, dstW, dstH)
  return jimpFromGray(warped, dstW, dstH)
}

/**
 * Remove shadows / uneven illumination while preserving faint handwriting.
 */
function correctIllumination(image: JimpImage): void {
  applyIlluminationCleanup(image)
}

async function finalize(image: JimpImage): Promise<Buffer> {
  if (Math.max(image.width, image.height) > MAX_EDGE) {
    image.scaleToFit({ w: MAX_EDGE, h: MAX_EDGE })
  }
  return await image.getBuffer('image/jpeg', { quality: 92 })
}

/**
 * Deterministic scan cleanup for incoming POD photos. Applies EXIF-aware
 * decoding, text-based orientation correction, deskew, perspective / page
 * boundary correction, and local illumination cleanup using only open-source
 * CPU methods (Jimp + Tesseract.js OSD/OCR). Original bytes are never
 * modified.
 *
 * Supports JPEG and PNG. Returns the original-as-is for unsupported content
 * types. Throws on malformed or over-limit images.
 */
export async function enhancePodImage(
  bytes: Buffer,
  contentType: string,
): Promise<PodScanResult | null> {
  if (bytes.length > MAX_INPUT_BYTES) throw new Error('Image exceeds the 20 MB scan limit')
  const { jpeg, png } = isJpegOrPng(bytes)
  if (!jpeg && !png) {
    if (/^image\/(jpeg|png)(;|$)/i.test(contentType)) {
      throw new Error('Invalid JPEG or PNG image')
    }
    return null
  }

  const { width, height } = imageSize(bytes)
  if (!width || !height || width * height > MAX_PIXELS || width > 16000 || height > 16000) {
    throw new Error('Image exceeds the 24 megapixel scan limit')
  }

  const image = await Jimp.read(bytes, {
    'image/jpeg': { maxResolutionInMP: 24, maxMemoryUsageInMB: 256 },
  })

  const review: PodScanReviewFlag[] = []

  // One OCR worker serves every reading in this scan.
  const worker = await createWorker('eng', 1, {
    workerPath: resolveWorkerPath(),
    corePath: resolveCorePath(),
    langPath: resolveEngLangPath(),
    cachePath: resolveCachePath(),
    logger: () => undefined,
    errorHandler: () => undefined,
  })
  let readings: OrientationReading[]
  let pageImage: JimpImage = image
  let perspectiveCorrected = false
  const boundary = detectBoundary(image)
  try {
    // 1. Crop to the document, but only on evidence. Edge detection on a phone
    // photo can lock onto a clipboard, a second sheet or a shadow and hand back a
    // sheared crop that drops half the page while reporting "high" confidence
    // (observed on a real POD). The frame is read first; a crop is kept only if
    // it reads at least as many words as the frame did, so a bad crop can never
    // lose text and a small receipt in a big frame is kept when it reads well.
    const frameReadings = await readOrientations(worker, image)
    readings = frameReadings
    if (boundary.corners) {
      try {
        const cropped = await applyPerspectiveCorrection(image, boundary.corners)
        const areaShare = (cropped.bitmap.width * cropped.bitmap.height) / (image.bitmap.width * image.bitmap.height)
        if (areaShare < MIN_CROP_AREA_SHARE) {
          review.push('PERSPECTIVE_CLAMPED')
        } else {
          const cropReadings = await readOrientations(worker, cropped)
          if (shouldKeepCrop(bestWords(frameReadings), bestWords(cropReadings))) {
            pageImage = cropped
            perspectiveCorrected = true
            readings = cropReadings
          } else {
            review.push('GEOMETRY_UNCERTAIN')
          }
        }
      } catch {
        review.push('GEOMETRY_UNCERTAIN')
      }
    }
  } finally {
    await worker.terminate()
  }
  const cornerPoints: Point[] | null = perspectiveCorrected && boundary.corners
    ? [boundary.corners.topLeft, boundary.corners.topRight, boundary.corners.bottomRight, boundary.corners.bottomLeft]
    : null

  // 2. Determine the upright orientation from what was read.
  const vote = chooseOrientation(readings)
  const bestReading = readings.find((r) => r.rotation === vote.applied) ?? readings[0]
  if (!vote.sawText) review.push('TEXT_UNCERTAIN')
  if (!vote.confident) review.push('ORIENTATION_UNCERTAIN')
  const orientation: PodScanOrientation = {
    detectedDegrees: vote.detectedDegrees,
    appliedCorrection: vote.applied,
    confidence: vote.sawText ? bestReading.confidence : null,
    source: vote.confident ? 'OCR_VOTE' : 'NONE',
  }

  if (orientation.appliedCorrection !== 0) {
    pageImage = applyOrthogonalRotation(pageImage, orientation.appliedCorrection)
  }

  // 3. Straighten the page / photo.
  const deskew = await detectAndApplyDeskew(pageImage)
  const workingImage = deskew.image
  if (deskew.confidence === 'none' && Math.abs(deskew.skewAngleDeg ?? 0) > 0.5) {
    review.push('GEOMETRY_UNCERTAIN')
  } else if (deskew.confidence === 'low') {
    review.push('GEOMETRY_UNCERTAIN')
  }

  if (boundary.confidence !== 'high' && !perspectiveCorrected) {
    review.push('GEOMETRY_UNCERTAIN')
  }

  // 4. Local illumination cleanup; preserves faint handwriting.
  correctIllumination(workingImage)

  const outBytes = await finalize(workingImage)

  /*
   * 5. Is it readable? Measured on the FINISHED page — re-read from the bytes we are
   * about to store, so the score describes what the office and the broker will see,
   * including the downscale `finalize` may have applied.
   */
  const finished = await Jimp.read(outBytes)
  const legibility = scoreLegibility(jimpToGray(finished), finished.width, finished.height)
  if (legibility.legibility !== 'OK') review.push('ILLEGIBLE')
  const geometry: PodScanGeometry = {
    confidence: boundary.confidence,
    skewAngleDeg: deskew.skewAngleDeg,
    cornerPoints,
    perspectiveCorrected,
  }

  return {
    bytes: outBytes,
    contentType: 'image/jpeg',
    scanVersion: POD_SCAN_VERSION,
    orientation,
    geometry,
    flags: review,
    scanReviewReason: describeReviewReason(review),
    legibility,
  }
}
