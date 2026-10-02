/**
 * Turn whatever was thrown into something a person can read and report.
 *
 * `String(err)` on anything that is not an Error gives "[object Object]", and that is what
 * the owner-operator settlements showed when its data load failed — a red box containing
 * no information at all, on the page someone was using to work out why nobody was being
 * paid. AppSync rejects with a plain object carrying an `errors` array, so the one shape
 * that matters most was the one that printed worst.
 *
 * Never returns an empty string: a blank error box is the same problem wearing different
 * clothes.
 */
export function errorText(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof Error && err.message) return err.message

  // AppSync / Amplify: { errors: [{ message }] }
  const errors = (err as { errors?: { message?: string }[] } | null | undefined)?.errors
  if (Array.isArray(errors) && errors.length > 0) {
    const joined = errors.map((e) => e?.message).filter(Boolean).join('; ')
    if (joined) return joined
  }

  // A plain `message` on a non-Error, which several SDKs throw.
  const message = (err as { message?: unknown } | null | undefined)?.message
  if (typeof message === 'string' && message.trim()) return message

  if (typeof err === 'string' && err.trim()) return err

  // Last resort: anything concrete beats "[object Object]". Someone can read this out.
  try {
    const serialised = JSON.stringify(err)
    if (serialised && serialised !== '{}' && serialised !== 'null') return serialised.slice(0, 300)
  } catch {
    // Circular or otherwise unserialisable — fall through to the fallback.
  }
  return fallback
}
