/**
 * Which selected bills can go in a Chase ACH file, and which cannot, and why.
 *
 * Pure. The bank numbers come in through `BankDetails`, which the caller reads from wherever the
 * company decides full numbers live; nothing here stores, logs or returns them. The preview side
 * of a row carries the last four only.
 */
import { effectiveBillPayee } from '../../../src/lib/carrierBill'
import type { CarrierBillRecord, CarrierPaymentMethodRecord, CarrierRecord } from '../../../src/types/tms'
import { isValidRoutingNumber, type NachaAccountType, type NachaEntry } from '../_shared/nacha'

export interface BankDetails {
  routingNumber: string
  accountNumber: string
  accountType?: NachaAccountType | null
}

export type AchRowOutcome =
  | { status: 'READY'; billId: string; entry: NachaEntry; preview: AchPreviewRow; warnings: string[] }
  | { status: 'SKIPPED' | 'BLOCKED'; billId: string; reason: string; preview: AchPreviewRow }

/** Everything the screen may show: never a full routing or account number. */
export interface AchPreviewRow {
  billId: string
  pro: string
  payeeName: string
  payeeKind: 'CARRIER' | 'FACTOR'
  method: string
  last4: string | null
  amountCents: number
  alreadyExportedAt: string | null
}

type BillInput = Pick<
  CarrierBillRecord,
  'id' | 'status' | 'balanceCents' | 'shipmentNumber' | 'payeeKind' | 'paymentMethodId' | 'remitTo' | 'carrierName'
> & { achExportedAt?: string | null }

/** The PRO without a leg suffix: what the carrier sees in a remittance and what reconciles in the bank. */
export function basePro(shipmentNumber: string | null | undefined): string {
  return String(shipmentNumber ?? '').split('-')[0].replace(/[^0-9A-Za-z]/g, '')
}

export function classifyAchBill(
  bill: BillInput,
  carrier: Parameters<typeof effectiveBillPayee>[1],
  methods: readonly CarrierPaymentMethodRecord[],
  details: BankDetails | null,
): AchRowOutcome {
  const { payee } = effectiveBillPayee(bill, carrier as Pick<CarrierRecord, 'name' | 'address' | 'email' | 'factorPaymentMethodId'> | null, methods)
  const method = methods.find((item) => item.id === payee.paymentMethodId) ?? null
  const base: AchPreviewRow = {
    billId: bill.id,
    pro: basePro(bill.shipmentNumber),
    payeeName: payee.remitTo?.name ?? bill.carrierName ?? 'Unknown payee',
    payeeKind: payee.kind,
    method: method?.method ?? payee.remitTo?.method ?? 'NONE',
    last4: method?.accountLast4 ?? null,
    amountCents: Math.max(0, Math.trunc(bill.balanceCents ?? 0)),
    alreadyExportedAt: bill.achExportedAt ?? null,
  }
  const skip = (reason: string): AchRowOutcome => ({ status: 'SKIPPED', billId: bill.id, reason, preview: base })
  const block = (reason: string): AchRowOutcome => ({ status: 'BLOCKED', billId: bill.id, reason, preview: base })

  if (bill.status !== 'TO_BE_PAID' && bill.status !== 'PARTIAL') return skip('The bill is not approved for payment')
  if (!payee.remitTo || !method) return block('No pay-to is set for this bill')
  if (method.method !== 'ACH') return skip(`Paid by ${method.method.toLowerCase().replace('_', ' ')}, not ACH`)
  if (method.status === 'INACTIVE') return block('The ACH method on the carrier is inactive')
  if (base.amountCents <= 0) return block('Nothing is owed on this bill')
  if (base.amountCents > 9_999_999_999) return block('The amount is too large for an ACH file')
  if (!details) return block(`No bank details are available for the ACH method${base.last4 ? ` ending ${base.last4}` : ''}`)
  if (!isValidRoutingNumber(details.routingNumber)) return block('The routing number is not a valid 9-digit ABA number')
  if (!/^[0-9A-Za-z]{4,17}$/.test(details.accountNumber)) return block('The account number is missing or not 4 to 17 characters')
  const pro = base.pro
  if (!pro) return block('The bill has no PRO number to reference in the file')

  const warnings: string[] = []
  if (!details.accountType) warnings.push('Account type was not recorded; filed as checking')
  const accountLast4 = details.accountNumber.slice(-4)
  if (base.last4 && base.last4 !== accountLast4) {
    return block(`The bank details do not match the account ending ${base.last4} on the carrier`)
  }
  return {
    status: 'READY',
    billId: bill.id,
    entry: {
      key: bill.id,
      routingNumber: details.routingNumber,
      accountNumber: details.accountNumber,
      accountType: details.accountType === 'SAVINGS' ? 'SAVINGS' : 'CHECKING',
      amountCents: base.amountCents,
      identification: pro,
      name: base.payeeName,
      addenda: `BCAT PRO ${pro}`,
    },
    preview: { ...base, last4: accountLast4 },
    warnings,
  }
}
