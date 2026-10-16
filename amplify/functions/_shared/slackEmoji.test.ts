import { describe, it, expect } from 'vitest'
import { slackEmojiToUnicode } from './slackEmoji'

describe('slackEmojiToUnicode', () => {
  it('turns shortcodes into characters and applies skin tones to the emoji before them', () => {
    expect(slackEmojiToUnicode(':+1::skin-tone-2::+1::skin-tone-2:')).toBe('👍🏻👍🏻')
    expect(slackEmojiToUnicode('on it :thumbsup: :tada:')).toBe('on it 👍 🎉')
  })
  it('leaves unknown shortcodes and times alone', () => {
    expect(slackEmojiToUnicode('be there at 10:30: ok :not_a_real_emoji:')).toBe('be there at 10:30: ok :not_a_real_emoji:')
  })
  it('drops a skin tone with nothing to modify', () => {
    expect(slackEmojiToUnicode('hi :skin-tone-4:')).toBe('hi ')
  })
})
