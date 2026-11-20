/**
 * What the Payable buttons are called and what each one does (Ryne 2026-11-18: "make it more clear what pay,
 * remove, and unapprove all mean"). One place so the toolbar, the row buttons, the bill page and the
 * "What do these do?" list never disagree. Words only: nothing here changes what a button does.
 *
 * What is true underneath, so the wording stays honest:
 *  - BCAT Ops never moves money. Record payment writes down a payment the team already made.
 *  - Posting a payment marks the bills Paid and, once, e-mails remittance to the payee's remit e-mail
 *    (nothing is sent when the payee has none, or when automatic remittance is turned off).
 *  - Aging holds the bills that have their invoice date and are not on the pay run. Selected is the pay run. There is no review step: a dated bill is reviewed.
 */
export const AP_ACTION_COPY = {
  moveToSelected: {
    label: 'Move to Selected',
    hint: 'Moves the ticked bills onto the Selected tab, the list you pay from. Nothing is paid yet.',
  },
  backToAging: {
    label: 'Back to Aging',
    hint: 'Takes the bill off the Selected tab. It stays approved and unpaid and goes back to Aging. Nothing is deleted or unapproved.',
  },
  recordPayment: {
    label: 'Record payment',
    hint: 'Opens the payment form. Pay the carrier first (ACH, check, etc.), then post it here: the bills are marked Paid and remittance is e-mailed to the payee. BCAT Ops does not send money.',
  },
} as const

/** The list behind the "What do these do?" button: only the buttons the tab being looked at actually has. */
export function apActionHelpRows(mode: 'aging' | 'selected'): readonly { label: string; text: string }[] {
  if (mode === 'aging') {
    return [
      {
        label: AP_ACTION_COPY.moveToSelected.label,
        text: 'Moves the ticked bills onto the Selected tab, the list you pay from. Nothing is paid yet.',
      },
      {
        label: AP_ACTION_COPY.recordPayment.label,
        text: 'Use it after you have paid the carrier. It marks the bill Paid and e-mails remittance to the payee. It does not send any money.',
      },
    ]
  }
  return [
    {
      label: AP_ACTION_COPY.recordPayment.label,
      text: 'Use it after you have paid the carrier. It marks the bills Paid and e-mails remittance to the payee. It does not send any money.',
    },
    {
      label: AP_ACTION_COPY.backToAging.label,
      text: 'Takes bills off the Selected tab, back to Aging. They stay approved and unpaid. Nothing is deleted.',
    },
  ]
}
