import { describe, it, expect } from 'vitest';
import { createMemoryClient, TmsApiError } from './tmsClient.mjs';

describe('createMemoryClient', () => {
  it('lists seeded data and returns records', async () => {
    const client = createMemoryClient({
      customers: [{ id: 'c1', name: 'Acme', normalizedName: 'acme', active: true }],
      loads: [{ id: 'l1', customer: 'Acme', updatedAt: '2026-01-01T00:00:00Z' }],
    });
    const customers = await client.listCustomers();
    expect(customers).toHaveLength(1);
    expect(customers[0].normalizedName).toBe('acme');
  });

  it('performs idempotent UPSERT_CUSTOMER lookup by normalised name', async () => {
    const client = createMemoryClient({
      customers: [{ id: 'c1', name: 'Acme LLC', normalizedName: 'acme', active: true }],
    });
    const first = await client.tmsDirectoryActions('UPSERT_CUSTOMER', { name: 'Acme Inc.', aliases: ['Acme'] });
    expect(first.id).toBe('c1');
    const second = await client.tmsDirectoryActions('UPSERT_CUSTOMER', { name: 'ACME LLC', aliases: ['ACME'] });
    expect(second.id).toBe('c1');
  });

  it('strips coordinates from UPSERT_LOCATION when no geocodeToken', async () => {
    const client = createMemoryClient();
    const result = await client.tmsDirectoryActions('UPSERT_LOCATION', {
      name: 'Oakley',
      city: 'Chicago, IL',
      lat: 41.0,
      lng: -87.0,
    });
    const loc = client._data.locations.get(result.id);
    expect(loc.lat).toBeUndefined();
    expect(loc.lng).toBeUndefined();
    expect(loc.normalizedName).toBe('oakley');
  });

  it('keeps coordinates with geocodeToken', async () => {
    const client = createMemoryClient();
    const result = await client.tmsDirectoryActions('UPSERT_LOCATION', {
      name: 'Oakley',
      city: 'Chicago, IL',
      lat: 41.0,
      lng: -87.0,
      geocodeToken: 'tok-xyz',
    });
    const loc = client._data.locations.get(result.id);
    expect(loc.lat).toBe(41.0);
    expect(loc.lng).toBe(-87.0);
  });

  it('propagates directory action errors', async () => {
    const client = createMemoryClient();
    await expect(client.tmsDirectoryActions('UNKNOWN', {})).rejects.toThrow('Unknown action');
  });

  describe('updateLoad', () => {
    it('rejects missing loads', async () => {
      const client = createMemoryClient();
      await expect(
        client.updateLoad({ id: 'missing' }, { updatedAt: { eq: 'x' } })
      ).rejects.toThrow('Load not found');
    });

    it('enforces CAS conflicts', async () => {
      const client = createMemoryClient({
        loads: [{ id: 'l1', customer: 'Acme', updatedAt: '2026-01-01T00:00:00Z' }],
      });
      await expect(
        client.updateLoad({ id: 'l1', customerId: 'c1' }, { updatedAt: { eq: 'old' } })
      ).rejects.toThrow('CAS conflict');
    });

    it('updates a load and dual-writes legacy mirrors', async () => {
      const client = createMemoryClient({
        loads: [{
          id: 'l1',
          customer: 'Acme',
          pickupAppt: '2026-01-10T10:00:00Z',
          deliveryAppt: '2026-01-10T18:00:00Z',
          originName: 'Pickup Co',
          originCity: 'Chicago, IL',
          destinationName: 'Drop Co',
          destinationCity: 'Detroit, MI',
          updatedAt: '2026-01-01T00:00:00Z',
        }],
      });
      await client.updateLoad(
        {
          id: 'l1',
          customerId: 'c1',
          stops: [
            {
              id: 'l1:pu',
              type: 'pickup',
              name: 'Pickup Co',
              city: 'Chicago, IL',
              appt: '2026-01-10T10:00:00Z',
              apptType: 'exact',
              driverId: null,
              sequence: 0,
            },
            {
              id: 'l1:de',
              type: 'delivery',
              name: 'Drop Co',
              city: 'Detroit, MI',
              appt: '2026-01-10T18:00:00Z',
              apptType: 'exact',
              driverId: null,
              sequence: 1,
            },
          ],
        },
        { updatedAt: { eq: '2026-01-01T00:00:00Z' } }
      );
      const load = client._data.loads.get('l1');
      expect(load.customerId).toBe('c1');
      expect(load.originCity).toBe('Chicago, IL');
      expect(load.destinationCity).toBe('Detroit, MI');
    });

    it('accepts stops as a JSON string', async () => {
      const client = createMemoryClient({
        loads: [{ id: 'l1', customer: 'Acme', updatedAt: 't1', pickupAppt: 'a', deliveryAppt: 'b' }],
      });
      const stops = [
        { id: 'l1:pu', type: 'pickup', name: 'P', city: 'C', appt: 'a', apptType: 'exact', driverId: null, sequence: 0 },
        { id: 'l1:de', type: 'delivery', name: 'D', city: 'D', appt: 'b', apptType: 'exact', driverId: null, sequence: 1 },
      ];
      await client.updateLoad(
        { id: 'l1', stops: JSON.stringify(stops) },
        { updatedAt: { eq: 't1' } }
      );
      expect(client._data.loads.get('l1').stops).toHaveLength(2);
    });
  });
});

describe('TmsApiError', () => {
  it('preserves error details', () => {
    const err = new TmsApiError([{ message: 'boom' }], 409);
    expect(err.status).toBe(409);
    expect(err.message).toContain('boom');
  });
});
