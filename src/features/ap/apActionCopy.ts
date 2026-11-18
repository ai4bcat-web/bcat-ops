/**
 * What the Payable buttons are called and what each one does (Ryne 2026-11-18: "make it more clear what pay,
 * remove, and unapprove all mean"). One place so the toolbar, the row buttons, the bill page and the
 * "What do these do?" list never disagree. Words only: nothing here changes what a button does.
 *
 * What is true underneath, so the wording stays honest:
 *  - BCAT Ops never moves money. Record payment writes down a payment the team already made.
 *  - Posting a payment marks the bills Paid and, once, e-mails remittance to the payee's remit e-mail
 *    (nothing is sent when the payee has none, or when automatic remittance is turned off).
 *  - Aging holds approved bills that are not on the pay run, plus bills still in review. Selected is the pay run.
 */
export const AP_ACTION_COPY = {
  moveToSelected: {
    label: 'Move to Selected',
    hint: 'Moves the ticked, approved bills onto the Selected tab, the list you pay from. Nothing is paid yet.',
  },
  backToAging: {
    label: 'Back to Aging',
    hint: 'Takes the bill off the Selected tab. It stays approved and unpaid and goes back to Aging. Nothing is deleted or unapproved.',
  },
  recordPayment: {
    label: 'Record payment',
    hint: 'Opens the payment form. Pay the carrier first (ACH, check, etc.), then post it here: the bills are marked Paid and remittance is e-mailed to the payee. BCAT Ops does not send money.',
  },
  sendBackToReview: {
    label: 'Send back to review',
    hint: 'Takes an approved bill back to In review. It leaves the pay run and has to be approved again before it can be paid. Not allowed once any payment is applied.',
  },
} as const

/** The Aging tab's gates column (Ryne 2026-11-18): same data, a header that says what it is. */
export const GATES_HEADER = "WHAT'S BLOCKING APPROVAL"
export const GATES_HELP =
  "Only for bills In review. Red = must be fixed before the bill can be approved (e.g. missing POD, signed rate con or carrier invoice). Gray = a warning to check; it does not stop approval. 'Nothing — ready to approve' means nothing is blocking it."

/** The list behind the "What do these do?" button: only the buttons the tab being looked at actually has. */
export function apActionHelpRows(mode: 'aging' | 'selected'): readonly { label: string; text: string }[] {
  const sendBack = {
    label: AP_ACTION_COPY.sendBackToReview.label,
    text: 'Undoes an approval. The bill goes back to In review and needs approving again. Not allowed once money has been applied to it.',
  }
  if (mode === 'aging') {
    return [
      {
        label: AP_ACTION_COPY.moveToSelected.label,
        text: 'Moves the ticked, approved bills onto the Selected tab, the list you pay from. Nothing is paid yet.',
      },
      {
        label: AP_ACTION_COPY.recordPayment.label,
        text: 'Use it after you have paid the carrier. It marks the bill Paid and e-mails remittance to the payee. It does not send any money.',
      },
      sendBack,
      {
        label: "What's blocking approval",
        text: 'The last column, for bills In review. Red must be fixed before the bill can be approved. Gray is a warning and does not stop approval.',
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
    sendBack,
  ]
}
