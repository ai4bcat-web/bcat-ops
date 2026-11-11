import { describe, expect, it } from 'vitest';
import { planAccepted } from './awTrackingAccepted.mjs';

describe('planAccepted', () => {
  const link = (id, over = {}) => ({ id, status: 'ACTIVE', consentAt: '2026-11-10T14:00:00Z', ...over });
  const lc = (id, over = {}) => ({ id, shipmentId: `s-${id}`, trackingLinkId: `t-${id}`, ...over });
  it('fills a leg whose active link was accepted and which has no value yet', () => {
    const plan = planAccepted([lc('a')], [link('t-a')]);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ acceptedAt: '2026-11-10T14:00:00Z' });
  });
  it('leaves alone: no consent, a revoked link, a missing link, no link on the leg, or a leg that already has a value', () => {
    const carriers = [lc('nc'), lc('rv'), lc('ms', { trackingLinkId: 't-gone' }), lc('nl', { trackingLinkId: null }), lc('has', { trackingAcceptedAt: '2026-11-09T00:00:00Z' })];
    const links = [link('t-nc', { consentAt: null }), link('t-rv', { status: 'REVOKED' }), link('t-has')];
    expect(planAccepted(carriers, links)).toEqual([]);
  });
});
