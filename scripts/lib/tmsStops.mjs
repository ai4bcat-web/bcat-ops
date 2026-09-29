/**
 * Stop array helpers for migration scripts.
 *
 * Mirrors src/lib/stops.ts so the backfill scripts can run under plain Node without
 * needing to transpile TypeScript. Keeps legacy mirror derivation intact.
 */

/**
 * Canonical accessor: real stops if present, else 2 stops synthesized from legacy fields.
 * @param {Record<string, unknown>} load
 * @returns {any[]}
 */
export function getStops(load) {
  // `stops` is AWSJSON: AppSync returns it as a JSON string through the list query.
  let stops = load.stops;
  for (let i = 0; i < 4 && typeof stops === 'string'; i++) {
    try { stops = JSON.parse(stops); } catch { break; }
  }
  if (Array.isArray(stops) && stops.length > 0) {
    return [...stops].sort((a, b) => a.sequence - b.sequence);
  }

  // Legacy: synthesize pickup + delivery from mirror fields.
  return [
    {
      id: `${load.id}:pu`,
      type: 'pickup',
      name: load.originName ?? undefined,
      city: load.originCity ?? undefined,
      appt: load.pickupAppt ?? '',
      apptType: load.pickupApptType ?? 'exact',
      apptEnd: load.pickupApptEnd ?? undefined,
      driverId: load.pickupDriverId ?? null,
      sequence: 0,
    },
    {
      id: `${load.id}:de`,
      type: 'delivery',
      name: load.destinationName ?? undefined,
      city: load.destinationCity ?? undefined,
      appt: load.deliveryAppt ?? '',
      apptType: load.deliveryApptType ?? 'exact',
      apptEnd: load.deliveryApptEnd ?? undefined,
      driverId: load.deliveryDriverId ?? null,
      sequence: 1,
    },
  ];
}

/**
 * Compute legacy mirror fields from a stops array, for dual-write.
 * @param {any[]} stops
 * @returns {Record<string, unknown>}
 */
export function deriveLegacyFields(stops) {
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence);
  const first = ordered.find((s) => s.type === 'pickup') ?? ordered[0];
  const last = [...ordered].reverse().find((s) => s.type === 'delivery') ?? ordered[ordered.length - 1];
  return {
    pickupAppt: first?.appt ?? '',
    pickupApptEnd: first?.apptEnd,
    pickupApptType: first?.apptType,
    originName: first?.name,
    originCity: first?.city,
    pickupDriverId: first?.driverId,
    deliveryAppt: last?.appt ?? '',
    deliveryApptEnd: last?.apptEnd,
    deliveryApptType: last?.apptType,
    destinationName: last?.name,
    destinationCity: last?.city,
    deliveryDriverId: last?.driverId,
  };
}

/**
 * Return a new stops array with a single stop patched.
 * @param {any[]} stops
 * @param {string} stopId
 * @param {Record<string, unknown>} patch
 * @returns {any[]}
 */
export function updateStop(stops, stopId, patch) {
  return stops.map((s) => (s.id === stopId ? { ...s, ...patch } : s));
}

/**
 * Re-number sequence 0..n after add/remove/reorder.
 * @param {any[]} stops
 * @returns {any[]}
 */
export function reorderStops(stops) {
  return stops.map((s, i) => ({ ...s, sequence: i }));
}
