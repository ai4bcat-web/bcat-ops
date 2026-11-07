/**
 * The ONLY tax-ID-shaped values allowed anywhere in src/, amplify/ and scripts/ (see
 * src/lib/taxIdLeak.test.ts). Every one is IRS-impossible: an EIN prefix of 00/07/08/09, an SSN area
 * of 000, 666 or 9xx, so none can ever be a real taxpayer's number. A test or fixture that needs a
 * tax ID imports from here; nothing else may hold a 9-digit tax-looking literal.
 */
export const SYNTHETIC_EINS: string[] = ['00-0000001', '00-0000002', '07-0000003', '08-0000004', '09-0000005', '00-0000006', '00-0000007']
export const SYNTHETIC_SSNS: string[] = ['000-12-3456', '666-12-3456', '900-12-3456', '000-45-6789', '666-45-6789', '950-12-3456']

export const SYNTHETIC_TAX_IDS: string[] = [...SYNTHETIC_EINS, ...SYNTHETIC_SSNS]

/** The same values with the punctuation stripped, as the Lambda normalises them. */
export const SYNTHETIC_TAX_ID_DIGITS: string[] = SYNTHETIC_TAX_IDS.map((v) => v.replace(/\D/g, ''))

/** Every spelling the scanner accepts. */
export const SYNTHETIC_ALLOWLIST: ReadonlySet<string> = new Set([...SYNTHETIC_TAX_IDS, ...SYNTHETIC_TAX_ID_DIGITS])

export const SYNTHETIC_EIN = SYNTHETIC_EINS[0]!
export const SYNTHETIC_EIN_2 = SYNTHETIC_EINS[1]!
export const SYNTHETIC_SSN = SYNTHETIC_SSNS[0]!
