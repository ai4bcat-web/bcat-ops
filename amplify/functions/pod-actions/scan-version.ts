/**
 * Shared scanner pipeline version. Bump whenever the detection/correction rules
 * change; every stored image below this version is re-scanned by the backfill
 * (originals and assignments are kept, only the cleaned copy is regenerated).
 *
 * 2: OCR-vote orientation, evidence-gated cropping, luminance (not red channel).
 * 3: review reason is a plain-language sentence, only for conditions worth a look.
 * 4: crop quad padded 2% outward so edge characters survive.
 * 5: illumination divided out over a wide field, then a levels stretch and a light
 *    unsharp mask. The narrow field used before averaged over the text itself, so dense
 *    small print was flattened to white — cleaned PODs read worse than the photographs
 *    they came from.
 * 6: the lighting field is the local PAPER level (a high percentile per tile) rather than
 *    a local mean. A mean is dragged down by dense text and, at the edge of a page held in
 *    someone's hand, mixed paper with the hand — so a shaded margin divided to nothing and
 *    was crushed to solid black, taking whole address blocks with it.
 */
export const POD_SCAN_VERSION = 6
