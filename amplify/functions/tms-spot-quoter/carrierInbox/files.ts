/**
 * Step AL — the listener's only door to the books: `FILE_INBOUND_OFFER` on tms-shipment-actions,
 * invoked as the `carrier-inbox` system caller. The router only accepts that one action from
 * this caller, never as an admin; the spot role holds no write on Quote/Shipment/ShipmentMessage.
 *
 * Idempotent by construction (the router keys the message row on `sourceKey`), so a replay
 * after a crash or a throttled invoke can never file twice.
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import {
  CARRIER_INBOX_SYSTEM_CALLER,
  type FileInboundOfferInput,
  type FileInboundOfferResult,
} from '../../../../src/lib/carrierInbox/types'
import type { FilingRules } from './pipeline'

export interface CarrierInboxFiles {
  fileInboundOffer(input: FileInboundOfferInput & Partial<FilingRules>): Promise<FileInboundOfferResult>
}

export const FILE_ACTION = 'FILE_INBOUND_OFFER'

/** The exact event the router receives. */
export function fileEvent(input: FileInboundOfferInput & Partial<FilingRules>): { arguments: { action: string; input: string }; systemCaller: string } {
  return {
    arguments: { action: FILE_ACTION, input: JSON.stringify(input) },
    systemCaller: CARRIER_INBOX_SYSTEM_CALLER,
  }
}

export function createLambdaFiles(
  lambda: Pick<LambdaClient, 'send'> = new LambdaClient({}),
  functionName: () => string = () => process.env.SHIPMENT_ACTIONS_FUNCTION_NAME ?? '',
): CarrierInboxFiles {
  return {
    async fileInboundOffer(input) {
      const name = functionName()
      if (!name) throw new Error('SHIPMENT_ACTIONS_FUNCTION_NAME is not set')
      const invoked = await lambda.send(new InvokeCommand({
        FunctionName: name,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(fileEvent(input))),
      }))
      const text = invoked.Payload ? Buffer.from(invoked.Payload).toString('utf-8') : ''
      let parsed: unknown
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = null
      }
      if (invoked.FunctionError) {
        const detail = parsed && typeof parsed === 'object' && 'errorMessage' in parsed
          ? String((parsed as { errorMessage: unknown }).errorMessage)
          : 'router error'
        throw new Error(`FILE_INBOUND_OFFER failed: ${detail.slice(0, 200)}`)
      }
      if (!parsed || typeof parsed !== 'object' || typeof (parsed as { outcome?: unknown }).outcome !== 'string') {
        throw new Error('FILE_INBOUND_OFFER returned no outcome')
      }
      return parsed as FileInboundOfferResult
    },
  }
}
