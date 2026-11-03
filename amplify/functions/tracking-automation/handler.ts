/**
 * tracking-automation Lambda — the clock for Step V's automation engine.
 *
 * It owns no logic: it asks tmsTrackingActions to run one AUTO sweep, identifying itself
 * as the `tracking-automation` system caller (see SYSTEM_CALLERS in the router). That is
 * the only action this caller may run, and never MANUAL.
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'

const lambda = new LambdaClient({})

export const SYSTEM_CALLER = 'tracking-automation'

/** The exact event tmsTrackingActions receives from the schedule. */
export function automationEvent(): { arguments: { action: string; input: string }; systemCaller: string } {
  return {
    arguments: { action: 'RUN_TRACKING_AUTOMATION', input: JSON.stringify({ mode: 'AUTO' }) },
    systemCaller: SYSTEM_CALLER,
  }
}

export const handler = async (): Promise<unknown> => {
  const functionName = process.env.TMS_TRACKING_ACTIONS_FUNCTION_NAME ?? ''
  if (!functionName) {
    console.log('[tracking-automation] TMS_TRACKING_ACTIONS_FUNCTION_NAME unset; nothing to run')
    return { ran: false }
  }
  const invoked = await lambda.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(automationEvent())),
  }))
  const text = invoked.Payload ? Buffer.from(invoked.Payload).toString('utf-8') : '{}'
  const parsed: unknown = text ? JSON.parse(text) : {}
  if (invoked.FunctionError) {
    // Throw so the schedule's retry and CloudWatch error metrics see the failure.
    const detail = parsed && typeof parsed === 'object' && 'errorMessage' in parsed
      ? String((parsed as { errorMessage: unknown }).errorMessage)
      : text
    throw new Error(`tracking-automation: tmsTrackingActions failed: ${detail}`)
  }
  console.log('[tracking-automation] sweep result', JSON.stringify(parsed))
  return parsed
}
