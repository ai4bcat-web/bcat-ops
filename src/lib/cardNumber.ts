/** 13+ digits in a free-text field (spaces and dashes ignored) reads as a full card number. */
export function looksLikeCardNumber(value: string): boolean {
  return /\d{13,}/.test(value.replace(/[\s-]/g, ''))
}
