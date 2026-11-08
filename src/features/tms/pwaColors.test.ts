import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

/** The light-theme token value: the first declaration in theme.css is the `:root` block. */
function lightToken(name: string): string {
  const match = read('src/features/tms/theme.css').match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!match) throw new Error(`${name} not found in theme.css`)
  return match[1].toLowerCase()
}

/**
 * A web manifest cannot switch per theme, so the installed app's chrome and splash colour are
 * the light tokens. A token change that is not mirrored here would silently strand them.
 */
describe('PWA colours follow the light tokens', () => {
  it('<meta theme-color> in index.html is the top-bar token', () => {
    const meta = read('index.html').match(/<meta name="theme-color" content="(#[0-9a-fA-F]{6})"/)?.[1]
    expect(meta?.toLowerCase()).toBe(lightToken('--tms-topbar'))
  })

  it('manifest theme_color is the top-bar token and background_color the canvas token', () => {
    const vite = read('vite.config.ts')
    expect(vite.match(/theme_color:\s*'(#[0-9a-fA-F]{6})'/)?.[1].toLowerCase()).toBe(lightToken('--tms-topbar'))
    expect(vite.match(/background_color:\s*'(#[0-9a-fA-F]{6})'/)?.[1].toLowerCase()).toBe(lightToken('--tms-bg'))
  })
})
