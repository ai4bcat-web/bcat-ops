/**
 * Shared scanner pipeline version. Bump whenever the detection/correction rules
 * change; every stored image below this version is re-scanned by the backfill
 * (originals and assignments are kept, only the cleaned copy is regenerated).
 *
 * 2: OCR-vote orientation, evidence-gated cropping, luminance (not red channel).
 * 3: review reason is a plain-language sentence, only for conditions worth a look.
 * 4: crop quad padded 2% outward so edge characters survive.
 */
export const POD_SCAN_VERSION = 4
