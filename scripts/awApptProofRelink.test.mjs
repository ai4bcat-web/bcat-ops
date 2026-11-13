import { describe, expect, it } from 'vitest';
import { indexProofObjects, proposeRelinks } from './awApptProofRelink.mjs';

const keys = [
  'appt-proofs/lod-1/stp-a/request-100.png',
  'appt-proofs/lod-1/stp-a/request-200.png',
  'appt-proofs/lod-1/stp-a/email-150.jpg',
  'appt-proofs/lod-1/stp-b/e2open-100.png',
  'appt-proofs/lod-2/stp-c/request-100.png',
  'appt-proofs/lod-3/stp-d/request-100.png',
  'appt-proofs/lod-3/stp-d/e2open-100.png',
];

describe('awApptProofRelink', () => {
  it('proposes the newest object per slot for a wiped stop only', () => {
    const loads = [
      { id: 'lod-1', aljexId: '20005', stops: JSON.stringify([
        { id: 'stp-a', type: 'pickup', name: 'BATORY' },
        { id: 'stp-b', type: 'delivery', apptStatus: 'need_request', apptProofs: { request: null, e2open: null, email: null } },
      ]) },
      { id: 'lod-2', stops: [{ id: 'stp-c', type: 'pickup', apptProofs: { request: 'appt-proofs/lod-2/stp-c/request-100.png' } }] },
      { id: 'lod-3', stops: [{ id: 'stp-d', type: 'pickup', apptProofs: { request: 'appt-proofs/lod-3/stp-d/request-900.png' } }] },
    ];
    const out = proposeRelinks(loads, indexProofObjects(keys));
    expect(out).toEqual([{
      loadId: 'lod-1', pro: '20005', stopId: 'stp-a', stopType: 'pickup', stopName: 'BATORY',
      proofs: { request: 'appt-proofs/lod-1/stp-a/request-200.png', email: 'appt-proofs/lod-1/stp-a/email-150.jpg' },
    }, {
      loadId: 'lod-3', pro: null, stopId: 'stp-d', stopType: 'pickup', stopName: null,
      proofs: { e2open: 'appt-proofs/lod-3/stp-d/e2open-100.png' },
    }]);
  });
});
