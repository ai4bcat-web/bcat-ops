/**
 * Money helpers for TMS migration scripts.
 * All money is integer cents internally; decimal strings are used at boundaries so
 * scripts never pass floats for money.
 */

const MONEY_RE = /^-?\d+\.\d{2}$/;

/**
 * Convert an integer cents value to a fixed two-decimal decimal string.
 * @param {number | bigint | string | null | undefined} cents
 * @returns {string}
 */
export function centsToDecimal(cents) {
  if (cents === null || cents === undefined || cents === '') return '';
  const whole = typeof cents === 'bigint' ? cents.toString() : String(cents);
  const isNegative = whole.startsWith('-');
  const abs = isNegative ? whole.slice(1) : whole;
  const padded = abs.padStart(3, '0');
  const decimal = `${padded.slice(0, -2)}.${padded.slice(-2)}`;
  return isNegative ? `-${decimal}` : decimal;
}

/**
 * Convert a decimal money string (e.g. "123.45") to integer cents.
 * Rejects floats; input must be a string with exactly two decimals.
 * @param {string | number | null | undefined} decimal
 * @returns {number}
 */
export function decimalToCents(decimal) {
  if (decimal === null || decimal === undefined || decimal === '') return 0;
  if (typeof decimal !== 'string') {
    throw new Error(`Invalid money decimal string: ${JSON.stringify(decimal)} (use a string with exactly two decimals)`);
  }
  const str = decimal.trim();
  if (!MONEY_RE.test(str)) {
    throw new Error(`Invalid money decimal string: ${JSON.stringify(str)} (use "123.45")`);
  }
  const [dollars, centsStr] = str.split('.');
  const sign = dollars.startsWith('-') ? -1 : 1;
  const absDollars = sign === -1 ? dollars.slice(1) : dollars;
  return sign * (Number(absDollars) * 100 + Number(centsStr));
}

/**
 * Format cents as a US dollar display string.
 * @param {number | bigint | string} cents
 * @returns {string}
 */
export function formatMoney(cents) {
  return `$${centsToDecimal(cents)}`;
}

/**
 * Parse a dollar display string back to cents.
 * @param {string} s
 * @returns {number}
 */
export function moneyToCents(s) {
  return decimalToCents(String(s).replace(/^\$/, '').trim());
}
