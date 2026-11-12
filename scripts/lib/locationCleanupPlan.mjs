/**
 * Pure planning for awLocationCleanup.mjs (no I/O). Input: the raw Location and Load rows; output: what a cleanup would do.
 *
 * Classes (only LIVE rows count: active !== false, no mergedIntoId, no mergeJobId):
 *   ARCHIVE         no STREET (a city or a zip alone is not an address) AND unreferenced (no load holds it as a stop by locationId, no load
 *                   carries its name as origin/destination, no contact / driver note / appointment data; a customer link alone does not
 *                   block it, the link is kept in the audit row)
 *   MERGE (same place) same place under one address: same street number + street (abbreviations and directions ignored) + zip, and the
 *                   names equal or one a prefix of the other (Aljex truncates names at 22 characters). The survivor keeps the id, the others
 *                   are frozen the way MERGE_LOCATIONS freezes a source (mergedIntoId, mergeJobId, active=false) and every Load stop that
 *                   points at one is repointed to the survivor.
 *   MERGE (fold)    same normalized name + same city/state, one row has NO street: when every addressed row of that name+city shares ONE
 *                   address, the street-less row is folded into that survivor, otherwise it is REVIEW (ambiguous).
 *   REVIEW_*        never written: address-less but referenced / carrying data, ambiguous fold, possible typo variants, same address under
 *                   different names.
 * Soft only: nothing is ever hard-deleted. A survivor is only ENRICHED (blank scalar fields filled from the sources, customerIds /
 * aliases / contacts / driverNotes unioned); a field both rows hold with different values is reported, never overwritten.
 */
import { countReferences, loadStops, normalizeAddress, normalizeName } from '../awLocationRename.mjs';

const blank = (v) => (v == null ? '' : String(v).trim());
const arr = (v) => (Array.isArray(v) ? v : []);

/** Scalar fields copied from a source onto a survivor only while the survivor's own value is empty. */
export const ENRICH_FIELDS = [
  'apptContactName', 'apptContactEmail', 'apptContactPhone', 'notes', 'hours', 'apptRule', 'apptLeadTimeHours', 'dockNotes', 'lumperNotes',
  'detentionNotes', 'facilityType', 'timezone', 'customerName',
];
/** Geocode proof travels as one unit: copied together, and only when the survivor has no pin of its own. */
export const GEO_FIELDS = ['lat', 'lng', 'placeId', 'geohash6', 'geocodedAt', 'geocodeExpiresAt'];
/** Array fields the survivor gains the union of. */
export const UNION_FIELDS = ['customerIds', 'aliases'];
export const JSON_UNION_FIELDS = ['contacts', 'driverNotes'];

const SYSTEM_NOTE = /^(imported from aljex|inactive aljex customer|seeded from \d+ historical load)/i;
export const isLive = (l) => l.active !== false && !l.mergedIntoId && !l.mergeJobId;
export const hasStreet = (l) => blank(l.street) !== '';
export const hasNoAddress = (l) => !blank(l.street);
const fullAddressKey = (l) => normalizeAddress({ street: blank(l.street), city: blank(l.city), state: blank(l.state), zip: blank(l.zip), country: '' });

/** Aljex stored "WILMINGTON, IL" in the city column with no state: split it so name+city keys line up. */
export function cityState(l) {
  const city = blank(l.city);
  const m = /^(.*?),\s*([A-Za-z]{2})$/.exec(city);
  return m ? { city: m[1].trim(), state: blank(l.state) || m[2].toUpperCase() } : { city, state: blank(l.state) };
}
const cityKey = (l) => { const c = cityState(l); return `${normalizeName(c.city)}|${normalizeName(c.state)}`; };

const SUFFIX = { avenue: 'ave', av: 'ave', street: 'st', str: 'st', road: 'rd', drive: 'dr', boulevard: 'blvd', highway: 'hwy', parkway: 'pkwy', lane: 'ln', court: 'ct', place: 'pl', circle: 'cir', terrace: 'ter', trail: 'trl' };
const DIRECTION = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest']);
/** "654 W FACTORY ROAD" and "654 FACTORY RD." -> "654 factory rd". Directions and punctuation dropped, suffixes canonical. */
export function streetKey(street) {
  const t = blank(street).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).filter((w, i) => i === 0 || !DIRECTION.has(w)).map((w) => SUFFIX[w] ?? w);
  return t.join(' ');
}
const streetNumber = (street) => (/^\s*(\d+[a-z]?)\b/i.exec(blank(street)) ?? [])[1]?.toLowerCase() ?? '';
const zip5 = (l) => (/\d{5}/.exec(blank(l.zip)) ?? [])[0] ?? '';
/** Same name, or one a (>= 8 character) prefix of the other: Aljex cut names at 22 characters. */
export function nameRelated(a, b) {
  const x = normalizeName(blank(a)); const y = normalizeName(blank(b));
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 8 && long.startsWith(`${short} `) || (short.length >= 8 && long.startsWith(short));
}

/** Anything a person typed or a driver wrote on the row: archiving it unreferenced would still lose this. */
function carriesData(l) {
  return arr(l.contacts).length > 0 || arr(l.driverNotes).length > 0
    || [l.apptContactName, l.apptContactEmail, l.apptContactPhone, l.notes, l.hours, l.dockNotes, l.lumperNotes, l.detentionNotes].some((v) => blank(v) !== '');
}

function usage(refs, id) {
  const r = refs.get(id) ?? { stopLoads: new Set(), stopRows: 0, nameLoads: new Set(), shipments: new Set() };
  return { stopLoads: r.stopLoads.size, stopRows: r.stopRows, nameLoads: r.nameLoads.size, shipments: r.shipments.size };
}

/** Survivor = most loads pointing at it by id, then a geocoded row, then the oldest, then the id (stable). */
export function pickSurvivor(rows, refs) {
  return [...rows].sort((a, b) => {
    const ua = usage(refs, a.id).stopLoads; const ub = usage(refs, b.id).stopLoads;
    if (ua !== ub) return ub - ua;
    const ga = a.lat != null ? 1 : 0; const gb = b.lat != null ? 1 : 0;
    if (ga !== gb) return gb - ga;
    const ca = blank(a.createdAt); const cb = blank(b.createdAt);
    if (ca !== cb) return ca && cb ? (ca < cb ? -1 : 1) : (ca ? -1 : 1);
    return String(a.id) < String(b.id) ? -1 : 1;
  })[0];
}

const dedupeJson = (list) => {
  const seen = new Set();
  return list.filter((x) => { const k = JSON.stringify(x); if (seen.has(k)) return false; seen.add(k); return true; });
};

/** What merging `sources` into `survivor` changes ON the survivor: filled blanks, unions, and conflicts (reported only). */
export function planEnrichment(survivor, sources) {
  const set = {};
  const conflicts = [];
  const cur = { ...survivor };
  for (const src of sources) {
    for (const f of ENRICH_FIELDS) {
      const have = blank(cur[f]) !== '' || (cur[f] != null && typeof cur[f] !== 'string');
      // "Imported from Aljex" / "seeded from N historical load stop(s)" are system stamps, not facility notes
      const sv = f === 'notes' && SYSTEM_NOTE.test(blank(src[f])) ? null : src[f];
      const hasSrc = blank(sv) !== '' || (sv != null && typeof sv !== 'string');
      if (!hasSrc) continue;
      if (!have) { set[f] = sv; cur[f] = sv; } else if (String(cur[f]).trim() !== String(sv).trim()) conflicts.push({ field: f, survivor: cur[f], source: sv, sourceId: src.id });
    }
    if (cur.lat == null && src.lat != null) {
      for (const g of GEO_FIELDS) if (src[g] != null) { set[g] = src[g]; cur[g] = src[g]; }
    }
  }
  for (const f of UNION_FIELDS) {
    const merged = [...new Set([...arr(cur[f]), ...sources.flatMap((s) => arr(s[f]))])];
    if (f === 'aliases') {
      for (const s of sources) {
        const n = blank(s.name);
        if (n && normalizeName(n) !== normalizeName(blank(cur.name)) && !merged.some((a) => normalizeName(a) === normalizeName(n))) merged.push(n);
      }
    }
    if (merged.length !== arr(cur[f]).length) { set[f] = merged; cur[f] = merged; }
  }
  for (const f of JSON_UNION_FIELDS) {
    const merged = dedupeJson([...arr(cur[f]), ...sources.flatMap((s) => arr(s[f]))]);
    if (merged.length !== arr(cur[f]).length) { set[f] = merged; cur[f] = merged; }
  }
  return { set, conflicts };
}

/** Edit distance <= 1 (insert/delete/substitute) between two strings. */
function withinOneEdit(a, b) {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1; else if (b.length > a.length) j += 1; else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Full plan. -> {
 *   live, refs, counts, archive: [{ id, ...}], merges: [{ kind: 'EXACT'|'FOLD', survivorId, sourceId, loadIds }],
 *   survivors: [{ id, set, conflicts, sourceIds }], review: { noAddressReferenced, ambiguousFold, possibleTypo, sameAddressDifferentName },
 *   duplicateRows (count of rows to be frozen), examples
 * }
 */
export function planCleanup(locations, loads) {
  const live = locations.filter(isLive);
  const refs = countReferences(live, loads);
  const used = new Set(); // ids already decided
  const archive = [];
  const merges = [];
  const review = { noAddressReferenced: [], ambiguousFold: [], possibleTypo: [], sameAddressDifferentName: [], likelySamePlace: [] };

  // 1) rows with no street: archive the unused ones, keep the rest for the fold below
  for (const l of live.filter(hasNoAddress)) {
    const u = usage(refs, l.id);
    if (u.stopLoads === 0 && u.nameLoads === 0 && !carriesData(l)) { archive.push({ id: l.id, name: blank(l.name), customerIds: arr(l.customerIds) }); used.add(l.id); }
  }

  // 2) same place: same street number + street + zip (or city when there is no zip), names equal or one a prefix of the other
  const placeBuckets = new Map();
  for (const l of live.filter((x) => !used.has(x.id) && hasStreet(x))) {
    if (!normalizeName(blank(l.name))) continue;
    const where = zip5(l) || cityKey(l);
    const k = `${streetKey(l.street)}|${where}`;
    placeBuckets.set(k, [...(placeBuckets.get(k) ?? []), l]);
  }
  for (const rows of placeBuckets.values()) {
    if (rows.length < 2) continue;
    // connected components of nameRelated
    const parent = rows.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < rows.length; i += 1) for (let j = i + 1; j < rows.length; j += 1) if (nameRelated(rows[i].name, rows[j].name)) parent[find(i)] = find(j);
    const comps = new Map();
    rows.forEach((r, i) => comps.set(find(i), [...(comps.get(find(i)) ?? []), r]));
    for (const comp of comps.values()) {
      if (comp.length < 2) continue;
      const survivor = pickSurvivor(comp, refs);
      for (const r of comp) {
        if (r.id === survivor.id) continue;
        const exact = normalizeName(blank(r.name)) === normalizeName(blank(survivor.name)) && fullAddressKey(r) === fullAddressKey(survivor);
        merges.push({ kind: exact ? 'EXACT' : 'SAME_PLACE', survivorId: survivor.id, sourceId: r.id });
        used.add(r.id);
      }
    }
  }

  // 3) street-less rows folded into the ONE address their name+city already has
  const byNameCity = new Map();
  for (const l of live.filter((x) => !used.has(x.id))) {
    const nn = normalizeName(blank(l.name));
    if (!nn || cityKey(l) === '|') continue;
    const k = `${nn}|${cityKey(l)}`;
    byNameCity.set(k, [...(byNameCity.get(k) ?? []), l]);
  }
  for (const rows of byNameCity.values()) {
    const addressed = rows.filter(hasStreet);
    const bare = rows.filter((r) => !hasStreet(r));
    if (!bare.length) continue;
    if (!addressed.length) {
      // several street-less rows of the same name+city: fold the extras into the best one
      if (bare.length > 1) {
        const survivor = pickSurvivor(bare, refs);
        for (const r of bare) if (r.id !== survivor.id) { merges.push({ kind: 'FOLD', survivorId: survivor.id, sourceId: r.id }); used.add(r.id); }
      }
      continue;
    }
    const addrs = new Set(addressed.map(fullAddressKey));
    if (addrs.size === 1) {
      const survivor = pickSurvivor(addressed, refs);
      for (const r of bare) { merges.push({ kind: 'FOLD', survivorId: survivor.id, sourceId: r.id }); used.add(r.id); }
    } else {
      for (const r of bare) review.ambiguousFold.push({ id: r.id, name: blank(r.name), city: blank(r.city), candidates: addressed.map((a) => a.id) });
    }
  }

  // street-less rows that stay (used by loads or carrying data and no single twin to fold into)
  for (const l of live.filter((x) => hasNoAddress(x) && !used.has(x.id))) {
    if (review.ambiguousFold.some((r) => r.id === l.id)) continue;
    review.noAddressReferenced.push({ id: l.id, name: blank(l.name), ...usage(refs, l.id), hasData: carriesData(l) });
  }

  // 4) review only: typo variants in the same city, same address under another name
  const remaining = live.filter((l) => !used.has(l.id));
  const byCity = new Map();
  for (const l of remaining) {
    const ck = cityKey(l);
    if (ck === '|') continue;
    byCity.set(ck, [...(byCity.get(ck) ?? []), l]);
  }
  for (const rows of byCity.values()) {
    const names = rows.map((r) => ({ r, n: normalizeName(blank(r.name)) })).filter((x) => x.n.length >= 6);
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const a = names[i]; const b = names[j];
        if (a.n === b.n) continue;
        const prefix = (a.n.startsWith(b.n) || b.n.startsWith(a.n)) && Math.abs(a.n.length - b.n.length) <= 2;
        if (prefix || withinOneEdit(a.n, b.n)) review.possibleTypo.push({ a: { id: a.r.id, name: blank(a.r.name) }, b: { id: b.r.id, name: blank(b.r.name) }, city: blank(a.r.city) });
      }
    }
  }
  const byNumZip = new Map();
  for (const l of remaining.filter((x) => hasStreet(x) && zip5(x))) {
    const k = `${streetNumber(l.street)}|${zip5(l)}`;
    byNumZip.set(k, [...(byNumZip.get(k) ?? []), l]);
  }
  for (const rows of byNumZip.values()) {
    for (let i = 0; i < rows.length; i += 1) for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i]; const b = rows[j];
      if (streetKey(a.street) !== streetKey(b.street) && nameRelated(a.name, b.name)) review.likelySamePlace.push({ a: { id: a.id, name: blank(a.name), street: blank(a.street) }, b: { id: b.id, name: blank(b.name), street: blank(b.street) }, zip: zip5(a) });
    }
  }
  const byStreetNoZip = new Map();
  for (const l of remaining.filter((x) => hasStreet(x) && streetNumber(x.street))) {
    const k = `${streetKey(l.street)}|${normalizeName(blank(l.name)).slice(0, 12)}`;
    byStreetNoZip.set(k, [...(byStreetNoZip.get(k) ?? []), l]);
  }
  for (const rows of byStreetNoZip.values()) {
    if (rows.length > 1 && new Set(rows.map((r) => zip5(r) || cityKey(r))).size > 1) review.likelySamePlace.push(...rows.slice(1).map((b) => ({ a: { id: rows[0].id, name: blank(rows[0].name), street: blank(rows[0].street) }, b: { id: b.id, name: blank(b.name), street: blank(b.street) }, zip: `${zip5(rows[0])} vs ${zip5(b)}` })));
  }
  const byAddr = new Map();
  for (const l of remaining.filter(hasStreet)) byAddr.set(fullAddressKey(l), [...(byAddr.get(fullAddressKey(l)) ?? []), l]);
  for (const rows of byAddr.values()) {
    if (new Set(rows.map((r) => normalizeName(blank(r.name)))).size > 1) review.sameAddressDifferentName.push(rows.map((r) => ({ id: r.id, name: blank(r.name) })));
  }

  // loads to repoint per merge + the survivor enrichment
  const byId = new Map(live.map((l) => [l.id, l]));
  for (const m of merges) m.loadIds = loads.filter((ld) => loadStops(ld).some((s) => s.locationId === m.sourceId)).map((ld) => ld.id);
  const survivors = [];
  for (const sid of new Set(merges.map((m) => m.survivorId))) {
    const sourceIds = merges.filter((m) => m.survivorId === sid).map((m) => m.sourceId);
    const e = planEnrichment(byId.get(sid), sourceIds.map((id) => byId.get(id)));
    survivors.push({ id: sid, sourceIds, set: e.set, conflicts: e.conflicts });
  }

  const counts = {
    locationsTotal: locations.length,
    live: live.length,
    alreadyMergedOrArchived: locations.length - live.length,
    noAddress: live.filter(hasNoAddress).length,
    noAddressWithCity: live.filter((l) => hasNoAddress(l) && cityKey(l) !== '|').length,
    archive: archive.length,
    noAddressKept: review.noAddressReferenced.length,
    exactDuplicateRows: merges.filter((m) => m.kind === 'EXACT').length,
    samePlaceRows: merges.filter((m) => m.kind === 'SAME_PLACE').length,
    foldRows: merges.filter((m) => m.kind === 'FOLD').length,
    survivors: survivors.length,
    loadsToRepoint: new Set(merges.flatMap((m) => m.loadIds)).size,
    reviewAmbiguousFold: review.ambiguousFold.length,
    reviewPossibleTypo: review.possibleTypo.length,
    reviewLikelySamePlace: review.likelySamePlace.length,
    reviewSameAddressDifferentName: review.sameAddressDifferentName.length,
  };
  return { live, refs, byId, counts, archive, merges, survivors, review };
}

/** Rows in the autocomplete the user would see after the cleanup. */
export const cleanedCount = (plan) => plan.live.length - plan.archive.length - plan.merges.length;
