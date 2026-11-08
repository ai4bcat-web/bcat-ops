/**
 * Step AI §7.3 — the one model call (chat turns of the dashboard builder). The model has no
 * tools and never receives rows; it returns the union-free `MODEL_OUT_SCHEMA` object. The key
 * reaches this Lambda as the Amplify secret ANTHROPIC_API_KEY (tms-crm-actions/resource.ts),
 * the same mechanism tms-directory-actions uses for the Academy assistant.
 */
import Anthropic from '@anthropic-ai/sdk'
import { MODEL_OUT_SCHEMA } from '../../../src/lib/dashboards/modelSchema'

/** D8: claude-sonnet-5, low effort, bounded. */
export const DASH_MODEL = 'claude-sonnet-5'
export const DASH_MAX_TOKENS = 2500
/** The model call is aborted here (AppSync cuts a resolver at 30 s). */
export const MODEL_ABORT_MS = 22_000

export interface ModelRequest {
  /** Static instructions + catalog; cached across turns. */
  system: string
  /** Alternating user/assistant, starting with user. */
  messages: { role: 'user' | 'assistant'; content: string }[]
  signal: AbortSignal
}

export interface ModelPort {
  /** Returns the model's JSON text. Rejects on provider errors and on abort. */
  complete(req: ModelRequest): Promise<string>
}

export function anthropicModel(): ModelPort {
  return {
    async complete(req) {
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) throw new Error('The assistant is not configured (ANTHROPIC_API_KEY is not set)')
      const client = new Anthropic({ apiKey, maxRetries: 0 })
      const stream = client.messages.stream(
        {
          model: DASH_MODEL,
          max_tokens: DASH_MAX_TOKENS,
          output_config: { effort: 'low', format: { type: 'json_schema', schema: MODEL_OUT_SCHEMA } },
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: req.messages,
        },
        { signal: req.signal },
      )
      const final = await stream.finalMessage()
      return final.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
    },
  }
}
