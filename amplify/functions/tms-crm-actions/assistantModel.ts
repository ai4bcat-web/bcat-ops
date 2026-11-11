/**
 * The ops assistant's model port: one tool-use step. The key reaches this Lambda as the Amplify
 * secret ANTHROPIC_API_KEY (tms-crm-actions/resource.ts), like the dashboard builder's call.
 */
import Anthropic from '@anthropic-ai/sdk'

export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }

export interface AssistantMessage {
  role: 'user' | 'assistant'
  content: string | AssistantBlock[]
}

export interface ToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface StepRequest {
  system: string
  messages: AssistantMessage[]
  tools: ToolDef[]
  signal: AbortSignal
}

export interface AssistantModel {
  /** One model call. Rejects on provider errors and on abort. */
  step(req: StepRequest): Promise<{ content: AssistantBlock[] }>
}

export const ASSISTANT_MODEL = 'claude-sonnet-5'
export const ASSISTANT_MAX_TOKENS = 1500

export function anthropicAssistantModel(): AssistantModel {
  return {
    async step(req) {
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) throw new Error('The assistant is not configured (ANTHROPIC_API_KEY is not set)')
      const client = new Anthropic({ apiKey, maxRetries: 0 })
      const res = await client.messages.create(
        {
          model: ASSISTANT_MODEL,
          max_tokens: ASSISTANT_MAX_TOKENS,
          output_config: { effort: 'low' },
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          tools: req.tools as Anthropic.Tool[],
          messages: req.messages as Anthropic.MessageParam[],
        },
        { signal: req.signal },
      )
      const content: AssistantBlock[] = []
      for (const b of res.content) {
        if (b.type === 'text') content.push({ type: 'text', text: b.text })
        else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input })
      }
      return { content }
    },
  }
}
