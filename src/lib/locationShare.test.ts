import { describe, expect, it } from 'vitest'
import { isAllowedShareHost, looksLikePlace, parseLocationShare, textOfVcard } from './locationShare'

describe('parseLocationShare', () => {
  it.each([
    ['https://maps.apple.com/?ll=41.5251,-88.0817&q=Dropped%20Pin', 'APPLE_MAPS'],
    ['My location https://maps.apple.com/?sll=41.5251,-88.0817', 'APPLE_MAPS'],
    ['http://maps.apple.com/?q=41.5,-88.1', 'APPLE_MAPS'],
    ['https://www.google.com/maps?q=41.5251,-88.0817', 'GOOGLE_MAPS'],
    ['https://www.google.com/maps/@41.5251,-88.0817,17z', 'GOOGLE_MAPS'],
    ['https://www.google.com/maps/place/Joliet/data=!3d41.5251!4d-88.0817', 'GOOGLE_MAPS'],
    ['https://maps.google.com/?q=41.5251,-88.0817', 'GOOGLE_MAPS'],
    ['41.5251, -88.0817', 'COORDS'],
    ['lat 41.5251 lng -88.0817', 'COORDS'],
  ])('reads %s', (text, kind) => {
    const hit = parseLocationShare(text)
    expect(hit?.kind).toBe(kind)
    if (hit && hit.kind !== 'SHORT_LINK') {
      expect(hit.lat).toBeCloseTo(41.5, 0)
      expect(hit.lng).toBeCloseTo(-88.1, 0)
    }
  })

  it('prefers the dropped pin over the viewport centre', () => {
    const hit = parseLocationShare('https://www.google.com/maps/place/X/@40.0,-87.0,12z/data=!3d41.5251!4d-88.0817')
    expect(hit).toMatchObject({ lat: 41.5251, lng: -88.0817 })
  })

  it('defers short links to the server-side resolver', () => {
    expect(parseLocationShare('https://maps.app.goo.gl/AbCd1234')).toEqual({ kind: 'SHORT_LINK', url: 'https://maps.app.goo.gl/AbCd1234' })
  })

  it.each([
    'call me 312.555.0142',
    'PRO 99270',
    'delivered 11/4/2026',
    'rate 1.5, 2.5',
    'ref 12345.678, 99.1',
    'weights 41.5, -88.1',
    'Thanks, on my way',
    '41.5251, 88.0817', // sign dropped: lands in the Indian Ocean, not the US
    '',
  ])('rejects the false positive %j', (text) => {
    expect(parseLocationShare(text)).toBeNull()
  })
})

describe('looksLikePlace', () => {
  it.each(['just passed Gary IN', 'in Dallas tx', 'Joliet, IL', 'Toledo OH', 'near Gary'])('accepts %j', (t) => {
    expect(looksLikePlace(t)).toBe(true)
  })
  it.each(['Thanks', 'ok', 'on my way', 'Sounds OK', 'will do', ''])('rejects %j', (t) => {
    expect(looksLikePlace(t)).toBe(false)
  })
})

describe('isAllowedShareHost', () => {
  it('accepts the map hosts over https only', () => {
    expect(isAllowedShareHost('https://maps.app.goo.gl/x')).toBe(true)
    expect(isAllowedShareHost('https://www.google.com/maps?q=1,2')).toBe(true)
    expect(isAllowedShareHost('https://maps.apple.com/?ll=1,2')).toBe(true)
    expect(isAllowedShareHost('http://maps.app.goo.gl/x')).toBe(false)
  })
  it.each([
    'https://goo.gl.evil.com/maps',
    'https://google.com.evil.io/maps',
    'https://169.254.169.254/latest/meta-data',
    'https://user:pw@maps.apple.com/',
    'https://maps.apple.com:8443/',
    'not a url',
  ])('refuses %s', (u) => {
    expect(isAllowedShareHost(u)).toBe(false)
  })
})

describe('textOfVcard', () => {
  it('pulls the Apple Maps URL out of a shared-location vcf', () => {
    const vcf = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Driver', 'item1.URL;type=pref:http://maps.apple.com/?ll=41.5251\\,-88.0817&q=Pin', 'END:VCARD'].join('\r\n')
    const text = textOfVcard(vcf)
    expect(text).toBe('http://maps.apple.com/?ll=41.5251,-88.0817&q=Pin')
    expect(parseLocationShare(text ?? '')).toMatchObject({ kind: 'APPLE_MAPS', lat: 41.5251 })
  })
  it('falls back to GEO and returns null for a plain contact', () => {
    expect(textOfVcard('BEGIN:VCARD\nGEO:41.5251;-88.0817\nEND:VCARD')).toBe('41.5251, -88.0817')
    expect(textOfVcard('BEGIN:VCARD\nFN:Bob\nEND:VCARD')).toBeNull()
  })
})
