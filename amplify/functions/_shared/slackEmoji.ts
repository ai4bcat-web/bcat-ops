import { emojify } from 'node-emoji'

/**
 * Slack delivers emoji as shortcodes (":+1::skin-tone-2:"), which a phone shows as literal
 * text. Turn them into the characters before a message is stored or texted. Skin tones
 * follow the emoji they modify; a shortcode nobody knows is left exactly as typed.
 */
const SKIN_TONES: Record<string, string> = {
  '2': '\u{1F3FB}', '3': '\u{1F3FC}', '4': '\u{1F3FD}', '5': '\u{1F3FE}', '6': '\u{1F3FF}',
}

/** Slack names that differ from the standard shortcode table. */
const SLACK_ALIASES: Record<string, string> = {
  thumbsup: '+1', thumbsdown: '-1', simple_smile: 'slightly_smiling_face', slightly_smiling: 'slightly_smiling_face',
  heavy_check_mark: 'heavy_check_mark', ok: 'ok_hand', pray: 'pray', fire: 'fire', raised_hands: 'raised_hands',
  man_shrugging: 'man_shrugging', woman_shrugging: 'woman_shrugging', truck: 'truck', large_green_circle: 'green_circle',
  large_yellow_circle: 'yellow_circle', red_circle: 'red_circle', facepunch: 'punch', hankey: 'poop',
}

function aliased(text: string): string {
  return text.replace(/:([a-z0-9_+-]+):/gi, (whole, name: string) => {
    const std = SLACK_ALIASES[name.toLowerCase()]
    return std ? `:${std}:` : whole
  })
}

export function slackEmojiToUnicode(raw: string): string {
  const text = aliased(raw)
  // ":name::skin-tone-N:" → emoji + modifier (only when the name is a known emoji).
  const toned = text.replace(/:([a-z0-9_+-]+)::skin-tone-([2-6]):/gi, (whole, name: string, tone: string) => {
    const base = emojify(`:${name}:`)
    return base === `:${name}:` ? whole : base + SKIN_TONES[tone]
  })
  // A stray tone with nothing to modify is noise; everything else goes through the table.
  return emojify(toned.replace(/:skin-tone-[2-6]:/gi, ''))
}
