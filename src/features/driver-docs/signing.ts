// Public document-signing client — talks to the same onboarding-portal-api Function URL
// as the driver portal, but with the signGet/signSubmit actions (own token type).
import { portal } from '@/features/driver-portal/portalApi'
import type { ICStatusValues } from '@/lib/driverDocs'

export interface SignatureRequestState {
  status: 'OPENED' | 'SIGNED' | 'VOIDED'
  driverName: string
  documentType: string
  documentTitle: string
  valuesJson: ICStatusValues | null
}

export async function getSignatureRequest(token: string): Promise<SignatureRequestState> {
  return portal<SignatureRequestState>(token, 'signGet')
}

export async function submitSignature(
  token: string, values: ICStatusValues, pdfBase64: string,
): Promise<{ ok: boolean; status: string }> {
  return portal<{ ok: boolean; status: string }>(token, 'signSubmit', { valuesJson: values, pdfBase64 })
}

/** Absolute URL a driver opens to sign. */
export function signingUrl(token: string): string {
  return `${window.location.origin}/sign/${token}`
}
