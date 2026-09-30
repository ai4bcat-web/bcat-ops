/**
 * Normalisation helpers for TMS directory entities.
 *
 * Rules mirror the design doc:
 * - lower, trim, collapse whitespace
 * - strip punctuation except letters/digits/spaces
 * - drop common legal suffixes for customer names
 * - treat '&' as 'and'
 * - city normalisation strips leading/trailing spaces, lowercases, removes decorative punctuation
 */

const LEGAL_SUFFIXES = new Set([
  'llc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'ltd',
  'limited',
  'co',
  'company',
  'lp',
  'llp',
  'dba',
  'doing business as',
]);

const IGNORED_FOR_ALIASES = new Set([
  'a', 'an', 'the', 'of', 'for', 'and',
]);

/**
 * @param {string | null | undefined} raw
 * @returns {string}
 */
export function trimString(raw) {
  return (raw ?? '').trim();
}

/**
 * Lower, strip punctuation, expand ampersands, collapse whitespace.
 * @param {string | null | undefined} raw
 * @returns {string}
 */
export function normalizeText(raw) {
  return trimString(raw)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Drop common legal suffix words and stop words from the tail of a normalised name.
 * @param {string} normalized
 * @param {boolean} keepStopWords
 * @returns {string}
 */
function dropSuffixes(normalized, keepStopWords = false) {
  const words = normalized.split(/\s+/).filter(Boolean);
  const filtered = words.filter((w, i) => {
    if (LEGAL_SUFFIXES.has(w)) return false;
    if (!keepStopWords && i !== 0 && IGNORED_FOR_ALIASES.has(w)) return false;
    return true;
  });
  return filtered.join(' ').trim();
}

/**
 * Normalise a customer name for matching.
 * @param {string | null | undefined} raw
 * @returns {string}
 */
export function normalizeCustomerName(raw) {
  return dropSuffixes(normalizeText(raw));
}

/**
 * Normalise a location/facility name for matching.
 * Keeps stops words (e.g. "of") because facility names like "Port of Chicago" matter.
 * @param {string | null | undefined} raw
 * @returns {string}
 */
export function normalizeLocationName(raw) {
  return dropSuffixes(normalizeText(raw), true);
}

/**
 * Normalise a city field like "Chicago, IL" or "DALLAS, TX".
 * @param {string | null | undefined} raw
 * @returns {string}
 */
export function normalizeCity(raw) {
  return trimString(raw)
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9\s,\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {{name?: string | null, city?: string | null}} stop
 * @returns {string}
 */
export function stopMatchKey({ name, city }) {
  return `${normalizeLocationName(name)}|${normalizeCity(city)}`;
}

/**
 * Pick a canonical display name from a list of raw variations.
 * Uses the most common trimmed raw form; falls back to first.
 * @param {string[]} variants
 * @returns {string}
 */
export function pickCanonicalName(variants) {
  if (variants.length === 0) return '';
  const counts = new Map();
  for (const v of variants) {
    const trimmed = trimString(v);
    if (!trimmed) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  let best = variants[0];
  let bestCount = -1;
  for (const [name, count] of counts.entries()) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return trimString(best);
}

/**
 * Return a list of aliases for a customer: trimmed raw variants other than the canonical.
 * @param {string} canonical
 * @param {string[]} variants
 * @returns {string[]}
 */
export function buildAliases(canonical, variants) {
  const set = new Set();
  const cTrim = trimString(canonical).toLowerCase();
  for (const v of variants) {
    const t = trimString(v);
    if (!t || t.toLowerCase() === cTrim) continue;
    set.add(t);
  }
  return [...set];
}
