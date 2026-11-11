import { describe, expect, it } from 'vitest'
import { cleanEmailBody } from './emailBodyClean'

describe('cleanEmailBody', () => {
  it('keeps a plain message as it is', () => {
    expect(cleanEmailBody('Driver is 20 minutes out.')).toEqual({ text: 'Driver is 20 minutes out.', trimmed: false })
  })

  it('drops the quoted earlier message and its "On ... wrote:" header', () => {
    const body = 'Got it, thanks.\n\nOn Tue, Nov 10, 2026 at 11:25 AM Arcie Verzosa <ai4bcat@gmail.com> wrote:\n> Please reply in this thread.\n>\n> — Arcie, BCAT Tracking'
    expect(cleanEmailBody(body)).toEqual({ text: 'Got it, thanks.', trimmed: true })
  })

  it('handles "wrote:" on the next line', () => {
    const body = 'Running late.\n\nOn Tue, Nov 10, 2026 at 11:25 AM Ruben Vargas <ruben@bcatcorp.com>\nwrote:\n\n> driver zak pace'
    expect(cleanEmailBody(body).text).toBe('Running late.')
  })

  it('drops the signature block after a closer and after the -- delimiter', () => {
    const sig = 'ETA is 9pm tonight.\n\nBest Regards,\n\nEli Hasani\n\nManager/Dispatch LENTI INC.\n131 E Grand Ave.\nFox Lake, IL. 60020\nDispatch # 224-908-3907\nFax # 224-908-3914'
    expect(cleanEmailBody(sig)).toEqual({ text: 'ETA is 9pm tonight.', trimmed: true })
    expect(cleanEmailBody('ETA 9pm.\n-- \nEli Hasani\nLENTI INC').text).toBe('ETA 9pm.')
  })

  it('drops mobile footers, forwarded-message blocks and Outlook header blocks', () => {
    expect(cleanEmailBody('On the way.\n\nSent from my iPhone').text).toBe('On the way.')
    expect(cleanEmailBody('See below.\n\n---------- Forwarded message ---------\nFrom: x\nSubject: y').text).toBe('See below.')
    expect(cleanEmailBody('Yes.\n\nFrom: Dispatch <d@x.com>\nSent: Monday, November 9, 2026 4:03 PM\nTo: us\nSubject: load').text).toBe('Yes.')
  })

  it('does not treat a "From:" line without a Sent/Date line as a header, and keeps mid-sentence thanks', () => {
    expect(cleanEmailBody('Pickup is from: the east dock\nThanks for the update, will confirm').text).toBe('Pickup is from: the east dock\nThanks for the update, will confirm')
  })

  it('never leaves nothing: a message that is only a quote or only a signature shows as it came', () => {
    expect(cleanEmailBody('> only a quote').text).toBe('> only a quote')
    expect(cleanEmailBody('Thanks,\nEli').text).toBe('Thanks,\nEli')
  })

  it('collapses blank runs and handles CRLF and empty input', () => {
    expect(cleanEmailBody('Line one\r\n\r\n\r\n\r\nLine two').text).toBe('Line one\n\nLine two')
    expect(cleanEmailBody('')).toEqual({ text: '', trimmed: false })
    expect(cleanEmailBody(null)).toEqual({ text: '', trimmed: false })
  })
})
