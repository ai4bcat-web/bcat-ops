import { describe, expect, it } from 'vitest';
import { podPhotos } from './awPodToPdf.mjs';

describe('podPhotos', () => {
  const doc = (over) => ({ id: 'd', type: 'POD', status: 'ACTIVE', s3Key: 'shipment-docs/s1/a.jpg', contentType: 'image/jpeg', ...over });
  it('keeps only ACTIVE POD documents stored as a JPEG or PNG', () => {
    const rows = [
      doc({ id: 'jpg' }), doc({ id: 'png', contentType: 'image/PNG', s3Key: 'k.png' }), doc({ id: 'jpg2', contentType: 'image/jpg' }),
      doc({ id: 'pdf', contentType: 'application/pdf' }), doc({ id: 'bol', type: 'BOL' }), doc({ id: 'void', status: 'VOID' }),
      doc({ id: 'nokey', s3Key: '' }), doc({ id: 'heic', contentType: 'image/heic' }),
    ];
    expect(podPhotos(rows).map((d) => d.id)).toEqual(['jpg', 'png', 'jpg2']);
  });
});
