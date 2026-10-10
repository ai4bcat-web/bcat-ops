import { describe, it, expect } from 'vitest'
import {
  parseFormBody, requestUrl, twilioSignature, signatureMatches, secretMatches, xmlEscape, twiml,
  dialTwiml, whisperTwiml, voicemailTwiml, hangupTwiml, sendMessageForm, extensionFor, basicAuth,
} from './twilio'

describe('parseFormBody', () => {
  it('decodes a base64 form body the way a Function URL delivers it', () => {
    const body = Buffer.from('From=%2B18475550100&Body=Running+late&NumMedia=0').toString('base64')
    expect(parseFormBody({ body, isBase64Encoded: true })).toEqual({ From: '+18475550100', Body: 'Running late', NumMedia: '0' })
  })
  it('decodes a plain body and tolerates none', () => {
    expect(parseFormBody({ body: 'A=1&B=two%20words' })).toEqual({ A: '1', B: 'two words' })
    expect(parseFormBody({ body: null })).toEqual({})
  })
})

describe('signature', () => {
  // Worked example from Twilio's own documentation of the algorithm.
  const token = '12345'
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2'
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' }
  it('reproduces the documented signature', () => {
    expect(twilioSignature(token, url, params)).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=')
  })
  it('matches only the exact header', () => {
    expect(signatureMatches(token, url, params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=')).toBe(true)
    expect(signatureMatches(token, url, params, '0/KCTR6DLpKmkAf8muzZqo1nDgX=')).toBe(false)
    expect(signatureMatches(token, url, params, undefined)).toBe(false)
    expect(signatureMatches(token, url, { ...params, Digits: '9999' }, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=')).toBe(false)
  })
  it('rebuilds the URL Twilio signed from the Function URL event', () => {
    expect(requestUrl({ rawPath: '/sms', rawQueryString: 't=abc', headers: { host: 'x.lambda-url.us-east-1.on.aws' } }))
      .toBe('https://x.lambda-url.us-east-1.on.aws/sms?t=abc')
    expect(requestUrl({ rawPath: '/voice', headers: { host: 'h' } })).toBe('https://h/voice')
  })
  it('compares the URL secret in constant time and never accepts an empty one', () => {
    expect(secretMatches('s3cret', 's3cret')).toBe(true)
    expect(secretMatches('s3cret', 's3cre')).toBe(false)
    expect(secretMatches('', '')).toBe(false)
    expect(secretMatches('s3cret', undefined)).toBe(false)
  })
})

describe('TwiML', () => {
  it('escapes text that would otherwise break the XML', () => {
    expect(xmlEscape(`Bob & "Ann" <x>`)).toBe('Bob &amp; &quot;Ann&quot; &lt;x&gt;')
    expect(twiml('')).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>')
  })
  it('rings every office phone with the whisper and reports to the action URL', () => {
    const x = dialTwiml({ numbers: ['+18475550100', '+18475550101'], callerId: '+12242221305', timeoutSec: 25, actionUrl: 'https://h/voice/after?t=s', whisperUrl: 'https://h/voice/whisper?t=s&from=x' })
    expect(x).toContain('<Dial callerId="+12242221305" timeout="25" action="https://h/voice/after?t=s" method="POST">')
    expect(x).toContain('<Number url="https://h/voice/whisper?t=s&amp;from=x">+18475550100</Number>')
    expect(x).toContain('+18475550101</Number></Dial>')
  })
  it('whispers, gathers one key, and hangs up the leg if nobody presses', () => {
    const x = whisperTwiml('Jason Smith', 'https://h/voice/accept?t=s')
    expect(x).toContain('<Gather numDigits="1"')
    expect(x).toContain('BCAT dispatch call from Jason Smith. Press any key to accept.')
    expect(x.endsWith('</Gather><Hangup/></Response>')).toBe(true)
  })
  it('records a voicemail with both callbacks and a beep', () => {
    const x = voicemailTwiml({ greeting: 'Leave a message', recordingCallbackUrl: 'https://h/voice/recording?t=s', transcriptionCallbackUrl: 'https://h/voice/transcription?t=s' })
    expect(x).toContain('Leave a message')
    expect(x).toContain('playBeep="true"')
    expect(x).toContain('recordingStatusCallback="https://h/voice/recording?t=s"')
    expect(x).toContain('transcribeCallback="https://h/voice/transcription?t=s"')
    expect(hangupTwiml('Bye')).toContain('Bye</Say><Hangup/>')
  })
})

describe('REST shapes', () => {
  const creds = { accountSid: 'AC1', apiKeySid: 'SK1', apiKeySecret: 'sec', messagingServiceSid: 'MG1' }
  it('sends through the messaging service with the dispatch number pinned as From', () => {
    const f = sendMessageForm(creds, { to: '+18475550100', from: '+12242221305', body: 'hi', mediaUrls: ['https://s3/a', 'https://s3/b'], statusCallback: 'https://h/status?t=s' })
    expect(f.get('MessagingServiceSid')).toBe('MG1')
    expect(f.get('From')).toBe('+12242221305')
    expect(f.getAll('MediaUrl')).toEqual(['https://s3/a', 'https://s3/b'])
    expect(f.get('StatusCallback')).toBe('https://h/status?t=s')
  })
  it('omits the service when the account has none and the body when empty', () => {
    const f = sendMessageForm({ ...creds, messagingServiceSid: null }, { to: 'a', from: 'b' })
    expect(f.has('MessagingServiceSid')).toBe(false)
    expect(f.has('Body')).toBe(false)
  })
  it('builds basic auth from the API key, not the account sid', () => {
    expect(basicAuth(creds)).toBe('Basic ' + Buffer.from('SK1:sec').toString('base64'))
  })
  it('maps content types to extensions, defaulting to bin', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg')
    expect(extensionFor('audio/mpeg; charset=binary')).toBe('mp3')
    expect(extensionFor('application/x-thing')).toBe('bin')
  })
})
