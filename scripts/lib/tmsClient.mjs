/**
 * AppSync client used by TMS migration scripts.
 *
 * - Directory writes go through the tmsDirectoryActions custom mutation.
 * - Load writes use the generated updateLoad mutation with a condition on updatedAt
 *   for CAS (the lead override: UPDATE_LOAD is not a directory action).
 * - Errors are propagated; there is no `catch(() => [])` fallback.
 */

import { normalizeCustomerName, normalizeLocationName, normalizeCity } from './tmsNormalize.mjs';

export class TmsApiError extends Error {
  /**
   * @param {unknown} errors
   * @param {number} [status]
   */
  constructor(errors, status) {
    super(`TMS API error${status ? ` (${status})` : ''}: ${JSON.stringify(errors)}`);
    this.errors = errors;
    this.status = status ?? null;
  }
}

/**
 * Build a real AppSync client.
 * @param {object} opts
 * @param {string} opts.endpoint
 * @param {string} opts.token
 * @param {typeof fetch} [opts.fetch]
 * @returns {object}
 */
export function createTmsClient({ endpoint, token, fetch: fetchFn = globalThis.fetch }) {
  if (!endpoint || !token) {
    throw new Error('createTmsClient requires endpoint and token');
  }

  async function gql(query, variables = {}) {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: token,
      },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.errors?.length) {
      throw new TmsApiError(json.errors ?? json, res.status);
    }
    return json.data;
  }

  async function paginate(queryTpl, itemsPath, limit = 1000) {
    const items = [];
    let nextToken = null;
    do {
      const data = await gql(queryTpl(nextToken), { nextToken, limit });
      const node = itemsPath.split('.').reduce((o, k) => o?.[k], data);
      items.push(...(node?.items ?? []));
      nextToken = node?.nextToken ?? null;
    } while (nextToken);
    return items;
  }

  const listCustomers = (opts = {}) => {
    const fields = opts.fields ?? `
      id name normalizedName aliases active apptWorkflow
      contactName contactEmail contactPhone notes
      createdAt updatedAt
    `;
    return paginate(
      (nextToken) => `query L($limit: Int, $nextToken: String) {
        listCustomers(limit: $limit, nextToken: $nextToken) {
          items { ${fields} }
          nextToken
        }
      }`,
      'listCustomers',
      opts.limit
    );
  };

  const listLocations = (opts = {}) => {
    const fields = opts.fields ?? `
      id name normalizedName aliases city normalizedAddress
      street state zip country lat lng timezone geohash6
      apptContactName apptContactEmail apptContactPhone notes
      customerIds active facilityType apptRule
      createdAt updatedAt
    `;
    return paginate(
      (nextToken) => `query L($limit: Int, $nextToken: String) {
        listLocations(limit: $limit, nextToken: $nextToken) {
          items { ${fields} }
          nextToken
        }
      }`,
      'listLocations',
      opts.limit
    );
  };

  const listLoads = (opts = {}) => {
    const fields = opts.fields ?? `
      id aljexId tmsId pickupNumber customer customerId
      originName originCity destinationName destinationCity
      pickupAppt pickupApptEnd pickupApptType
      deliveryAppt deliveryApptEnd deliveryApptType
      pickupDriverId deliveryDriverId
      readyToInvoice rateConfirmKey
      truckId rate miles colorKey daySlot sortOrder notes hot unscheduled
      stops createdBy updatedBy createdAt updatedAt
    `;
    return paginate(
      (nextToken) => `query L($limit: Int, $nextToken: String) {
        listLoads(limit: $limit, nextToken: $nextToken) {
          items { ${fields} }
          nextToken
        }
      }`,
      'listLoads',
      opts.limit
    );
  };

  const listDivisions = (opts = {}) => {
    const fields = opts.fields ?? `
      id key name legalName mcNumber dotNumber scac
      remitToName remitToAddress remitToEmail invoicePrefix fleetGroup active
      createdAt updatedAt
    `;
    return paginate(
      (nextToken) => `query L($limit: Int, $nextToken: String) {
        listDivisions(limit: $limit, nextToken: $nextToken) {
          items { ${fields} }
          nextToken
        }
      }`,
      'listDivisions',
      opts.limit
    );
  };

  const getTmsSettings = async (id = 'default') => {
    const data = await gql(
      `query S($id: ID!) { getTmsSettings(id: $id) { id marginFloorBps defaultPaymentTermsDays accessorialCodes loadStatusRules invoiceNumberFormat createdAt updatedAt } }`,
      { id }
    );
    return data?.getTmsSettings ?? null;
  };

  /**
   * Update a Load with an optional condition for CAS.
   * @param {Record<string, unknown>} input
   * @param {{updatedAt?: {eq?: string}} | null} [condition]
   */
  const updateLoad = async (input, condition) => {
    const nextInput = { ...input };
    if (nextInput.stops !== undefined && typeof nextInput.stops !== 'string') {
      nextInput.stops = JSON.stringify(nextInput.stops);
    }
    const data = await gql(
      `mutation UL($input: UpdateLoadInput!, $condition: ModelLoadConditionInput) {
        updateLoad(input: $input, condition: $condition) { id customerId stops updatedAt }
      }`,
      { input: nextInput, condition: condition ?? undefined }
    );
    return data?.updateLoad ?? null;
  };

  const tmsDirectoryActions = async (action, input) => {
    const payload = typeof input === 'string' ? input : JSON.stringify(input);
    const data = await gql(
      `mutation T($action: String!, $input: AWSJSON!) {
        tmsDirectoryActions(action: $action, input: $input)
      }`,
      { action, input: payload }
    );
    // AWSJSON comes back as a JSON string from AppSync (the browser client unwraps it too).
    const raw = data?.tmsDirectoryActions;
    return typeof raw === 'string' ? JSON.parse(raw) : raw ?? null;
  };

  return {
    endpoint,
    token,
    gql,
    listCustomers,
    listLocations,
    listLoads,
    listDivisions,
    getTmsSettings,
    updateLoad,
    tmsDirectoryActions,
  };
}

/**
 * In-memory client for unit tests and offline demos.
 * Implements the same public API as createTmsClient.
 * @param {object} [seed]
 * @param {any[]} [seed.customers]
 * @param {any[]} [seed.locations]
 * @param {any[]} [seed.loads]
 * @param {any[]} [seed.divisions]
 * @param {any} [seed.settings]
 * @returns {object}
 */
export function createMemoryClient({
  customers = [],
  locations = [],
  loads = [],
  divisions = [],
  settings = null,
} = {}) {
  const now = () => new Date().toISOString();
  const data = {
    customers: new Map(customers.map((c) => [c.id, c])),
    locations: new Map(locations.map((l) => [l.id, l])),
    loads: new Map(loads.map((l) => [l.id, l])),
    divisions: new Map(divisions.map((d) => [d.id, d])),
    settings: settings ? { ...settings } : null,
  };

  function ensureTimestamps(record) {
    const t = now();
    if (!record.createdAt) record.createdAt = t;
    record.updatedAt = t;
  }

  function serverNormalizeCustomer(input) {
    if (input.name) {
      input.normalizedName = normalizeCustomerName(input.name);
    }
  }

  function serverNormalizeLocation(input) {
    if (input.name) {
      input.normalizedName = normalizeLocationName(input.name);
    }
    if (input.city) {
      input.normalizedAddress = normalizeLocationName(input.name) + '|' + normalizeCity(input.city);
    }
  }

  function stripCoordinates(input) {
    // Coordinates are only accepted when a geocodeToken is present.
    if (input.geocodeToken) return input;
    const next = { ...input };
    delete next.lat;
    delete next.lng;
    delete next.geohash6;
    delete next.geocodeToken;
    return next;
  }

  const updateLoad = async (input, condition) => {
    const existing = data.loads.get(input.id);
    if (!existing) {
      throw new TmsApiError([{ message: `Load not found: ${input.id}` }], 404);
    }
    const expectedUpdatedAt = condition?.updatedAt?.eq;
    if (expectedUpdatedAt && existing.updatedAt !== expectedUpdatedAt) {
      throw new TmsApiError([{ message: `Load CAS conflict for ${input.id}` }], 409);
    }
    const next = { ...existing };
    for (const key of Object.keys(input)) {
      if (key === 'id') continue;
      if (key === 'stops' && typeof input[key] === 'string') {
        try {
          next.stops = JSON.parse(input[key]);
        } catch {
          next.stops = input[key];
        }
      } else {
        next[key] = input[key];
      }
    }
    // Dual-write legacy mirrors when stops change.
    if (next.stops) {
      const { deriveLegacyFields } = await import('./tmsStops.mjs');
      Object.assign(next, deriveLegacyFields(next.stops));
    }
    ensureTimestamps(next);
    data.loads.set(input.id, next);
    return { id: input.id, updatedAt: next.updatedAt };
  };

  const tmsDirectoryActions = async (action, rawInput) => {
    const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;

    switch (action) {
      case 'UPSERT_CUSTOMER': {
        const existingId =
          input.id ??
          [...data.customers.values()].find((c) => c.normalizedName === normalizeCustomerName(input.name))?.id;
        if (existingId && data.customers.has(existingId)) {
          const existing = data.customers.get(existingId);
          if (input.expectedUpdatedAt && existing.updatedAt !== input.expectedUpdatedAt) {
            throw new TmsApiError(
              [{ message: `UPSERT_CUSTOMER CAS conflict for ${existingId}` }],
              409
            );
          }
          const next = { ...existing, ...input };
          delete next.expectedUpdatedAt;
          serverNormalizeCustomer(next);
          ensureTimestamps(next);
          data.customers.set(existingId, next);
          return { id: existingId, updatedAt: next.updatedAt };
        }
        const id = input.id ?? `cust-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const record = { ...input, id };
        delete record.expectedUpdatedAt;
        serverNormalizeCustomer(record);
        ensureTimestamps(record);
        data.customers.set(id, record);
        return { id, updatedAt: record.updatedAt };
      }

      case 'UPSERT_LOCATION': {
        const existingId =
          input.id ??
          [...data.locations.values()].find(
            (l) =>
              l.normalizedName === normalizeLocationName(input.name) &&
              (!input.city || normalizeCity(l.city) === normalizeCity(input.city))
          )?.id;
        const clean = stripCoordinates(input);
        if (existingId && data.locations.has(existingId)) {
          const existing = data.locations.get(existingId);
          if (clean.expectedUpdatedAt && existing.updatedAt !== clean.expectedUpdatedAt) {
            throw new TmsApiError(
              [{ message: `UPSERT_LOCATION CAS conflict for ${existingId}` }],
              409
            );
          }
          const next = { ...existing, ...clean };
          delete next.expectedUpdatedAt;
          serverNormalizeLocation(next);
          ensureTimestamps(next);
          data.locations.set(existingId, next);
          return { id: existingId, updatedAt: next.updatedAt };
        }
        const id = clean.id ?? `loc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const record = { ...clean, id };
        serverNormalizeLocation(record);
        ensureTimestamps(record);
        data.locations.set(id, record);
        return { id, updatedAt: record.updatedAt };
      }

      case 'SAVE_DIVISION': {
        if (!input.key) throw new TmsApiError([{ message: 'SAVE_DIVISION requires key' }], 400);
        const id = input.id ?? input.key;
        const existing = data.divisions.get(id);
        if (existing && input.expectedUpdatedAt && existing.updatedAt !== input.expectedUpdatedAt) {
          throw new TmsApiError(
            [{ message: `SAVE_DIVISION CAS conflict for ${id}` }],
            409
          );
        }
        const record = { ...existing, ...input, id };
        delete record.expectedUpdatedAt;
        ensureTimestamps(record);
        data.divisions.set(id, record);
        return { id, updatedAt: record.updatedAt };
      }

      case 'SAVE_SETTINGS': {
        const id = input.id ?? 'default';
        const existing = data.settings;
        if (existing && input.expectedUpdatedAt && existing.updatedAt !== input.expectedUpdatedAt) {
          throw new TmsApiError(
            [{ message: `SAVE_SETTINGS CAS conflict for ${id}` }],
            409
          );
        }
        const record = { ...(existing ?? {}), ...input, id };
        delete record.expectedUpdatedAt;
        ensureTimestamps(record);
        data.settings = record;
        return { id, updatedAt: record.updatedAt };
      }

      default:
        throw new TmsApiError([{ message: `Unknown action: ${action}` }], 400);
    }
  };

  return {
    endpoint: 'memory://',
    token: 'memory-token',
    gql: async () => {
      throw new Error('Use tmsDirectoryActions with the memory client');
    },
    listCustomers: async () => [...data.customers.values()],
    listLocations: async () => [...data.locations.values()],
    // Same wire shape as AppSync: AWSJSON `stops` arrives as a JSON string.
    listLoads: async () => [...data.loads.values()].map((l) => (l.stops == null ? l : { ...l, stops: JSON.stringify(l.stops) })),
    listDivisions: async () => [...data.divisions.values()],
    getTmsSettings: async () => data.settings,
    updateLoad,
    tmsDirectoryActions,
    _data: data,
  };
}
